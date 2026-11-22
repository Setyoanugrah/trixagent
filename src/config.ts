import { hostname } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

export interface AgentConfig {
  telegramToken: string;
  telegramOwnerId: number;
  nebulaApiKey: string;
  nebulaBaseUrl: string;
  groqApiKey: string;
  geminiApiKey: string;
  agentModel: string;
  visionModel: string;
  geminiFallbackModel: string;
  workspaceRoot: string;
  runnerId: string;
  leaseName: string;
  leaseTtlSeconds: number;
  leaseHeartbeatSeconds: number;
  maxIterations: number;
  maxContextTokens: number;
  maxToolOutputBytes: number;
  shellTimeoutMs: number;
  maxAttachmentBytes: number;
  unsafeAuto: boolean;
  chromiumExecutablePath?: string;
  browserHeadless: boolean;
  stateEncryptionKey?: string;
  snapshotOnShutdown: boolean;
  snapshotIntervalMinutes: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${key}`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum = 1): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${key} must be an integer >= ${minimum}`);
  return value;
}

function boolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${key} must be true or false`);
}

function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function normalizedUrl(value: string, key: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${key} must use HTTP or HTTPS`);
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const owner = Number(required(env, "TELEGRAM_OWNER_ID"));
  if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("TELEGRAM_OWNER_ID must be a positive numeric ID");
  const ttl = integer(env, "LEASE_TTL_SECONDS", 90, 30);
  const heartbeat = integer(env, "LEASE_HEARTBEAT_SECONDS", 25, 5);
  if (heartbeat * 2 >= ttl) throw new Error("LEASE_HEARTBEAT_SECONDS must be less than half LEASE_TTL_SECONDS");

  return {
    telegramToken: required(env, "TELEGRAM_BOT_TOKEN"),
    telegramOwnerId: owner,
    nebulaApiKey: required(env, "NEBULA_API_KEY"),
    nebulaBaseUrl: normalizedUrl(env.NEBULA_BASE_URL ?? "https://drive.rikuzetsi.my.id", "NEBULA_BASE_URL"),
    groqApiKey: required(env, "GROQ_API_KEY"),
    geminiApiKey: required(env, "GEMINI_API_KEY"),
    agentModel: env.AGENT_MODEL?.trim() || "openai/gpt-oss-120b",
    visionModel: env.VISION_MODEL?.trim() || "gemini-3.5-flash",
    geminiFallbackModel: env.GEMINI_FALLBACK_MODEL?.trim() || "gemini-3.1-flash-lite",
    workspaceRoot: resolve(env.WORKSPACE_ROOT?.trim() || process.cwd()),
    runnerId: env.RUNNER_ID?.trim() || `${hostname()}-${process.pid}-${randomBytes(4).toString("hex")}`,
    leaseName: env.LEASE_NAME?.trim() || "telegram-autonomous-agent",
    leaseTtlSeconds: ttl,
    leaseHeartbeatSeconds: heartbeat,
    maxIterations: integer(env, "AGENT_MAX_ITERATIONS", 16, 1),
    maxContextTokens: integer(env, "AGENT_MAX_CONTEXT_TOKENS", 32_768, 2_048),
    maxToolOutputBytes: integer(env, "MAX_TOOL_OUTPUT_BYTES", 48_000, 1_024),
    shellTimeoutMs: integer(env, "SHELL_TIMEOUT_MS", 120_000, 1_000),
    maxAttachmentBytes: integer(env, "MAX_ATTACHMENT_BYTES", 20 * 1024 * 1024, 1_024),
    unsafeAuto: boolean(env, "AGENT_UNSAFE_AUTO", false),
    chromiumExecutablePath: optional(env, "CHROMIUM_EXECUTABLE_PATH"),
    browserHeadless: boolean(env, "BROWSER_HEADLESS", true),
    stateEncryptionKey: optional(env, "STATE_ENCRYPTION_KEY"),
    snapshotOnShutdown: boolean(env, "NEBULA_SNAPSHOT_ON_SHUTDOWN", false),
    snapshotIntervalMinutes: integer(env, "NEBULA_SNAPSHOT_INTERVAL_MINUTES", 30, 5),
  };
}

export function configuredSecrets(config: AgentConfig): string[] {
  return [
    config.telegramToken,
    config.nebulaApiKey,
    config.groqApiKey,
    config.geminiApiKey,
    config.stateEncryptionKey,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}
