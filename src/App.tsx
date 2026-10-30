import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { blobToBase64, understandTask } from "./aiTaskUnderstanding";
import type { AiUnderstandingRequest } from "./aiTaskUnderstanding";
import { emptyTask, getTaskClarification, parseTaskInstructions, USERS } from "./taskParser";
import type { ParsedTask, Recurrence, User } from "./taskParser";
import { validateTaskForExecution, verifyTaskForm } from "./taskFormExecution";

interface CreatedTask extends ParsedTask {
  id: number;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const preferredAudioTypes = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
const maximumRecordingBytes = 9 * 1024 * 1024;
const maximumRecordingMilliseconds = 45_000;
const speechSilenceMilliseconds = 1_200;

function chooseAudioType(): string {
  if (typeof MediaRecorder.isTypeSupported !== "function") return "";
  return preferredAudioTypes.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Microphone access was denied. Allow it in your browser settings, or type your instruction.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "No microphone was found. Connect a microphone or type your instruction.";
  }
  if (error instanceof Error) return `Could not start recording: ${error.message}`;
  return "Could not start recording. You can type your instruction instead.";
}

function UserPicker({
  label,
  value,
  onChange,
  optional = false,
  invalid = false,
  allowCustom = false,
}: {
  label: string;
  value: User;
  onChange: (user: User) => void;
  optional?: boolean;
  invalid?: boolean;
  allowCustom?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const displayValue = value || query;
  const filtered = USERS.filter((user) => user.toLowerCase().includes(displayValue.toLowerCase()));

  useEffect(() => {
    setQuery(value);
  }, [value]);

  function updateQuery(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value;
    setQuery(next);
    setOpen(true);
    if (allowCustom) onChange(next.trim());
    else if (value && next !== value) onChange("");
  }

  return (
    <div className={`field user-picker ${invalid ? "has-error" : ""}`}>
      <label htmlFor={optional ? "reviewer-picker" : "assigned-to-picker"}>{label}{optional && <span className="optional">Optional</span>}</label>
      <div className="picker-input-wrap">
        <input
          id={optional ? "reviewer-picker" : "assigned-to-picker"}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${label}-options`}
          aria-autocomplete="list"
          autoComplete="off"
          placeholder={optional ? "Select a reviewer" : "Search team members"}
          value={displayValue}
          onChange={updateQuery}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
            if (event.key === "Enter" && (filtered.length === 1 || allowCustom && query.trim())) {
              const nextValue = filtered.length === 1 ? filtered[0] : query.trim();
              onChange(nextValue);
              setQuery(nextValue);
              setOpen(false);
            }
          }}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        />
        {displayValue && <button className="clear-picker" type="button" aria-label={`Clear ${label}`} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(""); setQuery(""); setOpen(true); }}>×</button>}
        {open && (
          <div className="picker-options" id={`${label}-options`} role="listbox" aria-label={`${label} options`}>
            {optional && <button type="button" role="option" aria-selected={!value} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(""); setQuery(""); setOpen(false); }}>No reviewer</button>}
            {filtered.map((user) => (
              <button key={user} type="button" role="option" aria-selected={value === user} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(user); setQuery(user); setOpen(false); }}>
                <span className="avatar">{user.slice(0, 1)}</span>{user}<span className="option-check">{value === user ? "✓" : ""}</span>
              </button>
            ))}
            {!filtered.length && !allowCustom && <span className="no-match">No matching team member</span>}
            {allowCustom && query.trim() && !USERS.some((user) => user.toLowerCase() === query.trim().toLowerCase()) && (
              <button type="button" role="option" aria-selected={value === query.trim()} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(query.trim()); setOpen(false); }}>
                Use “{query.trim()}”
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [isOpen, setIsOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [form, setForm] = useState<ParsedTask>(emptyTask);
  const [tasks, setTasks] = useState<CreatedTask[]>([]);
  const [status, setStatus] = useState<{ kind: "success" | "error" | "info"; message: string } | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [googleConsent, setGoogleConsent] = useState(false);
  const [pendingVerification, setPendingVerification] = useState<{ task: ParsedTask; ambiguities: string[] } | null>(null);
  const [clarificationContext, setClarificationContext] = useState<{ task: ParsedTask; ambiguities: string[] } | null>(null);
  const [recognitionLanguage, setRecognitionLanguage] = useState("en-IN");
  const formRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recognizedTranscriptRef = useRef("");
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const processRecordingOnStopRef = useRef(false);
  const recordingTimeoutRef = useRef<number | null>(null);
  const speechSilenceTimeoutRef = useRef<number | null>(null);
  const recordingAttemptRef = useRef(0);
  const submitLockRef = useRef(false);
  const processingLockRef = useRef(false);

  useEffect(() => () => {
    processRecordingOnStopRef.current = false;
    if (recordingTimeoutRef.current !== null) window.clearTimeout(recordingTimeoutRef.current);
    if (speechSilenceTimeoutRef.current !== null) window.clearTimeout(speechSilenceTimeoutRef.current);
    speechRecognitionRef.current?.stop();
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  function openComposer() {
    submitLockRef.current = false;
    setIsOpen(true);
    setStatus(null);
  }

  function closeComposer() {
    recordingAttemptRef.current += 1;
    processRecordingOnStopRef.current = false;
    if (recordingTimeoutRef.current !== null) window.clearTimeout(recordingTimeoutRef.current);
    if (speechSilenceTimeoutRef.current !== null) window.clearTimeout(speechSilenceTimeoutRef.current);
    speechRecognitionRef.current?.stop();
    speechRecognitionRef.current = null;
    recognizedTranscriptRef.current = "";
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    setIsRecording(false);
    setIsOpen(false);
  }

  function applyAiResult(transcript: string, result: Awaited<ReturnType<typeof understandTask>>) {
    setInstructions(transcript);

    // If Gemini says this is not a task-related command at all, do not change the form.
    if (!result.isTaskCommand && !clarificationContext) {
      setPendingVerification(null);
      setStatus({ kind: "info", message: "I couldn't identify a task-related instruction. Please describe what you want to create or update." });
      return;
    }

    // The server already merged Gemini's changes onto the currentTask baseline.
    // We do an additional client-side safety merge to ensure no field accidentally
    // becomes undefined (e.g. if an old cached form state is stale).
    setForm((current) => {
      const merged = { ...current, ...result.task };
      // Keep existing non-empty values if server returned empty for a field
      // (defence against edge-case schema mismatch).
      return {
        assignee:  result.task.assignee  || current.assignee,
        date:      result.task.date      || current.date,
        time:      result.task.time      || current.time,
        subject:   result.task.subject   || current.subject,
        reviewer:  result.task.reviewer  !== undefined ? result.task.reviewer : current.reviewer,
        recurring: merged.recurring,
        frequency: merged.frequency,
        startTask: merged.startTask,
      };
    });

    // Surface Gemini's clarification question if provided.
    if (result.needsClarification && result.clarificationQuestion) {
      setPendingVerification({ task: result.task, ambiguities: result.ambiguities });
      setStatus({ kind: "info", message: result.clarificationQuestion });
      return;
    }

    setPendingVerification({ task: result.task, ambiguities: result.ambiguities });
  }

  function mergeLocalFallback(localTask: ParsedTask) {
    setForm((current) => ({
      assignee: current.assignee || localTask.assignee,
      date: current.date || localTask.date,
      time: current.time || localTask.time,
      subject: current.subject || localTask.subject,
      reviewer: current.reviewer || localTask.reviewer,
      recurring: current.recurring || localTask.recurring,
      frequency: localTask.recurring ? localTask.frequency : current.frequency,
      startTask: current.startTask || localTask.startTask,
    }));
  }

  async function processWithAi(request: AiUnderstandingRequest, localFallback?: ParsedTask) {
    if (processingLockRef.current) return;
    processingLockRef.current = true;
    setIsProcessing(true);
    setStatus({
      kind: "info",
      message: request.audioBase64
        ? "Sending your recording to Gemini for transcription and task understanding…"
        : "Sending your instruction to Gemini for task understanding…",
    });
    try {
      const response = await understandTask(request);
      applyAiResult(response.transcript, response);
    } catch (error) {
      if (localFallback) mergeLocalFallback(localFallback);
      else setPendingVerification(null);
      const message = error instanceof Error ? error.message : "AI task understanding failed. Try again or edit the fields manually.";
      setStatus({
        kind: localFallback ? "info" : "error",
        message: localFallback
          ? `Gemini could not complete the request. I filled in the task details I could recognize; please review them. ${message}`
          : message,
      });
    } finally {
      processingLockRef.current = false;
      setIsProcessing(false);
    }
  }

  async function processInstructions(transcript = instructions) {
    const text = transcript.trim();
    if (!text) {
      setStatus({ kind: "error", message: "Type or record an instruction first." });
      return;
    }
    if (!googleConsent) {
      setStatus({ kind: "info", message: "Please confirm the Google Gemini data-use notice before sending this instruction." });
      return;
    }
    const localResult = parseTaskInstructions(text);
    await processWithAi({
      text,
      language: recognitionLanguage,
      currentTask: form,
      clarificationContext: clarificationContext ?? undefined,
    }, localResult.isTaskCommand ? localResult.task : undefined);
  }

  useEffect(() => {
    if (!pendingVerification || !formRef.current) return;
    const { task, ambiguities } = pendingVerification;
    const missing = validateTaskForExecution(task);
    const clarification = getTaskClarification(task, ambiguities);
    if (missing.length || clarification) {
      setFieldErrors([...missing, ...ambiguities]);
      setClarificationContext({
        task,
        ambiguities: [...new Set([...ambiguities, ...missing.map((field) => field === "assigned user" ? "assignee" : field)])],
      });
      setStatus({
        kind: "info",
        message: `Execution paused for clarification. ${clarification || missing.join(", ")}`,
      });
      setPendingVerification(null);
      return;
    }

    const result = verifyTaskForm(formRef.current, task);
    setFieldErrors(result.failedFields);
    setClarificationContext(null);
    if (result.verified) {
      addTask(task);
      return;
    }
    setStatus({ kind: "error", message: `Form verification failed for: ${result.failedFields.join(", ")}. Correct the fields before proceeding.` });
    setPendingVerification(null);
  }, [form, pendingVerification]);

  async function processRecording(blob: Blob) {
    if (!blob.size) {
      setStatus({ kind: "error", message: "No audio was recorded. Try again or type your instruction." });
      return;
    }
    if (blob.size > maximumRecordingBytes) {
      setStatus({ kind: "error", message: "That recording is too large. Keep voice instructions under 45 seconds and try again." });
      return;
    }
    if (!googleConsent) {
      setStatus({ kind: "info", message: "Please confirm the Google Gemini data-use notice before recording and sending audio." });
      return;
    }
    try {
      const audioBase64 = await blobToBase64(blob);
      await processWithAi({
        audioBase64,
        mimeType: blob.type || "audio/webm",
        language: recognitionLanguage,
        currentTask: form,
        clarificationContext: clarificationContext ?? undefined,
      });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "Could not process the recording. Try again or type your instruction." });
    }
  }

  function stopRecording() {
    processRecordingOnStopRef.current = true;
    if (recordingTimeoutRef.current !== null) window.clearTimeout(recordingTimeoutRef.current);
    if (speechSilenceTimeoutRef.current !== null) window.clearTimeout(speechSilenceTimeoutRef.current);
    setStatus({ kind: "info", message: "Finishing transcription and processing your instruction…" });
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    setIsRecording(false);
  }

  async function toggleRecording() {
    if (isRecording) {
      stopRecording();
      return;
    }
    if (!googleConsent) {
      setStatus({ kind: "info", message: "Please confirm the Google Gemini data-use notice before recording." });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setStatus({ kind: "error", message: "Audio recording is not supported in this browser. You can type the instruction instead." });
      return;
    }
    try {
      const attempt = ++recordingAttemptRef.current;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (attempt !== recordingAttemptRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = chooseAudioType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const recognitionConstructor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      const recognition = recognitionConstructor ? new recognitionConstructor() : null;
      recorderRef.current = recorder;
      speechRecognitionRef.current = recognition;
      audioChunksRef.current = [];
      recognizedTranscriptRef.current = "";
      let recognitionStarted = false;
      setInstructions("");
      processRecordingOnStopRef.current = true;
      if (recognition) {
        recognition.lang = recognitionLanguage;
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.onresult = (event) => {
          const transcript = Array.from(event.results, (result) => result[0]?.transcript ?? "").join("").trim();
          recognizedTranscriptRef.current = transcript;
          setInstructions(transcript);
          if (speechSilenceTimeoutRef.current !== null) window.clearTimeout(speechSilenceTimeoutRef.current);
          speechSilenceTimeoutRef.current = window.setTimeout(() => {
            if (recorderRef.current?.state === "recording" && recognizedTranscriptRef.current) stopRecording();
          }, speechSilenceMilliseconds);
        };
        recognition.onspeechend = () => {
          if (recorderRef.current?.state === "recording" && recognizedTranscriptRef.current) stopRecording();
        };
        recognition.onend = () => {
          if (recorderRef.current?.state === "recording" && speechRecognitionRef.current === recognition) {
            speechRecognitionRef.current = null;
          }
        };
        recognition.onerror = () => {
          setStatus({ kind: "info", message: "Live transcription stopped; the captured instruction will still be processed when you stop." });
        };
      }
      recorder.ondataavailable = (event) => {
        if (event.data.size) audioChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        processRecordingOnStopRef.current = false;
        speechRecognitionRef.current?.stop();
        speechRecognitionRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setIsRecording(false);
        setStatus({ kind: "error", message: "Audio recording failed. Check microphone access or type your instruction." });
      };
      recorder.onstop = () => {
        if (recordingTimeoutRef.current !== null) window.clearTimeout(recordingTimeoutRef.current);
        recorderRef.current = null;
        setIsRecording(false);
        const shouldProcess = processRecordingOnStopRef.current;
        processRecordingOnStopRef.current = false;
        const audio = new Blob(audioChunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        audioChunksRef.current = [];
        const releaseStream = () => {
          stream.getTracks().forEach((track) => track.stop());
          if (streamRef.current === stream) streamRef.current = null;
        };
        if (!shouldProcess) {
          releaseStream();
          return;
        }

        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          if (recordingTimeoutRef.current !== null) window.clearTimeout(recordingTimeoutRef.current);
          releaseStream();
          const transcript = recognizedTranscriptRef.current.trim();
          recognizedTranscriptRef.current = "";
          speechRecognitionRef.current = null;
          if (attempt !== recordingAttemptRef.current) return;
          if (transcript) void processInstructions(transcript);
          else void processRecording(audio);
        };
        if (recognition && recognitionStarted && speechRecognitionRef.current === recognition) {
          recognition.onend = finish;
          recordingTimeoutRef.current = window.setTimeout(finish, 600);
          try {
            recognition.stop();
          } catch {
            finish();
          }
        } else {
          finish();
        }
      };
      recorder.start();
      if (recognition) {
        try {
          recognition.start();
          recognitionStarted = true;
        } catch {
          speechRecognitionRef.current = null;
        }
      }
      setIsRecording(true);
      setStatus({
        kind: "info",
        message: recognition
          ? "Recording… your words will appear here. Pause when you’re done to process automatically."
          : "Recording… speak your instruction, then press stop to send it to Gemini.",
      });
      recordingTimeoutRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") {
          stopRecording();
        }
      }, maximumRecordingMilliseconds);
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setIsRecording(false);
      setStatus({ kind: "error", message: microphoneErrorMessage(error) });
    }
  }

  function updateForm<K extends keyof ParsedTask>(key: K, value: ParsedTask[K]) {
    setPendingVerification(null);
    setForm((current) => ({ ...current, [key]: value }));
    setClarificationContext((current) => {
      if (!current) return null;
      const ambiguities = current.ambiguities.filter((item) => item !== key && !(key === "assignee" && item === "assigned user"));
      return ambiguities.length ? { task: { ...current.task, [key]: value }, ambiguities } : null;
    });
    setFieldErrors([]);
    setStatus({ kind: "info", message: "Task details edited. Review the current values before submitting manually." });
  }

  function addTask(task: ParsedTask) {
    if (submitLockRef.current) return;
    const invalid = validateTaskForExecution(task);
    if (invalid.length) {
      setFieldErrors(invalid);
      setStatus({ kind: "error", message: `Complete the task details before submitting: ${invalid.join(", ")}.` });
      return;
    }

    submitLockRef.current = true;
    setTasks((current) => [{ ...task, subject: task.subject.trim(), id: Date.now() }, ...current]);
    setInstructions("");
    setForm(emptyTask());
    setFieldErrors([]);
    setPendingVerification(null);
    setClarificationContext(null);
    setIsOpen(false);
    setStatus({ kind: "success", message: "Task verified and added to this session's task list." });
  }

  function submitTaskManually() {
    addTask(form);
  }

  function formatDate(value: string) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeZone: "Asia/Kolkata",
    }).format(new Date(`${value}T12:00:00+05:30`));
  }

  function formatTime(value: string) {
    if (!value) return "—";
    const date = new Date(`1970-01-01T${value}:00Z`);
    return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC" }).format(date);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="TaskPilot home"><span className="brand-mark">T</span><span>TaskPilot</span></a>
        <span className="timezone"><span className="timezone-dot" /> Asia/Kolkata · IST</span>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow"><span className="sparkle">✦</span> YOUR PERSONAL TASK ASSISTANT</span>
          <h1>Make a plan.<br /><span>Just say the word.</span></h1>
          <p>Tell TaskPilot what needs to get done. We’ll take care of the details.</p>
        </div>
        <div className="hero-illustration" aria-hidden="true">
          <div className="illustration-orbit orbit-one" /><div className="illustration-orbit orbit-two" />
          <div className="illustration-card"><div className="illustration-card-top"><span /><span /><span /></div><div className="illustration-line long" /><div className="illustration-line medium" /><div className="illustration-check">✓</div><div className="illustration-line short" /></div>
          <div className="floating-mic">⌁</div><div className="floating-star">✦</div>
        </div>
      </section>

      <section className="tasks-section">
        <div className="section-heading">
          <div><h2>Your tasks <span className="task-count">{tasks.length}</span></h2><p>Complete tasks are added after Gemini verifies the details.</p></div>
          <button className="primary-button" type="button" onClick={openComposer}><span className="plus">+</span> Create task</button>
        </div>
        {status && !isOpen && <div className={`status-banner ${status.kind}`} role="status">{status.message}</div>}
        {tasks.length ? (
          <div className="task-list">
            {tasks.map((task) => (
              <article className="task-card" key={task.id}>
                <div className="task-card-main"><span className="task-check">✓</span><div><h3>{task.subject}</h3><div className="task-meta"><span><span className="meta-icon">◎</span>{task.assignee}</span><span><span className="meta-icon">◷</span>{formatDate(task.date)} · {formatTime(task.time)}</span></div></div></div>
                <div className="task-badges">
                  {task.reviewer && <span className="badge reviewer-badge">Reviewer: {task.reviewer}</span>}
                  {task.recurring && <span className="badge recurrence-badge">↻ {task.frequency}</span>}
                  {task.startTask && <span className="badge start-badge">▶ Start task</span>}
                  {!task.reviewer && !task.recurring && !task.startTask && <span className="badge neutral-badge">One-time task</span>}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state"><div className="empty-icon">✳</div><h3>Ready when you are</h3><p>Describe a task and Gemini will verify the details before adding it to your list.</p><button className="text-button" type="button" onClick={openComposer}>Try a voice or text command <span>→</span></button></div>
        )}
        <p className="privacy-note"><span>✦</span> Complete, verified tasks are added after you confirm the Gemini data-use notice.</p>
      </section>

      {isOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeComposer(); }}>
          <section className="composer" role="dialog" aria-modal="true" aria-labelledby="composer-title">
            <header className="composer-header"><div><span className="composer-icon">✦</span><div><h2 id="composer-title">Task details</h2><p>Say it or type it — Gemini will fill and verify the form.</p></div></div><button className="close-button" type="button" aria-label="Close" onClick={closeComposer}>×</button></header>
            <div className="composer-body">
              <label className="instruction-label" htmlFor="instructions">Your instruction</label>
              <div className="instruction-box"><textarea id="instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="e.g. Create a task for Rahul tomorrow at 3 PM. The subject is Review the project…" rows={3} /><button className={`mic-button ${isRecording ? "listening" : ""}`} type="button" aria-label={isRecording ? "Stop recording" : "Record voice instruction"} onClick={() => void toggleRecording()} disabled={isProcessing}><span>{isRecording ? "■" : "⌁"}</span></button></div>
              <div className="instruction-actions">
                <label className="language-picker">Input language
                  <select value={recognitionLanguage} onChange={(event) => setRecognitionLanguage(event.target.value)} disabled={isRecording || isProcessing}>
                    <option value="en-IN">English (India)</option><option value="en-US">English (US)</option><option value="hi-IN">Hindi (India)</option>
                  </select>
                </label>
                <span className="voice-hint">{isRecording ? "Pause when you’re done to process automatically, or press stop." : "Record up to 45 seconds or type a command."}</span>
                <button className="process-button" type="button" onClick={() => void processInstructions()} disabled={isProcessing || isRecording}>
                  {isProcessing && <span className="spinner" aria-hidden="true" />} {isProcessing ? "Processing…" : "Process instructions"} <span aria-hidden="true">→</span>
                </button>
              </div>
              <label className="ai-consent">
                <input type="checkbox" checked={googleConsent} onChange={(event) => setGoogleConsent(event.target.checked)} disabled={isRecording || isProcessing} />
                <span>I agree to send my instruction to Google Gemini for task understanding. For voice, my browser’s speech-recognition service may also process microphone audio for live transcription; if unavailable, the recording is sent to Gemini. On the free tier, Google may use submitted content to improve its products. <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noreferrer">Free-tier terms</a></span>
              </label>
              <p className="speech-privacy-note">Live speech recognition may process microphone audio through your browser’s speech service; the recognized text is sent to Gemini for task understanding. If live recognition is unavailable, the recording is sent to Gemini for transcription. This app does not save audio, and your Gemini API key stays on the server.</p>
              {status && <div className={`status-banner composer-status ${status.kind}`} role="status">{status.message}</div>}

              <div className="form-divider"><span>REVIEW TASK DETAILS</span></div>
              <div className="form-grid" ref={formRef}>
                <UserPicker label="Assigned to" value={form.assignee} allowCustom invalid={fieldErrors.includes("assigned user") || fieldErrors.includes("assignee")} onChange={(value) => updateForm("assignee", value)} />
                <div className={`field ${fieldErrors.includes("date") ? "has-error" : ""}`}><label htmlFor="task-date">Date</label><input id="task-date" type="date" value={form.date} onChange={(event) => updateForm("date", event.target.value)} /></div>
                <div className={`field ${fieldErrors.includes("time") ? "has-error" : ""}`}><label htmlFor="task-time">Time <span className="timezone-label">IST</span></label><input id="task-time" type="time" value={form.time} onChange={(event) => updateForm("time", event.target.value)} /></div>
                <div className={`field full-width ${fieldErrors.includes("subject") ? "has-error" : ""}`}><label htmlFor="task-subject">Subject</label><input id="task-subject" type="text" placeholder="What needs to be done?" value={form.subject} onChange={(event) => updateForm("subject", event.target.value)} /></div>
                <UserPicker label="Reviewer" value={form.reviewer} optional invalid={fieldErrors.includes("reviewer")} onChange={(value) => updateForm("reviewer", value)} />
                <div className="field recurring-control"><label htmlFor="recurring-task">Recurring task</label><button id="recurring-task" type="button" role="switch" aria-checked={form.recurring} className={`toggle ${form.recurring ? "on" : ""}`} onClick={() => updateForm("recurring", !form.recurring)}><span /></button></div>
                {form.recurring && <div className="field"><label htmlFor="frequency">Repeat</label><select id="frequency" value={form.frequency} onChange={(event) => updateForm("frequency", event.target.value as Recurrence)}><option>Daily</option><option>Weekly</option><option>Monthly</option></select></div>}
                <div className="field start-control"><label htmlFor="start-task">Start task now</label><button id="start-task" type="button" role="switch" aria-checked={form.startTask} className={`toggle ${form.startTask ? "on" : ""}`} onClick={() => updateForm("startTask", !form.startTask)}><span /></button></div>
              </div>
            </div>
            <footer className="composer-footer"><span>Complete tasks are added after verification</span><div><button type="button" className="cancel-button" onClick={closeComposer}>Close</button><button type="button" className="primary-button" onClick={submitTaskManually}>Create task <span>→</span></button></div></footer>
          </section>
        </div>
      )}
    </main>
  );
}
