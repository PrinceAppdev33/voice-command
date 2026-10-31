import { z } from "zod";
import { ParsedTaskSchema } from "./taskParser";
import type { ParsedTask } from "./taskParser";

// The server now returns a fully-merged task (server-side merge of currentTask + Gemini changes).
// `needsClarification` and `clarificationQuestion` surface Gemini's follow-up questions.
const AiResponseSchema = z.object({
  transcript: z.string(),
  isTaskCommand: z.boolean(),
  task: ParsedTaskSchema,
  ambiguities: z.array(z.string()),
  needsClarification: z.boolean().optional(),
  clarificationQuestion: z.string().nullable().optional(),
});

export interface AiTaskContext {
  task: ParsedTask;
  ambiguities: string[];
}

export type AiUnderstandingRequest = {
  language: string;
  currentTask?: ParsedTask;
  clarificationContext?: AiTaskContext;
} & (
  | { text: string; audioBase64?: never; mimeType?: never }
  | { audioBase64: string; mimeType: string; text?: never }
);

export type AiUnderstandingResponse = z.infer<typeof AiResponseSchema>;

export async function understandTask(request: AiUnderstandingRequest): Promise<AiUnderstandingResponse> {
  let response: Response;
  try {
    response = await fetch("/api/understand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    throw new Error("Could not reach the TaskPilot AI server. Make sure the app server is running.");
  }

  const raw = await response.text();
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    const looksLikeHtml = /<!doctype html|<html[\s>]/i.test(raw);
    throw new Error(
      response.status === 404 || looksLikeHtml || !raw.trim()
        ? `Received a web page instead of the TaskPilot API response from ${new URL(response.url).origin}/api/understand. The API endpoint may be missing or misconfigured. On Vercel, redeploy after adding the API function; locally, restart the app with npm run dev.`
        : `The TaskPilot AI server returned an unreadable response (HTTP ${response.status}).`,
    );
  }

  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(body);
    throw new Error(error.success ? error.data.error : `AI request failed (HTTP ${response.status}).`);
  }

  const parsed = AiResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error("The AI response did not match the expected task format. Try again.");
  }
  return parsed.data;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
