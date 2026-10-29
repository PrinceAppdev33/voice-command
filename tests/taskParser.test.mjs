import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/taskParser.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const parserModule = { exports: {} };
new Function("require", "module", "exports", compiled.outputText)(
  createRequire(import.meta.url),
  parserModule,
  parserModule.exports,
);
const { applyTaskClarification, emptyTask, getTaskClarification, parseTaskInstructions } = parserModule.exports;

const now = new Date("2026-10-29T04:00:00.000Z");

test("extracts all supported fields from a natural voice command", () => {
  const { task, ambiguities, isTaskCommand } = parseTaskInstructions(
    "Assign Rahul a task to prepare the project report tomorrow at 5 PM, add Priya as reviewer, make it recurring weekly, and start the task.",
    now,
  );
  assert.equal(isTaskCommand, true);
  assert.deepEqual(ambiguities, []);
  assert.deepEqual(task, {
    assignee: "Rahul",
    date: "2026-10-30",
    time: "17:00",
    subject: "prepare the project report",
    reviewer: "Priya",
    recurring: true,
    frequency: "Weekly",
    startTask: true,
  });
});

test("understands different command phrasing and recognizes task intent without the word task", () => {
  const first = parseTaskInstructions("Create a UI review task for Priya for Friday at 3 in the afternoon.", now);
  const second = parseTaskInstructions("Assign Priya a UI review due Friday at 3 PM.", now);
  assert.equal(first.task.assignee, second.task.assignee);
  assert.equal(first.task.subject, second.task.subject);
  assert.equal(first.task.date, second.task.date);
  assert.equal(first.task.time, second.task.time);
  assert.equal(second.isTaskCommand, true);
});

test("rejects irrelevant speech without producing task data", () => {
  const result = parseTaskInstructions("What is the weather today?", now);
  assert.equal(result.isTaskCommand, false);
  assert.deepEqual(result.task, emptyTask());
});

test("reports missing required fields and preserves known details for clarification", () => {
  const first = parseTaskInstructions("Create a task for Rahul to review the database.", now);
  assert.match(getTaskClarification(first.task, first.ambiguities), /date/);
  const clarification = applyTaskClarification(first.task, ["date", "time"], "tomorrow at 5 PM", now);
  assert.equal(clarification.task.assignee, "Rahul");
  assert.equal(clarification.task.subject, "review the database");
  assert.equal(clarification.task.date, "2026-10-30");
  assert.equal(clarification.task.time, "17:00");
  assert.deepEqual(clarification.ambiguities, []);
});

test("accepts assignees outside the suggested user list", () => {
  const result = parseTaskInstructions("Give Aman a weekly database update task starting tomorrow.", now);
  assert.equal(result.task.assignee, "Aman");
  assert.deepEqual(result.ambiguities, []);
  assert.equal(result.task.recurring, true);
  assert.equal(result.task.frequency, "Weekly");
});

test("extracts multi-word custom assignee names from task assignment phrasing", () => {
  const taskForName = parseTaskInstructions("Create a task for Ananya Sharma to review the design tomorrow at 4 PM.", now);
  const assignToName = parseTaskInstructions("Assign the report to Omar Khan due tomorrow at 5 PM.", now);
  assert.equal(taskForName.task.assignee, "Ananya Sharma");
  assert.equal(assignToName.task.assignee, "Omar Khan");
});

test("resolves relative time in Asia/Kolkata, including day rollover", () => {
  const result = parseTaskInstructions("Create a task for Rahul to check the release in two hours.", now);
  assert.equal(result.task.date, "2026-10-29");
  assert.equal(result.task.time, "11:30");

  const nextDay = parseTaskInstructions("Create a task for Rahul to check the release in two hours.", new Date("2026-10-29T17:00:00.000Z"));
  assert.equal(nextDay.task.date, "2026-10-30");
  assert.equal(nextDay.task.time, "00:30");
});

test("clarifies ambiguous times and supports explicit recurrence wording", () => {
  const ambiguous = parseTaskInstructions("Create a task for Rahul to review logs tomorrow at 5.", now);
  assert.ok(ambiguous.ambiguities.includes("time"));

  const recurring = parseTaskInstructions("Create a task for Rahul to update the database tomorrow at 10 AM every week.", now);
  assert.equal(recurring.task.recurring, true);
  assert.equal(recurring.task.frequency, "Weekly");
});

test("does not treat an empty transcript as a task command", () => {
  const result = parseTaskInstructions("   ", now);
  assert.equal(result.isTaskCommand, false);
  assert.deepEqual(result.task, emptyTask());
});
