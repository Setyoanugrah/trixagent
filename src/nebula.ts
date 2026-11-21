import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { decryptFile, encryptFile } from "./crypto.js";
import type { AgentStore } from "./store.js";
import { combineSignals, sleep } from "./utils.js";

export {
  NebulaStateClient,
  NebulaStateConflictError,
  NebulaStateConflictError as NebulaConflictError,
} from "./nebula-state.js";
export type { NebulaStateRecord } from "./nebula-state.js";

export interface NebulaFile {
  id: string;
  name?: string;
  size?: number;
  mime?: string;
  status?: string;
  created_at?: number;
  mimeType?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export function retryDelayMs(headers: Headers, body: unknown, fallbackMs = 1_000): number {
  const header = headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of ["waitMs", "retryAfterMs", "retry_after_ms"]) {
      if (typeof record[key] === "number") return Math.max(0, record[key]);
    }
    for (const key of ["retryAfter", "retry_after", "waitSeconds"]) {
      if (typeof record[key] === "number") return Math.max(0, record[key] * 1_000);
    }
  }
  return fallbackMs;
}

export class NebulaClient {
  private uploadThrottleTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly store: AgentStore,
    private readonly encryptionKey?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  public async me(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.requestJson("GET", "/api/me", undefined, signal);
  }

  public async list(signal?: AbortSignal): Promise<NebulaFile[]> {
    const body = await this.requestJson<unknown>("GET", "/api/files?folder=&q=", undefined, signal);
    if (Array.isArray(body)) return body as NebulaFile[];
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      const files = record.files ?? (typeof record.data === "object" && record.data !== null ? (record.data as Record<string, unknown>).files : undefined);
      if (Array.isArray(files)) return files as NebulaFile[];
    }
    throw new Error("Nebula returned an unexpected file-list response");
  }

  public async uploadFile(
    path: string,
    options: { name?: string; mimeType?: string; encrypt?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let uploadPath = path;
    let cleanupPath: string | undefined;
    let uploadName = options.name ?? basename(path);
    if (options.encrypt) {
      if (!this.encryptionKey) throw new Error("STATE_ENCRYPTION_KEY is required for encrypted Nebula uploads");
      cleanupPath = join(dirname(path), `.${basename(path)}.${Date.now()}.enc`);
      await encryptFile(path, cleanupPath, this.encryptionKey);
      uploadPath = cleanupPath;
      uploadName = `${uploadName}.enc`;
    }

    try {
      await this.reserveUploadSlot(signal);
      const metadata = await stat(uploadPath);
      const init = await this.requestJson<Record<string, unknown>>(
        "POST",
        "/api/upload/init",
        {
          name: uploadName,
          size: metadata.size,
          folder: "",
          mime: options.mimeType ?? "application/octet-stream",
        },
        signal,
      );
      const uploadId = extractId(init);
      if (!uploadId) throw new Error("Nebula upload/init response did not contain an upload ID");
      const waitSeconds = numeric(init.wait);
      if (waitSeconds > 0) await sleep(waitSeconds * 1_000, signal);
      const chunkSize = Math.max(256 * 1024, numeric(init.chunk_size) || 4 * 1024 * 1024);

      const handle = await open(uploadPath, "r");
      const chunk = Buffer.allocUnsafe(chunkSize);
      let offset = 0;
      try {
        while (offset < metadata.size) {
          const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, metadata.size - offset), offset);
          if (bytesRead === 0) throw new Error("Unexpected end of upload file");
          await this.requestBytes(
            "POST",
            `/api/upload/chunk?id=${encodeURIComponent(uploadId)}&offset=${offset}`,
            chunk.subarray(0, bytesRead),
            signal,
          );
          offset += bytesRead;
        }
      } finally {
        await handle.close();
      }

      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await this.rawRequest(
          "POST",
          "/api/upload/finish",
          JSON.stringify({ id: uploadId }),
          "application/json",
          signal,
          false,
        );
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        const status = String(payload.status ?? "").toLowerCase();
        if (response.ok && !["pending", "processing", "retry", "waiting"].includes(status)) return payload;
        if ((response.status === 202 || response.status === 409 || response.status === 429 || response.status >= 500 || ["pending", "processing", "retry", "waiting"].includes(status)) && attempt < 11) {
          await sleep(retryDelayMs(response.headers, payload, Math.min(10_000, 1_000 * (attempt + 1))), signal);
          continue;
        }
        throw new Error(`Nebula upload/finish failed with HTTP ${response.status}`);
      }
      throw new Error("Nebula upload/finish did not complete");
    } finally {
      if (cleanupPath !== undefined) await rm(cleanupPath, { force: true }).catch(() => undefined);
    }
  }

  public async downloadFile(
    id: string,
    destination: string,
    options: { decrypt?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    const temporary = options.decrypt ? `${destination}.${Date.now()}.encrypted` : destination;
    await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
    const candidates = [
      `/api/file/${encodeURIComponent(id)}/download`,
      `/api/files/${encodeURIComponent(id)}/download`,
      `/api/download?id=${encodeURIComponent(id)}`,
    ];
    let response: Response | undefined;
    for (const endpoint of candidates) {
      const candidate = await this.rawRequest("GET", endpoint, undefined, undefined, signal, false);
      if (candidate.ok) {
        response = candidate;
        break;
      }
      if (candidate.status !== 404) throw new Error(`Nebula download failed with HTTP ${candidate.status}`);
    }
    if (!response?.body) throw new Error("Nebula download endpoint was not found or returned no body");

    try {
      await pipeline(
        Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
        createWriteStream(temporary, { mode: 0o600 }),
      );
      if (options.decrypt) {
        if (!this.encryptionKey) throw new Error("STATE_ENCRYPTION_KEY is required to decrypt Nebula files");
        await decryptFile(temporary, destination, this.encryptionKey);
      }
    } finally {
      if (options.decrypt) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async reserveUploadSlot(signal?: AbortSignal): Promise<void> {
    const previousReservation = this.uploadThrottleTail;
    let release!: () => void;
    this.uploadThrottleTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previousReservation;
    try {
      const key = "nebula_last_upload_at";
      const previous = Number((await this.store.getKv(key)) ?? "0");
      const wait = previous + 60_000 - Date.now();
      if (wait > 0) await sleep(wait, signal);
      await this.store.setKv(key, String(Date.now()));
    } finally {
      release();
    }
  }

  private async requestJson<T = Record<string, unknown>>(
    method: string,
    endpoint: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await this.rawRequest(
        method,
        endpoint,
        body === undefined ? undefined : JSON.stringify(body),
        body === undefined ? undefined : "application/json",
        signal,
        false,
      );
      const payload = (await response.json().catch(() => ({}))) as T;
      if (response.ok) return payload;
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        await sleep(retryDelayMs(response.headers, payload, (attempt + 1) * 1_000), signal);
        continue;
      }
      throw new Error(`Nebula ${method} ${endpoint.split("?")[0]} failed with HTTP ${response.status}`);
    }
    throw new Error("Nebula request failed after retries");
  }

  private async requestBytes(method: string, endpoint: string, body: Uint8Array, signal?: AbortSignal): Promise<void> {
    const payload = new ArrayBuffer(body.byteLength);
    new Uint8Array(payload).set(body);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await this.rawRequest(method, endpoint, payload, "application/octet-stream", signal, false);
      if (response.ok) return;
      const errorPayload = await response.json().catch(() => ({}));
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        await sleep(retryDelayMs(response.headers, errorPayload, (attempt + 1) * 1_000), signal);
        continue;
      }
      throw new Error(`Nebula chunk upload failed with HTTP ${response.status}`);
    }
  }

  private async rawRequest(
    method: string,
    endpoint: string,
    body?: BodyInit,
    contentType?: string,
    signal?: AbortSignal,
    throwOnFailure = true,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "X-API-Key": this.apiKey,
    };
    if (contentType !== undefined) headers["Content-Type"] = contentType;
    const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: combineSignals(signal, AbortSignal.timeout(5 * 60_000)),
    });
    if (throwOnFailure && !response.ok) throw new Error(`Nebula request failed with HTTP ${response.status}`);
    return response;
  }
}

function extractId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["id", "uploadId", "upload_id"]) {
    if (typeof record[key] === "string" || typeof record[key] === "number") return String(record[key]);
  }
  for (const key of ["data", "upload"]) {
    const nested = extractId(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function numeric(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
