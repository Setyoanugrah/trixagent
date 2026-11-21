import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Logger } from "./logger.js";
import { resolveConfinedPath } from "./security.js";
import { combineSignals, errorMessage, sleep, splitTelegramMessage } from "./utils.js";

export interface TelegramUser {
  id: number;
  username?: string;
}

export interface TelegramChat {
  id: number;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
  width: number;
  height: number;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface SavedAttachment {
  relativePath: string;
  absolutePath: string;
  originalName: string;
  mimeType: string;
  size: number;
  kind: "photo" | "document";
}

export class TelegramClient {
  private readonly apiBase: string;
  private readonly fileBase: string;

  public constructor(
    private readonly token: string,
    private readonly workspaceRoot: string,
    private readonly maxAttachmentBytes: number,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.apiBase = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
  }

  public async getUpdates(offset: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      { offset, timeout: 45, allowed_updates: ["message", "callback_query"] },
      signal,
      55_000,
    );
  }

  public async sendMessage(
    chatId: string | number,
    text: string,
    buttons?: InlineButton[][],
    signal?: AbortSignal,
  ): Promise<TelegramMessage> {
    const payload: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
    if (buttons !== undefined) payload.reply_markup = { inline_keyboard: buttons };
    return this.call<TelegramMessage>("sendMessage", payload, signal);
  }

  public async sendLongMessage(chatId: string | number, text: string, signal?: AbortSignal): Promise<void> {
    for (const chunk of splitTelegramMessage(text)) await this.sendMessage(chatId, chunk, undefined, signal);
  }

  public async sendTyping(chatId: string | number, signal?: AbortSignal): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action: "typing" }, signal);
  }

  public startTyping(chatId: string | number, signal?: AbortSignal): () => void {
    const send = (): void => {
      void this.sendTyping(chatId, signal).catch((error) => {
        if (!signal?.aborted) this.logger.debug("telegram.typing_failed", { error: errorMessage(error) });
      });
    };
    send();
    const timer = setInterval(send, 4_500);
    timer.unref();
    return () => clearInterval(timer);
  }

  public async answerCallbackQuery(id: string, text?: string, signal?: AbortSignal): Promise<void> {
    const payload: Record<string, unknown> = { callback_query_id: id };
    if (text !== undefined) payload.text = text;
    await this.call("answerCallbackQuery", payload, signal);
  }

  public async sendPhoto(
    chatId: string | number,
    data: Uint8Array,
    filename: string,
    caption?: string,
    signal?: AbortSignal,
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    const photo = new ArrayBuffer(data.byteLength);
    new Uint8Array(photo).set(data);
    form.set("photo", new Blob([photo]), filename);
    if (caption !== undefined) form.set("caption", caption.slice(0, 1024));
    return this.callMultipart<TelegramMessage>("sendPhoto", form, signal);
  }

  public async saveInboundAttachment(message: TelegramMessage, updateId: number, signal?: AbortSignal): Promise<SavedAttachment | undefined> {
    let fileId: string;
    let originalName: string;
    let mimeType: string;
    let kind: "photo" | "document";
    let declaredSize: number | undefined;

    if (message.document !== undefined) {
      fileId = message.document.file_id;
      originalName = sanitizeFilename(message.document.file_name ?? `document-${updateId}`);
      mimeType = message.document.mime_type ?? "application/octet-stream";
      kind = "document";
      declaredSize = message.document.file_size;
    } else if (message.photo !== undefined && message.photo.length > 0) {
      const largest = [...message.photo].sort((a, b) => (b.file_size ?? b.width * b.height) - (a.file_size ?? a.width * a.height))[0];
      if (largest === undefined) return undefined;
      fileId = largest.file_id;
      originalName = `photo-${updateId}.jpg`;
      mimeType = "image/jpeg";
      kind = "photo";
      declaredSize = largest.file_size;
    } else {
      return undefined;
    }

    if (declaredSize !== undefined && declaredSize > this.maxAttachmentBytes) {
      throw new Error(`Attachment is too large (${declaredSize} bytes)`);
    }
    const file = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId }, signal);
    if (!file.file_path) throw new Error("Telegram did not return an attachment path");
    if (file.file_size !== undefined && file.file_size > this.maxAttachmentBytes) throw new Error(`Attachment is too large (${file.file_size} bytes)`);

    const response = await this.fetchImpl(`${this.fileBase}/${file.file_path}`, {
      signal: combineSignals(signal, AbortSignal.timeout(120_000)),
    });
    if (!response.ok) throw new Error(`Telegram attachment download failed with HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > this.maxAttachmentBytes) throw new Error(`Attachment is too large (${length} bytes)`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > this.maxAttachmentBytes) throw new Error(`Attachment is too large (${data.length} bytes)`);

    const relativeDirectory = join(".agent", "inbox");
    const directory = await resolveConfinedPath(this.workspaceRoot, relativeDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const suffix = extname(originalName).slice(0, 16);
    const relativePath = join(relativeDirectory, `${updateId}-${kind}${suffix}`);
    const absolutePath = await resolveConfinedPath(this.workspaceRoot, relativePath);
    await writeFile(absolutePath, data, { mode: 0o600 });
    return { relativePath, absolutePath, originalName, mimeType, size: data.length, kind };
  }

  private async call<T>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await this.fetchImpl(`${this.apiBase}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: combineSignals(signal, AbortSignal.timeout(timeoutMs)),
      });
      const body = (await response.json().catch(() => ({}))) as TelegramResponse<T>;
      if (response.ok && body.ok && body.result !== undefined) return body.result;
      const retryAfter = body.parameters?.retry_after;
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await sleep((retryAfter ?? attempt + 1) * 1000, signal);
        continue;
      }
      throw new Error(`Telegram ${method} failed: ${body.description ?? `HTTP ${response.status}`}`);
    }
    throw new Error(`Telegram ${method} failed after retries`);
  }

  private async callMultipart<T>(method: string, form: FormData, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}/${method}`, {
      method: "POST",
      body: form,
      signal: combineSignals(signal, AbortSignal.timeout(120_000)),
    });
    const body = (await response.json().catch(() => ({}))) as TelegramResponse<T>;
    if (!response.ok || !body.ok || body.result === undefined) {
      throw new Error(`Telegram ${method} failed: ${body.description ?? `HTTP ${response.status}`}`);
    }
    return body.result;
  }
}

function sanitizeFilename(value: string): string {
  const cleaned = basename(value).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 120) || "attachment";
}
