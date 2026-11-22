import assert from "node:assert/strict";
import test from "node:test";
import { inferImageMimeType, ModelClient } from "../src/model.js";
import type { ChatMessage, ToolDefinition } from "../src/types.js";

const GROQ_KEY = "gsk_test_groq_secret_1234567890";
const GEMINI_KEY = "AIzaTestGeminiSecret1234567890";
const TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "git.status",
    description: "Read repository status",
    parameters: {
      type: "object",
      properties: { cwd: { type: "string" } },
      additionalProperties: false,
    },
  },
};

test("Groq maps native messages and preserves tool call IDs", async () => {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json({
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_next",
            type: "function",
            function: { name: "git_status", arguments: '{"cwd":"."}' },
          }],
        },
      }],
      usage: { prompt_tokens: 21, completion_tokens: 7 },
    });
  };
  const client = new ModelClient(
    GROQ_KEY,
    GEMINI_KEY,
    "openai/gpt-oss-120b",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    mockFetch,
    0,
  );
  const messages: ChatMessage[] = [
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_previous", function: { name: "git.status", arguments: { cwd: "repo" } } }],
    },
    { role: "tool", content: "clean", tool_name: "git.status", tool_call_id: "call_previous" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "git.status", arguments: { cwd: "legacy" } } }],
    },
    { role: "tool", content: "legacy clean", tool_name: "git.status" },
    { role: "user", content: `Check again without exposing ${GROQ_KEY} or ${GEMINI_KEY}.` },
  ];

  const decision = await client.decide(messages, [TOOL]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(requests[0]?.headers.get("authorization"), `Bearer ${GROQ_KEY}`);
  const requestBody = requests[0]?.body as {
    messages: Array<Record<string, unknown>>;
    tools: ToolDefinition[];
    tool_choice: string;
    temperature: number;
    max_completion_tokens: number;
  };
  assert.equal(requestBody.tool_choice, "auto");
  assert.equal(requestBody.temperature, 0.1);
  assert.equal(requestBody.max_completion_tokens, 4_096);
  assert.equal(requestBody.tools[0]?.function.name, "git_status");
  assert.deepEqual(requestBody.messages[0]?.tool_calls, [{
    id: "call_previous",
    type: "function",
    function: { name: "git_status", arguments: '{"cwd":"repo"}' },
  }]);
  assert.equal(requestBody.messages[1]?.tool_call_id, "call_previous");
  assert.deepEqual(requestBody.messages[2]?.tool_calls, [{
    id: "call_legacy_2_0",
    type: "function",
    function: { name: "git_status", arguments: '{"cwd":"legacy"}' },
  }]);
  assert.equal(requestBody.messages[3]?.tool_call_id, "call_legacy_2_0");
  assert.doesNotMatch(JSON.stringify(requestBody), new RegExp(`${GROQ_KEY}|${GEMINI_KEY}`));
  assert.deepEqual(decision.calls, [{ id: "call_next", name: "git.status", arguments: { cwd: "." } }]);
  assert.equal(decision.assistant.tool_calls?.[0]?.id, "call_next");
  assert.deepEqual(decision.usage, { promptTokens: 21, completionTokens: 7 });
  assert.equal(decision.mode, "native");
});

test("Groq retries retryable failures then uses Gemini strict JSON fallback", async () => {
  let groqRequests = 0;
  const geminiBodies: Array<Record<string, unknown>> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("api.groq.com")) {
      groqRequests += 1;
      return Response.json(
        { error: { message: `temporary failure without ${GROQ_KEY}` } },
        { status: 503, headers: { "Retry-After": "0" } },
      );
    }
    geminiBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({
      candidates: [{
        content: { parts: [{ text: '{"type":"tool","name":"git.status","arguments":{"cwd":"."}}' }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 9 },
    });
  };
  const client = new ModelClient(
    GROQ_KEY,
    GEMINI_KEY,
    "openai/gpt-oss-120b",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    mockFetch,
    0,
  );

  const decision = await client.decide([{ role: "user", content: `Run status; ignore ${GEMINI_KEY}.` }], [TOOL]);

  assert.equal(groqRequests, 3);
  assert.equal(geminiBodies.length, 1);
  const generationConfig = geminiBodies[0]?.generationConfig as Record<string, unknown>;
  assert.equal(generationConfig.responseMimeType, "application/json");
  const contents = geminiBodies[0]?.contents as Array<{ parts: Array<{ text: string }> }>;
  assert.match(contents[0]?.parts[0]?.text ?? "", /Available tools/);
  assert.match(contents[0]?.parts[0]?.text ?? "", /git\.status/);
  assert.doesNotMatch(JSON.stringify(geminiBodies[0]), new RegExp(`${GROQ_KEY}|${GEMINI_KEY}`));
  assert.equal(decision.mode, "json");
  assert.equal(decision.calls[0]?.name, "git.status");
  assert.match(decision.calls[0]?.id ?? "", /^call_gemini_/);
  assert.equal(decision.assistant.tool_calls?.[0]?.id, decision.calls[0]?.id);
  assert.deepEqual(decision.usage, { promptTokens: 30, completionTokens: 9 });
});

test("Groq HTTP 413 falls back to Gemini without retrying", async () => {
  let groqRequests = 0;
  let geminiRequests = 0;
  const mockFetch: typeof fetch = async (input) => {
    if (String(input).includes("api.groq.com")) {
      groqRequests += 1;
      return Response.json({ error: { message: "TPM limit 8000, requested 24000" } }, { status: 413 });
    }
    geminiRequests += 1;
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"type":"final","content":"fallback ok"}' }] } }] });
  };
  const client = new ModelClient(
    GROQ_KEY,
    GEMINI_KEY,
    "openai/gpt-oss-120b",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    mockFetch,
    0,
  );

  const decision = await client.decide([{ role: "user", content: "large request" }], [TOOL]);
  assert.equal(groqRequests, 1);
  assert.equal(geminiRequests, 1);
  assert.equal(decision.final, "fallback ok");
});

test("oversized prompts route directly to Gemini", async () => {
  let groqRequests = 0;
  let geminiRequests = 0;
  const mockFetch: typeof fetch = async (input) => {
    if (String(input).includes("api.groq.com")) groqRequests += 1;
    else geminiRequests += 1;
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"type":"final","content":"large ok"}' }] } }] });
  };
  const client = new ModelClient(
    GROQ_KEY,
    GEMINI_KEY,
    "openai/gpt-oss-120b",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    mockFetch,
    0,
  );

  const decision = await client.decide([{ role: "user", content: "x".repeat(30_000) }], [TOOL]);
  assert.equal(groqRequests, 0);
  assert.equal(geminiRequests, 1);
  assert.equal(decision.final, "large ok");
});

test("Gemini vision falls back to the lite model and sends detected MIME", async () => {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const request = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    requests.push(request);
    if (request.url.includes("gemini-3.5-flash")) {
      return Response.json({ error: { message: "model unavailable" } }, { status: 404 });
    }
    return Response.json({
      candidates: [{ content: { parts: [{ text: "Visible login form" }] }, finishReason: "STOP" }],
    });
  };
  const client = new ModelClient(
    GROQ_KEY,
    GEMINI_KEY,
    "openai/gpt-oss-120b",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    mockFetch,
    0,
  );
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString("base64");

  assert.equal(await client.inspectImage(png, "Inspect this image"), "Visible login form");
  assert.equal(requests.length, 2);
  assert.match(requests[0]?.url ?? "", /gemini-3\.5-flash:generateContent$/);
  assert.match(requests[1]?.url ?? "", /gemini-3\.1-flash-lite:generateContent$/);
  assert.equal(requests[1]?.headers.get("x-goog-api-key"), GEMINI_KEY);
  const contents = requests[1]?.body.contents as Array<{
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
  }>;
  assert.equal(contents[0]?.parts[1]?.inlineData?.mimeType, "image/png");
  assert.equal(contents[0]?.parts[1]?.inlineData?.data, png);
});

test("image MIME detection recognizes PNG, JPEG, and WebP magic bytes", () => {
  assert.equal(inferImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(inferImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(inferImageMimeType(Buffer.from("RIFFxxxxWEBP", "ascii")), "image/webp");
  assert.throws(() => inferImageMimeType(Buffer.from("GIF89a", "ascii")), /Unsupported image format/);
});
