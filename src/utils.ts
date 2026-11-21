import { setTimeout as delay } from "node:timers/promises";
import type { ChatMessage, ToolCall } from "./types.js";

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await delay(ms, undefined, signal === undefined ? undefined : { signal });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = Math.max(0, maxLength - 16);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end -= 1;
  return `${text.slice(0, end)}\n...[truncated]`;
}

export function splitTelegramMessage(text: string, limit = 3900): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new Error("Message limit must be at least 2");
  if (text.length === 0) return [];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = limit;
    const previousCodeUnit = remaining.charCodeAt(cut - 1);
    if (previousCodeUnit >= 0xd800 && previousCodeUnit <= 0xdbff) cut -= 1;

    const minimumPreferred = Math.floor(limit * 0.55);
    const newline = remaining.lastIndexOf("\n", cut - 1);
    const space = remaining.lastIndexOf(" ", cut - 1);
    const preferred = Math.max(newline, space);
    if (preferred >= minimumPreferred) cut = preferred + 1;
    if (cut <= 0) cut = limit;

    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export type FallbackModelAction =
  | { type: "tool"; call: ToolCall }
  | { type: "final"; content: string };

export function parseJsonFallback(raw: string): FallbackModelAction {
  let candidate = raw.trim();
  const fenced = candidate.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced?.[1] !== undefined) candidate = fenced[1].trim();

  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    throw new Error("Model fallback response was not a single valid JSON object");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Model fallback response must be a JSON object");
  }

  const record = value as Record<string, unknown>;
  if (record.type === "final") {
    if (typeof record.content !== "string" || record.content.length === 0) {
      throw new Error("Final fallback response requires non-empty content");
    }
    return { type: "final", content: record.content };
  }

  const isTool = record.type === "tool" || record.type === "tool_call" || typeof record.tool === "string";
  if (!isTool) throw new Error("Fallback response type must be 'tool' or 'final'");
  const name = typeof record.name === "string" ? record.name : record.tool;
  const args = record.arguments;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Tool fallback response requires a tool name");
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("Tool fallback response requires an arguments object");
  }
  return { type: "tool", call: { name, arguments: args as Record<string, unknown> } };
}

export function compactMessages(
  messages: ChatMessage[],
  maxCharacters: number,
  summary: string,
): ChatMessage[] {
  const size = (items: ChatMessage[]): number => items.reduce((total, item) => total + item.content.length + 80, 0);
  if (size(messages) <= maxCharacters) return messages;

  const retained: ChatMessage[] = [];
  let used = Math.min(summary.length, Math.floor(maxCharacters * 0.25));
  let firstRetainedIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const cost = message.content.length + 80;
    if (retained.length >= 4 && used + cost > maxCharacters) break;
    retained.unshift(message);
    firstRetainedIndex = index;
    used += cost;
  }

  if (retained[0]?.role === "tool") {
    for (let index = firstRetainedIndex - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message === undefined) continue;
      retained.unshift(message);
      if (message.role === "assistant" && message.tool_calls !== undefined) break;
    }
  }

  if (summary.length > 0) {
    retained.unshift({
      role: "user",
      content: `Durable summary of compacted context:\n${truncate(summary, Math.floor(maxCharacters * 0.25))}`,
    });
  }
  return retained;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}
