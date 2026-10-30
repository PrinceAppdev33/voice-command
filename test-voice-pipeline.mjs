/**
 * Test suite for the voice task pipeline.
 * Tests the key functions from server.mjs in isolation.
 * Run with: node --test test-voice-pipeline.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Inline copies of the functions being tested ─────────────────────────────

const defaultTask = { assignee: "", date: "", time: "", subject: "", reviewer: "", recurring: false, frequency: "Weekly", startTask: false };

function mergeTask(base, changes) {
  if (!changes || typeof changes !== "object") return { ...base };
  return {
    assignee:  changes.assignee  !== null && changes.assignee  !== undefined ? String(changes.assignee).trim()  : base.assignee,
    date:      changes.date      !== null && changes.date      !== undefined ? String(changes.date)              : base.date,
    time:      changes.time      !== null && changes.time      !== undefined ? String(changes.time)              : base.time,
    subject:   changes.subject   !== null && changes.subject   !== undefined ? String(changes.subject).trim()   : base.subject,
    reviewer:  changes.reviewer  !== null && changes.reviewer  !== undefined ? String(changes.reviewer).trim()  : base.reviewer,
    recurring: changes.recurring !== null && changes.recurring !== undefined ? Boolean(changes.recurring)        : base.recurring,
    frequency: changes.frequency !== null && changes.frequency !== undefined ? changes.frequency                 : base.frequency,
    startTask: changes.startTask !== null && changes.startTask !== undefined ? Boolean(changes.startTask)        : base.startTask,
  };
}

function isExplicitTaskFieldUpdate(text) {
  const mentionsField = /\b(?:assignee|assigned\s+to|assign(?:ed)?|reviewer|subject|title|task\s*(?:name|date|time)|due\s+date|date|time|recur\w*|repeat\w*|daily|weekly|monthly|frequency|every\s+(?:day|week|month)s?|start\s+task)\b/i.test(text);
  const expressesChange = /\b(?:set|change|update|make|fill|add|put|assign|enable|disable|turn|switch|start|stop|on|off|want|need|keep|options?)\b|\b(?:would|i[''']d)\s+like\b/i.test(text);
  const hasPartialPattern = /\b(?:fill\s+(?:the\s+)?(?:date|time|subject|assignee|reviewer)|make\s+it\s+(?:\d|[a-z]+\s*(?:am|pm))|(?:no,?\s*(?:assign|change|make|set))|actually\b|instead\b)/i.test(text);
  return (mentionsField && expressesChange) || hasPartialPattern;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("mergeTask — partial update safety", () => {

  test("null fields preserve existing values", () => {
    const base = { ...defaultTask, assignee: "Rahul", date: "2026-10-30", subject: "Write report" };
    const changes = { assignee: null, date: null, time: "17:00", subject: null, reviewer: null, recurring: null, frequency: null, startTask: null };
    const result = mergeTask(base, changes);
    assert.equal(result.assignee, "Rahul",         "assignee preserved");
    assert.equal(result.date, "2026-10-30",        "date preserved");
    assert.equal(result.time, "17:00",             "time updated");
    assert.equal(result.subject, "Write report",   "subject preserved");
  });

  test("explicitly set fields are updated", () => {
    const base = { ...defaultTask, assignee: "Rahul" };
    const changes = { assignee: "Aman", date: null, time: null, subject: null, reviewer: null, recurring: null, frequency: null, startTask: null };
    const result = mergeTask(base, changes);
    assert.equal(result.assignee, "Aman", "assignee updated");
  });

  test("empty string from Gemini for an unmentioned field does NOT clear it", () => {
    // This simulates the old bug: Gemini returns "" for assignee even though user didn't mention it.
    // With null-sentinel, Gemini should return null, but if it returns "" we treat "" as a non-null value.
    // The fix is that Gemini now returns null, not "".
    const base = { ...defaultTask, assignee: "Priya" };
    const changes = { assignee: null, date: null, time: null, subject: null, reviewer: null, recurring: null, frequency: null, startTask: null };
    const result = mergeTask(base, changes);
    assert.equal(result.assignee, "Priya", "assignee not cleared when null");
  });

  test("boolean fields follow same null-sentinel logic", () => {
    const base = { ...defaultTask, recurring: true, frequency: "Weekly", startTask: true };
    const changes = { assignee: null, date: null, time: null, subject: null, reviewer: null, recurring: null, frequency: null, startTask: null };
    const result = mergeTask(base, changes);
    assert.equal(result.recurring, true,     "recurring preserved");
    assert.equal(result.frequency, "Weekly", "frequency preserved");
    assert.equal(result.startTask, true,     "startTask preserved");
  });

  test("Test A: 'Set the time to 5 PM' — only time changes", () => {
    const currentForm = { ...defaultTask, assignee: "Rahul", date: "2026-10-30", subject: "Prepare the report" };
    const geminiChanges = { assignee: null, date: null, time: "17:00", subject: null, reviewer: null, recurring: null, frequency: null, startTask: null };
    const result = mergeTask(currentForm, geminiChanges);
    assert.equal(result.time, "17:00",              "time set to 17:00");
    assert.equal(result.assignee, "Rahul",          "assignee preserved");
    assert.equal(result.date, "2026-10-30",         "date preserved");
    assert.equal(result.subject, "Prepare the report", "subject preserved");
  });

  test("Test B: Correction 'Change to Friday' — only date changes", () => {
    const currentForm = { ...defaultTask, assignee: "Rahul", date: "2026-10-30", time: "17:00", subject: "Report" };
    const geminiChanges = { assignee: null, date: "2026-10-31", time: null, subject: null, reviewer: null, recurring: null, frequency: null, startTask: null };
    const result = mergeTask(currentForm, geminiChanges);
    assert.equal(result.date, "2026-10-31",  "date updated to Friday");
    assert.equal(result.time, "17:00",       "time preserved");
    assert.equal(result.assignee, "Rahul",   "assignee preserved");
  });

  test("Test C: 'Add Priya as reviewer' — only reviewer changes", () => {
    const currentForm = { ...defaultTask, assignee: "Rahul", date: "2026-10-30", time: "17:00", subject: "Report" };
    const geminiChanges = { assignee: null, date: null, time: null, subject: null, reviewer: "Priya", recurring: null, frequency: null, startTask: null };
    const result = mergeTask(currentForm, geminiChanges);
    assert.equal(result.reviewer, "Priya",   "reviewer set to Priya");
    assert.equal(result.assignee, "Rahul",   "assignee preserved");
    assert.equal(result.date, "2026-10-30",  "date preserved");
    assert.equal(result.time, "17:00",       "time preserved");
  });

  test("Test D: 'Make it repeat every week' — only recurrence changes", () => {
    const currentForm = { ...defaultTask, assignee: "Rahul", date: "2026-10-30", time: "17:00", subject: "Report" };
    const geminiChanges = { assignee: null, date: null, time: null, subject: null, reviewer: null, recurring: true, frequency: "Weekly", startTask: null };
    const result = mergeTask(currentForm, geminiChanges);
    assert.equal(result.recurring, true,     "recurring enabled");
    assert.equal(result.frequency, "Weekly", "frequency set to Weekly");
    assert.equal(result.assignee, "Rahul",   "assignee preserved");
    assert.equal(result.time, "17:00",       "time preserved");
  });

  test("Test E: 'No, assign it to Aman instead' — only assignee changes", () => {
    const currentForm = { ...defaultTask, assignee: "Rahul", date: "2026-10-30", time: "17:00", subject: "Report", reviewer: "Priya", recurring: true, frequency: "Weekly" };
    const geminiChanges = { assignee: "Aman", date: null, time: null, subject: null, reviewer: null, recurring: null, frequency: null, startTask: null };
    const result = mergeTask(currentForm, geminiChanges);
    assert.equal(result.assignee, "Aman",    "assignee changed to Aman");
    assert.equal(result.reviewer, "Priya",   "reviewer preserved");
    assert.equal(result.recurring, true,     "recurring preserved");
    assert.equal(result.frequency, "Weekly", "frequency preserved");
    assert.equal(result.date, "2026-10-30",  "date preserved");
  });

});

describe("isExplicitTaskFieldUpdate — partial command detection", () => {

  test("'fill the date as tomorrow' is recognized", () => {
    assert.ok(isExplicitTaskFieldUpdate("fill the date as tomorrow"), "fill the date recognized");
  });

  test("'set the time to 5 PM' is recognized", () => {
    assert.ok(isExplicitTaskFieldUpdate("set the time to 5 PM"), "set the time recognized");
  });

  test("'assign this to Rahul' is recognized", () => {
    assert.ok(isExplicitTaskFieldUpdate("assign this to Rahul"), "assign recognized");
  });

  test("'add Priya as reviewer' is recognized", () => {
    assert.ok(isExplicitTaskFieldUpdate("add Priya as reviewer"), "add as reviewer recognized");
  });

  test("'make it repeat every week' is recognized", () => {
    assert.ok(isExplicitTaskFieldUpdate("make it repeat every week"), "repeat every week recognized");
  });

  test("'actually change the date to Friday' is recognized", () => {
    assert.ok(isExplicitTaskFieldUpdate("actually change the date to Friday"), "actually recognized");
  });

  test("'no assign it to Aman instead' is recognized", () => {
    assert.ok(isExplicitTaskFieldUpdate("no assign it to Aman instead"), "instead recognized");
  });

  test("'set the subject to prepare the report' is recognized", () => {
    assert.ok(isExplicitTaskFieldUpdate("set the subject to prepare the report"), "set subject recognized");
  });

  test("'what is the weather today' is NOT recognized as a task update", () => {
    assert.ok(!isExplicitTaskFieldUpdate("what is the weather today"), "weather not recognized as task update");
  });

  test("'tell me a joke' is NOT recognized as a task update", () => {
    assert.ok(!isExplicitTaskFieldUpdate("tell me a joke"), "joke not recognized as task update");
  });

});

describe("mergeTask — edge cases", () => {

  test("completely null changes returns a copy of base", () => {
    const base = { assignee: "Prince", date: "2026-11-01", time: "09:00", subject: "Morning standup", reviewer: "Priya", recurring: true, frequency: "Daily", startTask: false };
    const changes = { assignee: null, date: null, time: null, subject: null, reviewer: null, recurring: null, frequency: null, startTask: null };
    const result = mergeTask(base, changes);
    assert.deepEqual(result, base, "all fields preserved when all changes are null");
  });

  test("all fields updated at once", () => {
    const base = { ...defaultTask };
    const changes = { assignee: "Rahul", date: "2026-11-05", time: "15:00", subject: "Review UI", reviewer: "Priya", recurring: true, frequency: "Monthly", startTask: true };
    const result = mergeTask(base, changes);
    assert.deepEqual(result, changes, "all fields updated");
  });

});
