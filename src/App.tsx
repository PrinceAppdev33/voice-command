import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { applyTaskClarification, emptyTask, getTaskClarification, parseTaskInstructions, USERS } from "./taskParser";
import type { ParsedTask, Recurrence, User } from "./taskParser";
import { validateTaskForExecution, verifyTaskForm } from "./taskFormExecution";

type SpeechRecognitionResultEvent = Event & { results: SpeechRecognitionResultList };
type SpeechRecognitionErrorEvent = Event & { error: string };
interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}
declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

interface CreatedTask extends ParsedTask {
  id: number;
}

const fieldLabels: Record<string, string> = {
  notAllowed: "Microphone permission was denied. Allow microphone access in your browser settings, or type your instruction instead.",
  noSpeech: "No speech was detected. Try again or type your instruction.",
  network: "Speech recognition could not connect. Check your connection, or type your instruction.",
};

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
  const [isListening, setIsListening] = useState(false);
  const [recognition, setRecognition] = useState<SpeechRecognitionInstance | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [pendingVerification, setPendingVerification] = useState<{ task: ParsedTask; ambiguities: string[] } | null>(null);
  const [clarificationContext, setClarificationContext] = useState<{ task: ParsedTask; ambiguities: string[] } | null>(null);
  const [recognitionLanguage, setRecognitionLanguage] = useState("en-IN");
  const formRef = useRef<HTMLDivElement>(null);
  const finalTranscriptRef = useRef("");
  const processedTranscriptRef = useRef("");
  const processSpeechOnEndRef = useRef(false);
  const submitLockRef = useRef(false);
  const processingLockRef = useRef(false);

  function openComposer() {
    submitLockRef.current = false;
    setIsOpen(true);
    setStatus(null);
  }

  function closeComposer() {
    processSpeechOnEndRef.current = false;
    recognition?.stop();
    setIsListening(false);
    setIsOpen(false);
  }

  async function processInstructions(transcript = instructions) {
    const text = transcript.trim();
    if (!text) {
      setStatus({ kind: "error", message: "Type or dictate an instruction first." });
      return;
    }
    if (processingLockRef.current) return;
    processingLockRef.current = true;
    setIsProcessing(true);
    setStatus({ kind: "info", message: "Parsing the instruction and preparing task fields…" });
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const freshParse = parseTaskInstructions(text);
      if (!freshParse.isTaskCommand && !clarificationContext) {
        setStatus({ kind: "info", message: "That doesn't sound like a task-creation instruction. Describe a task to fill in the form." });
        return;
      }

      const result = clarificationContext && !freshParse.isTaskCommand
        ? applyTaskClarification(clarificationContext.task, clarificationContext.ambiguities, text)
        : freshParse;
      const { task, ambiguities } = result;
      setForm(task);
      setPendingVerification({ task, ambiguities });
    } catch (error) {
      setPendingVerification(null);
      setStatus({
        kind: "error",
        message: error instanceof Error ? `Could not validate parsed task details: ${error.message}` : "Could not validate parsed task details.",
      });
    } finally {
      processingLockRef.current = false;
      setIsProcessing(false);
    }
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
    setStatus(result.verified
      ? { kind: "success", message: "Task details populated and verified. Please review and submit manually." }
      : { kind: "error", message: `Form verification failed for: ${result.failedFields.join(", ")}. Correct the fields before proceeding.` });
    setPendingVerification(null);
  }, [form, pendingVerification]);

  function toggleListening() {
    if (isListening) {
      recognition?.stop();
      setIsListening(false);
      return;
    }
    const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setStatus({ kind: "error", message: "Voice input isn't supported in this browser. You can still type instructions above." });
      return;
    }
    const nextRecognition = new SpeechRecognition();
    finalTranscriptRef.current = "";
    processedTranscriptRef.current = "";
    processSpeechOnEndRef.current = true;
    nextRecognition.lang = recognitionLanguage;
    nextRecognition.interimResults = true;
    nextRecognition.maxAlternatives = 1;
    nextRecognition.onresult = (event) => {
      const results = Array.from(event.results);
      finalTranscriptRef.current = results.filter((result) => result.isFinal).map((result) => result[0].transcript).join(" ").trim();
      const transcript = results.map((result) => result[0].transcript).join(" ").trim();
      setInstructions(transcript);
      setStatus({ kind: "info", message: "Speech recognized. The completed transcript will be processed automatically." });
    };
    nextRecognition.onerror = (event) => {
      processSpeechOnEndRef.current = false;
      setIsListening(false);
      setRecognition(null);
      setStatus({ kind: "error", message: fieldLabels[event.error] ?? `Voice input failed (${event.error}). You can type your instruction instead.` });
    };
    nextRecognition.onend = () => {
      setIsListening(false);
      setRecognition(null);
      const transcript = finalTranscriptRef.current;
      if (processSpeechOnEndRef.current && transcript && transcript !== processedTranscriptRef.current) {
        processedTranscriptRef.current = transcript;
        processInstructions(transcript);
      } else if (processSpeechOnEndRef.current && !transcript) {
        setStatus({ kind: "error", message: "No complete speech was recognized. Try again or type your instruction." });
      }
      processSpeechOnEndRef.current = false;
    };
    setRecognition(nextRecognition);
    setIsListening(true);
    setStatus({ kind: "info", message: "Listening… speak your task instruction." });
    try {
      nextRecognition.start();
    } catch (error) {
      processSpeechOnEndRef.current = false;
      setRecognition(null);
      setIsListening(false);
      setStatus({ kind: "error", message: error instanceof Error ? `Could not start microphone: ${error.message}` : "Could not start microphone. You can type your instruction instead." });
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

  function submitTaskManually() {
    if (submitLockRef.current) return;
    const invalid = validateTaskForExecution(form);
    if (invalid.length) {
      setFieldErrors(invalid);
      setStatus({ kind: "error", message: `Complete the task details before submitting: ${invalid.join(", ")}.` });
      return;
    }

    submitLockRef.current = true;
    setTasks((current) => [{ ...form, subject: form.subject.trim(), id: Date.now() }, ...current]);
    setInstructions("");
    setForm(emptyTask());
    setFieldErrors([]);
    setPendingVerification(null);
    setClarificationContext(null);
    setIsOpen(false);
    setStatus({ kind: "success", message: "Task submitted manually and added to this session's task list." });
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
          <div><h2>Your tasks <span className="task-count">{tasks.length}</span></h2><p>Commands fill the form; you choose when to submit.</p></div>
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
          <div className="empty-state"><div className="empty-icon">✳</div><h3>Ready when you are</h3><p>Open the task form, describe a task, then review the verified fields before submitting manually.</p><button className="text-button" type="button" onClick={openComposer}>Try a voice or text command <span>→</span></button></div>
        )}
        <p className="privacy-note"><span>✦</span> Local deterministic parsing · no API key; submission always requires your click.</p>
      </section>

      {isOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeComposer(); }}>
          <section className="composer" role="dialog" aria-modal="true" aria-labelledby="composer-title">
            <header className="composer-header"><div><span className="composer-icon">✦</span><div><h2 id="composer-title">Task details</h2><p>Say it or type it — we’ll fill in the form for review.</p></div></div><button className="close-button" type="button" aria-label="Close" onClick={closeComposer}>×</button></header>
            <div className="composer-body">
              <label className="instruction-label" htmlFor="instructions">Your instruction</label>
              <div className="instruction-box"><textarea id="instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="e.g. Create a task for Rahul tomorrow at 3 PM. The subject is Review the project…" rows={3} /><button className={`mic-button ${isListening ? "listening" : ""}`} type="button" aria-label={isListening ? "Stop listening" : "Start voice input"} onClick={toggleListening}><span>{isListening ? "■" : "⌁"}</span></button></div>
              <div className="instruction-actions">
                <label className="language-picker">Speech language
                  <select value={recognitionLanguage} onChange={(event) => setRecognitionLanguage(event.target.value)} disabled={isListening}>
                    <option value="en-IN">English (India)</option><option value="en-US">English (US)</option>
                  </select>
                </label>
                <span className="voice-hint">{isListening ? "Listening now…" : "Voice input works in supported browsers; typed input is always available."}</span>
                <button className="process-button" type="button" onClick={() => void processInstructions()} disabled={isProcessing || isListening}>
                  {isProcessing && <span className="spinner" aria-hidden="true" />} {isProcessing ? "Processing…" : "Process instructions"} <span aria-hidden="true">→</span>
                </button>
              </div>
              <p className="speech-privacy-note">Voice transcription uses your browser’s speech service; task understanding runs locally in this app.</p>
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
            <footer className="composer-footer"><span>Submission requires your explicit action</span><div><button type="button" className="cancel-button" onClick={closeComposer}>Close</button><button type="button" className="primary-button" onClick={submitTaskManually}>Create task <span>→</span></button></div></footer>
          </section>
        </div>
      )}
    </main>
  );
}
