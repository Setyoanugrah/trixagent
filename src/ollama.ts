import type { ChatMessage, ModelToolCall, ToolCall, ToolDefinition } from "./types.js";
import { combineSignals, parseJsonFallback, sleep } from "./utils.js";

interface OllamaResponse {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: ModelToolCall[];
  };
  error?: string;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface ModelDecision {
  assistant: ChatMessage;
  calls: ToolCall[];
  final?: string;
  usage: { promptTokens?: number; completionTokens?: number };
  mode: "native" | "json";
}

export class OllamaClient {
  private nativeToolsSupported: boolean | undefined;

  public constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly visionModel: string,
    private readonly contextTokens: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  public async decide(messages: ChatMessage[], tools: ToolDefinition[], signal?: AbortSignal): Promise<ModelDecision> {
    if (this.nativeToolsSupported !== false) {
      try {
        const response = await this.request(
          {
            model: this.model,
            messages,
            tools,
            stream: false,
            options: { num_ctx: this.contextTokens },
          },
          signal,
        );
        this.nativeToolsSupported = true;
        const content = response.message?.content ?? "";
        const nativeCalls = response.message?.tool_calls ?? [];
        const calls = nativeCalls.map(normalizeNativeToolCall);
        const assistant: ChatMessage = { role: "assistant", content };
        if (nativeCalls.length > 0) assistant.tool_calls = nativeCalls;
        return {
          assistant,
          calls,
          ...(calls.length === 0 ? { final: content || "The model returned an empty response." } : {}),
          usage: { promptTokens: response.prompt_eval_count, completionTokens: response.eval_count },
          mode: "native",
        };
      } catch (error) {
        if (!(error instanceof OllamaHttpError) || ![400, 404, 422].includes(error.status)) throw error;
        this.nativeToolsSupported = false;
      }
    }

    const fallbackInstruction: ChatMessage = {
      role: "system",
      content:
        "Native tool calls are unavailable. Return exactly one JSON object and no prose or markdown. " +
        'For a tool call: {"type":"tool","name":"tool.name","arguments":{...}}. ' +
        'For a final response: {"type":"final","content":"..."}.',
    };
    const response = await this.request(
      {
        model: this.model,
        messages: [fallbackInstruction, ...messages],
        stream: false,
        format: "json",
        options: { num_ctx: this.contextTokens },
      },
      signal,
    );
    const raw = response.message?.content ?? "";
    const parsed = parseJsonFallback(raw);
    if (parsed.type === "final") {
      return {
        assistant: { role: "assistant", content: parsed.content },
        calls: [],
        final: parsed.content,
        usage: { promptTokens: response.prompt_eval_count, completionTokens: response.eval_count },
        mode: "json",
      };
    }
    const toolCall: ModelToolCall = { function: { name: parsed.call.name, arguments: parsed.call.arguments } };
    return {
      assistant: { role: "assistant", content: raw, tool_calls: [toolCall] },
      calls: [parsed.call],
      usage: { promptTokens: response.prompt_eval_count, completionTokens: response.eval_count },
      mode: "json",
    };
  }

  public async inspectImage(base64: string, prompt: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request(
      {
        model: this.visionModel,
        messages: [{ role: "user", content: prompt, images: [base64] }],
        stream: false,
        options: { num_ctx: Math.min(this.contextTokens, 16_384) },
      },
      signal,
    );
    const content = response.message?.content?.trim();
    if (!content) throw new Error("Vision model returned an empty response");
    return content;
  }

  public modelName(): string {
    return this.model;
  }

  public visionModelName(): string {
    return this.visionModel;
  }

  private async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<OllamaResponse> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: combineSignals(signal, AbortSignal.timeout(10 * 60_000)),
      });
      const payload = (await response.json().catch(() => ({}))) as OllamaResponse;
      if (response.ok && !payload.error) return payload;
      if (response.status >= 500 && attempt < 2) {
        await sleep((attempt + 1) * 1_000, signal);
        continue;
      }
      throw new OllamaHttpError(response.status, payload.error ?? `HTTP ${response.status}`);
    }
    throw new Error("Ollama request failed after retries");
  }
}

class OllamaHttpError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(`Ollama request failed: ${message}`);
    this.name = "OllamaHttpError";
  }
}

function normalizeNativeToolCall(call: ModelToolCall): ToolCall {
  const name = call.function?.name;
  if (typeof name !== "string" || name.length === 0) throw new Error("Ollama returned a tool call without a name");
  let args = call.function.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args) as Record<string, unknown>;
    } catch {
      throw new Error(`Ollama returned invalid arguments for ${name}`);
    }
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error(`Ollama returned non-object arguments for ${name}`);
  return { id: call.id, name, arguments: args };
}
