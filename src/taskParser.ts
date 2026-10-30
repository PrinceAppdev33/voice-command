import { z } from "zod";

export const USERS = ["Prince", "Rahul", "Priya"] as const;
export type User = string;
export type Recurrence = "Daily" | "Weekly" | "Monthly";

const userSchema = z.string().trim();
const dateSchema = z.string().refine((value) => {
  if (!value) return true;
  const date = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "Date must be a valid calendar date.");
const timeSchema = z.string().refine((value) => !value || /^([01]\d|2[0-3]):[0-5]\d$/.test(value), "Time must use 24-hour HH:mm format.");

export const ParsedTaskSchema = z.object({
  assignee: userSchema,
  date: dateSchema,
  time: timeSchema,
  subject: z.string(),
  reviewer: userSchema,
  recurring: z.boolean(),
  frequency: z.enum(["Daily", "Weekly", "Monthly"]),
  startTask: z.boolean(),
});

export const ParseResultSchema = z.object({
  task: ParsedTaskSchema,
  ambiguities: z.array(z.string()),
  isTaskCommand: z.boolean(),
});

export interface ParsedTask {
  assignee: User | "";
  date: string;
  time: string;
  subject: string;
  reviewer: User | "";
  recurring: boolean;
  frequency: Recurrence;
  startTask: boolean;
}

export interface ParseResult {
  task: ParsedTask;
  ambiguities: string[];
  isTaskCommand: boolean;
}

export const emptyTask = (): ParsedTask => ({
  assignee: "",
  date: "",
  time: "",
  subject: "",
  reviewer: "",
  recurring: false,
  frequency: "Weekly",
  startTask: false,
});

function kolkataParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

function todayInKolkata(now = new Date()): Date {
  const { year, month, day } = kolkataParts(now);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function resolveDate(text: string, today: Date): string | undefined {
  const normalized = text.toLowerCase();
  if (/\btoday\b/.test(normalized)) return dateKey(today);
  if (/\btomorrow\b/.test(normalized)) {
    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return dateKey(tomorrow);
  }

  const inDays = normalized.match(/\bin\s+(\d+|one|two|three|four|five|six|seven)\s+days?\b/);
  if (inDays) {
    const count = wordNumbers[inDays[1]] ?? Number(inDays[1]);
    const resolved = new Date(today);
    resolved.setUTCDate(resolved.getUTCDate() + count);
    return dateKey(resolved);
  }
  if (/\bnext\s+week\b/.test(normalized)) {
    const resolved = new Date(today);
    resolved.setUTCDate(resolved.getUTCDate() + 7);
    return dateKey(resolved);
  }

  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const weekdayMatch = normalized.match(/\b(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (weekdayMatch) {
    const targetDay = weekdays.indexOf(weekdayMatch[1]);
    let daysAhead = (targetDay - today.getUTCDay() + 7) % 7;
    if (daysAhead === 0 || /\bnext\b/.test(weekdayMatch[0])) daysAhead ||= 7;
    const resolved = new Date(today);
    resolved.setUTCDate(resolved.getUTCDate() + daysAhead);
    return dateKey(resolved);
  }

  const isoDate = normalized.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (isoDate) {
    const year = Number(isoDate[1]);
    const month = Number(isoDate[2]);
    const day = Number(isoDate[3]);
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day) {
      return dateKey(candidate);
    }
  }
  return undefined;
}

const wordNumbers: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function resolveTime(text: string, now: Date): { time?: string; date?: string; ambiguous: boolean } {
  const normalized = text.toLowerCase();
  const inHours = normalized.match(/\bin\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+hours?\b/);
  if (inHours) {
    const { year, month, day, hour, minute } = kolkataParts(now);
    const target = new Date(Date.UTC(year, month - 1, day, hour, minute));
    target.setUTCHours(target.getUTCHours() + (wordNumbers[inHours[1]] ?? Number(inHours[1])));
    return {
      date: dateKey(target),
      time: `${String(target.getUTCHours()).padStart(2, "0")}:${String(target.getUTCMinutes()).padStart(2, "0")}`,
      ambiguous: false,
    };
  }

  const halfPast = normalized.match(/\bhalf\s+past\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})(?:\s+(?:in\s+the\s+)?(am|pm|morning|afternoon|evening))?\b/);
  if (halfPast) {
    const hour = wordNumbers[halfPast[1]] ?? Number(halfPast[1]);
    const qualifier = halfPast[2];
    if (hour < 1 || hour > 12 || !qualifier) return { ambiguous: true };
    const isPm = ["pm", "afternoon", "evening"].includes(qualifier);
    return { time: `${String((hour % 12) + (isPm ? 12 : 0)).padStart(2, "0")}:30`, ambiguous: false };
  }

  const clockMatch = normalized.match(/\b(?:at\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(am|pm|in\s+the\s+(?:morning|afternoon|evening)|morning|afternoon|evening)\b/);
  if (clockMatch) {
    const hour = wordNumbers[clockMatch[1]] ?? Number(clockMatch[1]);
    const minute = Number(clockMatch[2] ?? "0");
    const period = clockMatch[3].replace(/^in\s+the\s+/, "");
    if (hour < 1 || hour > 12 || minute > 59) return { ambiguous: true };
    if (period === "morning" && hour === 12) return { time: `00:${String(minute).padStart(2, "0")}`, ambiguous: false };
    const isPm = ["pm", "afternoon", "evening"].includes(period);
    return { time: `${String((hour % 12) + (isPm ? 12 : 0)).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, ambiguous: false };
  }

  const twentyFourHour = normalized.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (twentyFourHour) {
    return { time: `${String(Number(twentyFourHour[1])).padStart(2, "0")}:${twentyFourHour[2]}`, ambiguous: false };
  }
  if (/\b(?:at|by|around)\s+\d{1,2}\b/.test(normalized)) return { ambiguous: true };
  return { ambiguous: false };
}

function matchingUsers(text: string): User[] {
  return USERS.filter((user) => new RegExp(`\\b${user}\\b`, "i").test(text));
}

function extractAssignee(text: string): { assignee: User | ""; ambiguity: boolean } {
  const reviewerSegments = text.match(/\b(?:reviewer|as reviewer)\b[^,.]*/gi) ?? [];
  const withoutReviewer = reviewerSegments.reduce((result, segment) => result.replace(segment, " "), text);
  const capture = (pattern: RegExp, group = 1) => withoutReviewer.match(pattern)?.[group]?.trim();
  const candidate = capture(/\bassign(?:ed)?\s+(?:the\s+)?(?:task\s+)?(.+?)\s+(?:a|an|the)\s+(?:.{0,70}?\s+)?task\b/i)
    ?? capture(/\bgive\s+(.+?)\s+(?:a|an|the)\s+(?:.{0,70}?\s+)?task\b/i)
    ?? capture(/\b(?:create|make|add|schedule)\s+(?:a|an|the)?\s*task\s+for\s+(.+?)(?=\s+(?:to|for|due|today|tomorrow|next|at|starting)\b|[,.!?]|$)/i)
    ?? capture(/\btask\s+for\s+(.+?)(?=\s+(?:to|for|due|today|tomorrow|next|at|starting)\b|[,.!?]|$)/i)
    ?? capture(/\bassign(?:ed)?\b.*\bto\s+(.+?)(?=\s+(?:due|today|tomorrow|next|at|starting|and|add|make|start|recurring|weekly|daily|monthly|every)\b|[,.!?]|$)/i)
    ?? capture(/\bassign(?:ed)?\s+(?:the\s+)?[^,.]+?\s+to\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*)?)(?=\s*(?:,|and\s+(?:add|make|set|start)\b|$))/i)
    ?? capture(/\b(?:assign(?:ed)?\s+(?:the\s+)?(?:task\s+)?(?:to\s+)?|give\s+|for\s+|task\s+to\s+)([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*)?)(?=\s+(?:a|an|the|to|for|tomorrow|today|next|due|at|starting)\b|[,.!?]|$)/i);
  if (!candidate) return { assignee: "", ambiguity: false };
  const name = candidate.replace(/^(?:the|a|an)\s+/i, "").replace(/[,.!?]+$/, "").trim();
  const knownUser = USERS.find((item) => item.toLowerCase() === name.toLowerCase());
  return { assignee: knownUser ?? name, ambiguity: false };
}

function extractReviewer(text: string): { reviewer: User | ""; ambiguity: boolean } {
  const match = text.match(/\b(?:([a-z][a-z'-]*)\s+as\s+reviewer|reviewer\s+(?:is\s+)?([a-z][a-z'-]*))\b/i);
  if (!match) return { reviewer: "", ambiguity: false };
  const candidate = match[1] ?? match[2];
  const reviewer = USERS.find((user) => user.toLowerCase() === candidate.toLowerCase());
  return { reviewer: reviewer ?? "", ambiguity: !reviewer };
}

const stopClause = String.raw`(?=\s+(?:for\s+(?:${USERS.join("|")})\b|assign(?:ed)?\s+|reviewer\b|(?:today|tomorrow|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b|in\s+(?:\d+|one|two|three|four|five|six|seven)\s+(?:days?|hours?)\b|at\s+|by\s+|around\s+|starting\b|due\b|(?:daily|weekly|monthly|recurr\w*|repeat\w*|every\s+)|start\s+task\b)|[.!?]?$)`;

function cleanSubject(value: string): string {
  return value
    .replace(/\b(?:daily|weekly|monthly)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;–-]+|[\s,.:;!?–-]+$/g, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .trim();
}

function extractSubject(text: string): string {
  const explicit = text.match(new RegExp(String.raw`\b(?:the\s+)?(?:subject|title|task name)\s+(?:is|should\s+be|:)\s*(.+?)${stopClause}`, "i"));
  if (explicit) return cleanSubject(explicit[1]);

  const taskTo = text.match(new RegExp(String.raw`\btask\s+(?:to|called|titled)\s+(.+?)${stopClause}`, "i"));
  if (taskTo) return cleanSubject(taskTo[1]);

  const createTask = text.match(/\b(?:create|make|add|schedule)\s+(?:a|an|the)?\s*(.{2,90}?)\s+task\b/i);
  if (createTask) return cleanSubject(createTask[1]);

  const giveTask = text.match(/\b(?:give|assign)\s+(?:[a-z][a-z'-]*\s+)?(?:a|an|the)?\s*(.{2,90}?)\s+task\b/i);
  if (giveTask) return cleanSubject(giveTask[1]);

  const assignedSubject = text.match(/\bassign\s+(?:the\s+)?(.{2,70}?)\s+to\s+(?:Prince|Rahul|Priya)\b/i);
  if (assignedSubject) return cleanSubject(assignedSubject[1].replace(/\btask\b/i, ""));

  const assignSubject = text.match(new RegExp(String.raw`\bassign\s+(?:${USERS.join("|")})\s+(?:a|an|the)?\s*(.{2,80}?)${stopClause}`, "i"));
  if (assignSubject) return cleanSubject(assignSubject[1].replace(/\btask\b/i, ""));

  const taskForUser = text.match(new RegExp(String.raw`\btask\s+for\s+(?:Prince|Rahul|Priya)\s+to\s+(.+?)${stopClause}`, "i"));
  if (taskForUser) return cleanSubject(taskForUser[1]);
  return "";
}

function isFieldUpdateCommand(text: string): boolean {
  // Match direct field-update commands that don't use a create-task verb
  return /\b(?:set|change|update|fill|put|make\s+it|assign(?:ed)?|add)\s+(?:the\s+)?(?:date|time|subject|assignee|reviewer|recurrence|frequency)\b/i.test(text)
    || /\b(?:set\s+the|change\s+the|update\s+the|fill\s+the)\b/i.test(text)
    || /\b(?:make\s+it\s+(?:repeat|recurring|weekly|daily|monthly))\b/i.test(text)
    || /\b(?:actually|no,?\s+(?:assign|change|make|set)|instead)\b/i.test(text)
    || /\b(?:add\s+\w+\s+as\s+reviewer|assign\s+(?:this|it)\s+to)\b/i.test(text)
    || /\bstart\s+(?:the\s+)?task\s+(?:now|immediately)\b/i.test(text);
}

function isTaskCreationCommand(text: string): boolean {
  const imperative = /\b(?:create|make|add|assign|give|schedule|set\s+up)\b/i.test(text);
  return imperative && (/\btask\b/i.test(text) || /\bassign(?:ed)?\b.*\b(?:to|for)\b/i.test(text) || /\bassign\s+(?:Prince|Rahul|Priya)\b/i.test(text));
}

export function parseTaskInstructions(instructions: string, now = new Date()): ParseResult {
  const text = instructions.trim();
  const lower = text.toLowerCase();
  const task = emptyTask();
  const ambiguities: string[] = [];
  const isTaskCommand = isTaskCreationCommand(text) || isFieldUpdateCommand(text);
  if (!isTaskCommand) return ParseResultSchema.parse({ task, ambiguities, isTaskCommand });

  const assignee = extractAssignee(text);
  task.assignee = assignee.assignee;
  if (assignee.ambiguity) ambiguities.push("assignee");

  const reviewer = extractReviewer(text);
  task.reviewer = reviewer.reviewer;
  if (reviewer.ambiguity) ambiguities.push("reviewer");

  const today = todayInKolkata(now);
  const resolvedTime = resolveTime(lower, now);
  task.time = resolvedTime.time ?? "";
  task.date = resolvedTime.date ?? resolveDate(lower, today) ?? "";
  if (resolvedTime.ambiguous) ambiguities.push("time");

  task.subject = extractSubject(text);
  task.recurring = /\b(?:recurr\w*|repeat\w*|daily|weekly|monthly|(?:every|each)\s+(?:day|week|month)s?)\b/.test(lower);
  if (/\b(?:weekly|(?:every|each)\s+week)\b/.test(lower)) task.frequency = "Weekly";
  else if (/\b(?:daily|(?:every|each)\s+day)\b/.test(lower)) task.frequency = "Daily";
  else if (/\b(?:monthly|(?:every|each)\s+month)\b/.test(lower)) task.frequency = "Monthly";
  task.startTask = /\b(?:enable|turn\s+on|start)\s+(?:the\s+)?start\s+task\b|\bstart\s+task\s+option\b|\bstart\s+(?:it|the\s+)?task\b|\bstart\s+(?:it|the task)\s+immediately\b|\bstart immediately\b/i.test(text);

  if (!task.date && /\b(?:today|tomorrow|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(text)) {
    ambiguities.push("date");
  }
  return ParseResultSchema.parse({ task, ambiguities, isTaskCommand });
}

export function applyTaskClarification(
  previous: ParsedTask,
  ambiguities: string[],
  clarification: string,
  now = new Date(),
): ParseResult {
  const task = { ...previous };
  const remaining = new Set(ambiguities);
  const text = clarification.trim();
  const lower = text.toLowerCase();

  if (remaining.has("assignee")) {
    const name = text.replace(/^(?:the\s+)?(?:assignee\s*(?:is|:)\s*)?/i, "").replace(/[,.!?]+$/, "").trim();
    if (name && !/\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s*(?:am|pm))\b/i.test(name)) {
      task.assignee = USERS.find((user) => user.toLowerCase() === name.toLowerCase()) ?? name;
      remaining.delete("assignee");
    }
  }
  if (remaining.has("reviewer")) {
    const matches = matchingUsers(text);
    if (matches.length === 1) {
      task.reviewer = matches[0];
      remaining.delete("reviewer");
    }
  }
  if (remaining.has("date")) {
    const date = resolveDate(lower, todayInKolkata(now));
    if (date) {
      task.date = date;
      remaining.delete("date");
    }
  }
  if (remaining.has("time")) {
    const time = resolveTime(lower, now);
    if (time.time) {
      task.time = time.time;
      if (time.date) task.date = time.date;
      remaining.delete("time");
      if (time.date) remaining.delete("date");
    }
  }
  if (!task.subject && remaining.has("subject")) {
    task.subject = cleanSubject(text);
    if (task.subject) remaining.delete("subject");
  }
  if (/\b(?:weekly|every week)\b/.test(lower)) {
    task.recurring = true;
    task.frequency = "Weekly";
  } else if (/\b(?:daily|every day)\b/.test(lower)) {
    task.recurring = true;
    task.frequency = "Daily";
  } else if (/\b(?:monthly|every month)\b/.test(lower)) {
    task.recurring = true;
    task.frequency = "Monthly";
  }
  return ParseResultSchema.parse({ task, ambiguities: [...remaining], isTaskCommand: true });
}

export function getTaskClarification(task: ParsedTask, ambiguities: string[]): string {
  const questions: string[] = [];
  if (ambiguities.includes("time")) questions.push("What time do you mean? Please include AM/PM or use 24-hour time.");
  if (ambiguities.includes("date")) questions.push("Which date did you mean?");
  if (ambiguities.includes("assignee")) questions.push("Who should this task be assigned to?");
  if (ambiguities.includes("reviewer")) questions.push("I couldn't match that reviewer. Choose Prince, Rahul, or Priya, or omit the reviewer.");
  if (!task.assignee && !ambiguities.includes("assignee")) questions.push("Who should this task be assigned to?");
  if (!task.date && !ambiguities.includes("date")) questions.push("What date should the task be scheduled for?");
  if (!task.time && !ambiguities.includes("time")) questions.push("What time should the task start?");
  if (!task.subject) questions.push("What should the task subject be?");
  return questions.join(" ");
}
