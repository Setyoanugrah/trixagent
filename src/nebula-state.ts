import type { Logger } from "./logger.js";
import type { LeaseRecord } from "./types.js";
import { combineSignals, sleep } from "./utils.js";

const REQUEST_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;

export interface NebulaStateRecord<T> {
  key: string;
  version: number;
  value: T;
  updated_at: string;
}

export class NebulaStateConflictError extends Error {
  public readonly status = 409;

  public constructor() {
    super("Nebula state write conflicted");
    this.name = "NebulaStateConflictError";
  }
}

interface TransportResult {
  response: Response;
  payload: unknown;
}

export class NebulaStateClient {
  private readonly baseUrl: string;

  public constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  public async getState<T>(key: string, signal?: AbortSignal): Promise<NebulaStateRecord<T> | undefined> {
    const result = await this.request(
      "GET",
      `/api/agent/state/${encodeURIComponent(key)}`,
      "state.get",
      undefined,
      signal,
      new Set([404]),
    );
    if (result.response.status === 404) return undefined;
    return parseStateRecord<T>(result.payload, key);
  }

  public async putState<T>(
    key: string,
    version: number | null,
    value: T,
    signal?: AbortSignal,
  ): Promise<NebulaStateRecord<T>> {
    const result = await this.request(
      "PUT",
      `/api/agent/state/${encodeURIComponent(key)}`,
      "state.put",
      { version, value },
      signal,
      new Set([409]),
    );
    if (result.response.status === 409) throw new NebulaStateConflictError();
    const echoed = tryParseStateRecord<T>(result.payload, key);
    if (echoed) return echoed;
    const metadata = unwrapRecord(result.payload, "state");
    if (metadata && Number.isSafeInteger(metadata.version)) {
      if (typeof metadata.key === "string" && metadata.key !== key) {
        throw new Error("Nebula state response key did not match the request");
      }
      return {
        key,
        version: metadata.version as number,
        value,
        updated_at: typeof metadata.updated_at === "string" ? metadata.updated_at : "",
      };
    }
    const stored = await this.getState<T>(key, signal);
    if (!stored) throw new Error("Nebula state write succeeded but the stored value could not be read");
    return stored;
  }

  public async getLease(name: string, signal?: AbortSignal): Promise<LeaseRecord | undefined> {
    const result = await this.request(
      "GET",
      `/api/agent/lease/${encodeURIComponent(name)}`,
      "lease.get",
      undefined,
      signal,
      new Set([404]),
    );
    if (result.response.status === 404) return undefined;
    return parseLeaseRecord(result.payload, name);
  }

  public async acquireLease(name: string, holderId: string, ttlSeconds: number, signal?: AbortSignal): Promise<boolean> {
    return this.leaseAction(name, "acquire", holderId, ttlSeconds, signal);
  }

  public async renewLease(name: string, holderId: string, ttlSeconds: number, signal?: AbortSignal): Promise<boolean> {
    return this.leaseAction(name, "renew", holderId, ttlSeconds, signal);
  }

  public async releaseLease(name: string, holderId: string, ttlSeconds: number, signal?: AbortSignal): Promise<boolean> {
    return this.leaseAction(name, "release", holderId, ttlSeconds, signal);
  }

  private async leaseAction(
    name: string,
    action: "acquire" | "renew" | "release",
    holderId: string,
    ttlSeconds: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.request(
      "POST",
      `/api/agent/lease/${encodeURIComponent(name)}/${action}`,
      `lease.${action}`,
      { holder_id: holderId, ttl_seconds: ttlSeconds },
      signal,
      new Set([404, 409, 423]),
    );
    if ([404, 409, 423].includes(result.response.status)) return false;
    if (typeof result.payload === "object" && result.payload !== null) {
      const payload = result.payload as Record<string, unknown>;
      const flag = payload[action === "acquire" ? "acquired" : action === "renew" ? "renewed" : "released"];
      if (flag === false) return false;
      if (payload.success === false) return false;
    }
    return true;
  }

  private async request(
    method: "GET" | "PUT" | "POST",
    endpoint: string,
    operation: string,
    body?: unknown,
    signal?: AbortSignal,
    acceptedStatuses = new Set<number>(),
  ): Promise<TransportResult> {
    for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "X-API-Key": this.apiKey,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: combineSignals(signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (attempt < REQUEST_ATTEMPTS - 1) {
          this.logger.warn("nebula_state.retry", { operation, attempt: attempt + 1, reason: transportReason(error) });
          await sleep(retryBackoffMs(attempt), signal);
          continue;
        }
        throw new Error(`Nebula ${operation} failed after retries`);
      }

      const payload = await response.json().catch(() => undefined);
      if (response.ok || acceptedStatuses.has(response.status)) return { response, payload };
      if ((response.status === 429 || response.status >= 500) && attempt < REQUEST_ATTEMPTS - 1) {
        this.logger.warn("nebula_state.retry", { operation, attempt: attempt + 1, status: response.status });
        await sleep(retryDelayMs(response.headers, payload, retryBackoffMs(attempt)), signal);
        continue;
      }
      throw new Error(`Nebula ${operation} failed with HTTP ${response.status}`);
    }
    throw new Error(`Nebula ${operation} failed after retries`);
  }
}

function parseStateRecord<T>(payload: unknown, expectedKey: string): NebulaStateRecord<T> {
  const record = tryParseStateRecord<T>(payload, expectedKey);
  if (!record) throw new Error("Nebula state response had an invalid shape");
  return record;
}

function tryParseStateRecord<T>(payload: unknown, expectedKey: string): NebulaStateRecord<T> | undefined {
  const record = unwrapRecord(payload, "state");
  if (!record || typeof record.key !== "string" || !Number.isSafeInteger(record.version) || !("value" in record)) return undefined;
  if (record.key !== expectedKey) throw new Error("Nebula state response key did not match the request");
  return {
    key: record.key,
    version: record.version as number,
    value: record.value as T,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : "",
  };
}

function parseLeaseRecord(payload: unknown, expectedName: string): LeaseRecord | undefined {
  const record = unwrapRecord(payload, "lease");
  if (!record) return undefined;
  const holder = record.holder_id ?? record.holderId;
  if (typeof holder !== "string" || holder.length === 0) return undefined;
  return {
    name: typeof record.name === "string" ? record.name : expectedName,
    holder_id: holder,
    acquired_at: timestamp(record.acquired_at ?? record.acquiredAt),
    expires_at: timestamp(record.expires_at ?? record.expiresAt),
    contender_id: typeof (record.contender_id ?? record.contenderId) === "string"
      ? String(record.contender_id ?? record.contenderId)
      : null,
    contender_seen_at: nullableTimestamp(record.contender_seen_at ?? record.contenderSeenAt),
  };
}

function unwrapRecord(payload: unknown, nestedKey: string): Record<string, unknown> | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const root = payload as Record<string, unknown>;
  const nested = root[nestedKey] ?? root.data;
  if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) return nested as Record<string, unknown>;
  if (nested === null) return undefined;
  return root;
}

function timestamp(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1_000_000_000_000 ? value * 1_000 : value).toISOString();
  }
  return "";
}

function nullableTimestamp(value: unknown): string | null {
  const result = timestamp(value);
  return result || null;
}

function transportReason(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return "network_error";
}

function retryBackoffMs(attempt: number): number {
  return Math.min(2_000, 200 * (2 ** attempt));
}

function retryDelayMs(headers: Headers, payload: unknown, fallback: number): number {
  const header = headers.get("retry-after");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (typeof record.retry_after_ms === "number") return Math.max(0, record.retry_after_ms);
    if (typeof record.retry_after === "number") return Math.max(0, record.retry_after * 1_000);
  }
  return fallback;
}
