import assert from "node:assert/strict";
import test from "node:test";
import { configuredSecrets, loadConfig } from "../src/config.js";
import { retryDelayMs } from "../src/nebula.js";
import { SecretRedactor, sanitizedChildEnvironment } from "../src/security.js";
import { compactMessages } from "../src/utils.js";

test("configuration requires cloud providers and retains model/context defaults", () => {
  const base = {
    TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz",
    TELEGRAM_OWNER_ID: "123456",
  };
  assert.throws(() => loadConfig(base), /NEBULA_API_KEY/);
  assert.throws(() => loadConfig({ ...base, NEBULA_API_KEY: "test-nebula-key" }), /GROQ_API_KEY/);
  assert.throws(() => loadConfig({ ...base, NEBULA_API_KEY: "test-nebula-key", GROQ_API_KEY: "test-groq-key" }), /GEMINI_API_KEY/);
  const config = loadConfig({
    ...base,
    NEBULA_API_KEY: "test-nebula-key",
    GROQ_API_KEY: "test-groq-key",
    GEMINI_API_KEY: "test-gemini-key",
  });
  assert.equal(config.agentModel, "openai/gpt-oss-120b");
  assert.equal(config.visionModel, "gemini-3.5-flash");
  assert.equal(config.geminiFallbackModel, "gemini-3.1-flash-lite");
  assert.equal(config.maxContextTokens, 32_768);
  const redacted = new SecretRedactor(configuredSecrets(config)).redactText("test-groq-key test-gemini-key");
  assert.equal(redacted, "[REDACTED] [REDACTED]");
});

test("retryDelayMs honors numeric headers and JSON wait hints", () => {
  assert.equal(retryDelayMs(new Headers({ "retry-after": "3" }), {}), 3_000);
  assert.equal(retryDelayMs(new Headers(), { waitMs: 2500 }), 2_500);
  assert.equal(retryDelayMs(new Headers(), {}, 777), 777);
});

test("secret redaction and child environment exclude credentials", () => {
  const redactor = new SecretRedactor(["actual-secret-token"]);
  const output = redactor.redactText(
    "Authorization: Bearer abcdefghijklmnop and actual-secret-token\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
  );
  assert.doesNotMatch(output, /actual-secret-token|abcdefghijklmnop|private-material/);

  const env = sanitizedChildEnvironment(process.cwd());
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(env.NEBULA_API_KEY, undefined);
  assert.equal(env.GROQ_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.HOME, process.cwd());
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
});

test("context compaction retains recent messages and durable summary", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: "user" as const,
    content: `message-${index}-${"x".repeat(100)}`,
  }));
  const compacted = compactMessages(messages, 700, "important durable state");
  assert.ok(compacted.length < messages.length);
  assert.match(compacted[0]?.content ?? "", /important durable state/);
  assert.match(compacted.at(-1)?.content ?? "", /message-19/);
});
