import assert from "node:assert/strict";
import test from "node:test";
import { createAppServer } from "../server.mjs";

async function withServer(run) {
  const server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("reports health without requiring Gemini", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test("rejects malformed or oversized-shape input before contacting Gemini", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/understand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "", audioBase64: "" }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /either a text command or a voice recording/);
  });
});

test("reports missing Gemini configuration without exposing credentials", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/understand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Create a task for Rahul tomorrow at 5 PM.", language: "en-IN" }),
      });
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /GEMINI_API_KEY/);
    });
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("reports a useful network error when Gemini cannot be reached", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  process.env.GEMINI_API_KEY = "server-only-test-key";
  console.error = () => {};
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("generativelanguage.googleapis.com")) {
      throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
    }
    return originalFetch(input, init);
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/understand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Create a task for Rahul tomorrow at 5 PM.", language: "en-IN" }),
      });
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /ENOTFOUND/);
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("returns promptly when Gemini times out", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "server-only-test-key";
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("generativelanguage.googleapis.com")) {
      const error = new Error("request timed out");
      error.name = "TimeoutError";
      throw error;
    }
    return originalFetch(input, init);
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/understand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Create a task for Rahul tomorrow at 5 PM.", language: "en-IN" }),
      });
      assert.equal(response.status, 504);
      assert.match((await response.json()).error, /25 seconds/);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("transcribes and validates Gemini audio output while keeping the key server-side", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "server-only-test-key";
  let upstreamRequest;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("generativelanguage.googleapis.com")) {
      upstreamRequest = { url: String(input), headers: new Headers(init.headers), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                transcript: "Assign Ananya Sharma a task to review the design tomorrow at 4 PM.",
                isTaskCommand: true,
                changes: {
                  assignee: "Ananya Sharma",
                  date: "2026-10-30",
                  time: "16:00",
                  subject: "review the design",
                  reviewer: "",
                  recurring: false,
                  frequency: "Weekly",
                  startTask: false,
                },
                ambiguities: [],
                needsClarification: false,
                clarificationQuestion: null,
              }),
            }],
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(input, init);
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/understand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: Buffer.from("mock audio").toString("base64"),
          mimeType: "audio/webm;codecs=opus",
          language: "en-IN",
        }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.task.assignee, "Ananya Sharma");
      assert.equal(result.task.time, "16:00");
      assert.equal(result.transcript, "Assign Ananya Sharma a task to review the design tomorrow at 4 PM.");
      assert.equal(upstreamRequest.headers.get("x-goog-api-key"), "server-only-test-key");
      assert.equal(upstreamRequest.url.includes("server-only-test-key"), false);
      assert.equal(upstreamRequest.body.contents[0].parts[1].inline_data.mime_type, "audio/webm");
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("uses the last non-thought Gemini text part as structured output", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "server-only-test-key";
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("generativelanguage.googleapis.com")) {
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [
              { thought: true, text: "Let me extract the assignee and due date from this instruction." },
              {
                text: JSON.stringify({
                  transcript: "Create a task for Rahul tomorrow at 3 PM to review the report.",
                  isTaskCommand: true,
                  changes: {
                    assignee: "Rahul",
                    date: "2026-10-31",
                    time: "15:00",
                    subject: "review the report",
                    reviewer: null,
                    recurring: null,
                    frequency: null,
                    startTask: null,
                  },
                  ambiguities: [],
                  needsClarification: false,
                  clarificationQuestion: null,
                }),
              },
            ],
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(input, init);
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/understand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Create a task for Rahul tomorrow at 3 PM to review the report.", language: "en-IN" }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.task.assignee, "Rahul");
      assert.equal(result.task.time, "15:00");
      assert.equal(result.task.subject, "review the report");
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("treats casual task-option phrasing as an update and preserves existing form data", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "server-only-test-key";
  const currentTask = {
    assignee: "Rahul",
    date: "2026-10-30",
    time: "17:00",
    subject: "review the report",
    reviewer: "",
    recurring: false,
    frequency: "Weekly",
    startTask: false,
  };
  let upstreamRequest;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("generativelanguage.googleapis.com")) {
      upstreamRequest = JSON.parse(init.body);
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                transcript: "the river is Anita and on the options recurring task and start task now",
                isTaskCommand: false,
                changes: {
                  assignee: null,
                  date: null,
                  time: null,
                  subject: null,
                  reviewer: null,
                  recurring: true,
                  frequency: null,
                  startTask: true,
                },
                ambiguities: ["reviewer"],
                needsClarification: false,
                clarificationQuestion: null,
              }),
            }],
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(input, init);
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/understand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "the river is Anita and on the options recurring task and start task now",
          language: "en-IN",
          currentTask,
        }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.isTaskCommand, true);
      assert.equal(result.task.assignee, "Rahul");
      assert.equal(result.task.subject, "review the report");
      assert.equal(result.task.recurring, true);
      assert.equal(result.task.startTask, true);
      assert.deepEqual(result.ambiguities, ["reviewer"]);
      assert.ok(upstreamRequest.contents[0].parts.some((part) => part.text.includes(JSON.stringify(currentTask))));
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("recognizes spoken recurrence updates without requiring task-creation wording", async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "server-only-test-key";
  const currentTask = {
    assignee: "Rahul",
    date: "2026-10-30",
    time: "17:00",
    subject: "review the report",
    reviewer: "Priya",
    recurring: false,
    frequency: "Weekly",
    startTask: false,
  };
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("generativelanguage.googleapis.com")) {
      const request = JSON.parse(init.body);
      assert.match(request.systemInstruction.parts[0].text, /transcribe it faithfully/);
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                transcript: "I want this to recur every week",
                isTaskCommand: false,
                changes: {
                  assignee: null,
                  date: null,
                  time: null,
                  subject: null,
                  reviewer: null,
                  recurring: true,
                  frequency: "Weekly",
                  startTask: null,
                },
                ambiguities: [],
                needsClarification: false,
                clarificationQuestion: null,
              }),
            }],
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(input, init);
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/understand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: Buffer.from("mock audio").toString("base64"),
          mimeType: "audio/webm;codecs=opus",
          language: "en-IN",
          currentTask,
        }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.isTaskCommand, true);
      assert.equal(result.task.recurring, true);
      assert.equal(result.task.frequency, "Weekly");
      assert.equal(result.task.assignee, currentTask.assignee);
      assert.equal(result.task.subject, currentTask.subject);
      assert.equal(result.task.reviewer, currentTask.reviewer);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});
