import { ParsedTaskSchema } from "./taskParser";
import type { ParsedTask } from "./taskParser";

export interface FormVerification {
  verified: boolean;
  failedFields: string[];
}

export function validateTaskForExecution(task: ParsedTask): string[] {
  const parsed = ParsedTaskSchema.safeParse(task);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => issue.message);
  }

  const missing: string[] = [];
  if (!task.assignee) missing.push("assigned user");
  if (!task.date) missing.push("date");
  if (!task.time) missing.push("time");
  if (!task.subject.trim()) missing.push("subject");
  return missing;
}

export function verifyTaskForm(root: HTMLElement, expected: ParsedTask): FormVerification {
  const failedFields: string[] = [];
  const inputValue = (id: string) => root.querySelector<HTMLInputElement>(`#${id}`)?.value;
  const switchValue = (id: string) => root.querySelector<HTMLButtonElement>(`#${id}`)?.getAttribute("aria-checked");

  if (inputValue("assigned-to-picker") !== expected.assignee) failedFields.push("assigned user");
  if (inputValue("task-date") !== expected.date) failedFields.push("date");
  if (inputValue("task-time") !== expected.time) failedFields.push("time");
  if (inputValue("task-subject")?.trim() !== expected.subject.trim()) failedFields.push("subject");
  if (inputValue("reviewer-picker") !== expected.reviewer) failedFields.push("reviewer");
  if (switchValue("recurring-task") !== String(expected.recurring)) failedFields.push("recurring task");
  if (expected.recurring && root.querySelector<HTMLSelectElement>("#frequency")?.value !== expected.frequency) {
    failedFields.push("recurrence frequency");
  }
  if (switchValue("start-task") !== String(expected.startTask)) failedFields.push("start task");

  return { verified: failedFields.length === 0, failedFields };
}
