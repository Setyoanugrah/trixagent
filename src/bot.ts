import type { AgentEngine } from "./agent.js";
import type { BrowserManager } from "./browser.js";
import type { AgentConfig } from "./config.js";
import type { LeaseManager } from "./lease.js";
import type { Logger } from "./logger.js";
import type { OllamaClient } from "./ollama.js";
import type { SecretRedactor } from "./security.js";
import type { AgentStore } from "./store.js";
import type { TelegramCallbackQuery, TelegramClient, TelegramMessage, TelegramUpdate } from "./telegram.js";
import type { ApprovalRecord } from "./types.js";
import { errorMessage, isAbortError, sleep, truncate } from "./utils.js";

export class TelegramBotController {
  private readonly startedAt = Date.now();

  public constructor(
    private readonly config: AgentConfig,
    private readonly telegram: TelegramClient,
    private readonly store: AgentStore,
    private readonly lease: LeaseManager,
    private readonly engine: AgentEngine,
    private readonly browser: BrowserManager,
    private readonly ollama: OllamaClient,
    private readonly logger: Logger,
    private readonly redactor: SecretRedactor,
  ) {}

  public async poll(signal: AbortSignal): Promise<void> {
    let offset = await this.store.telegramOffset();
    let failures = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.telegram.getUpdates(offset, signal);
        failures = 0;
        for (const update of updates) {
          if (update.update_id < offset) continue;
          await this.processUpdate(update, signal);
          offset = update.update_id + 1;
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) break;
        failures += 1;
        this.logger.warn("telegram.poll_failed", { failures, error: errorMessage(error) });
        await sleep(Math.min(30_000, failures * 1_000), signal).catch(() => undefined);
      }
    }
  }

  public async restorePendingApprovals(signal?: AbortSignal): Promise<void> {
    const approvals = await this.store.listUnannouncedApprovals();
    for (const approval of approvals) {
      const nonce = await this.store.rotateApprovalNonce(approval.id);
      const toolRun = await this.store.getToolRun(approval.tool_run_id);
      const displayArgs = toolRun
        ? truncate(this.redactor.redactText(toolRun.arguments_json), 1_400)
        : "[tool arguments unavailable]";
      const message = await this.telegram.sendMessage(
        approval.chat_id,
        `Approval still required after runner restart\nTool: ${toolRun?.tool_name ?? "unknown"}\nReason: ${approval.reason}\nArguments: ${displayArgs}`,
        [[
          { text: "Approve", callback_data: `approve:${approval.id}:${nonce}` },
          { text: "Reject", callback_data: `reject:${approval.id}:${nonce}` },
        ]],
        signal,
      );
      await this.store.setApprovalTelegramMessage(approval.id, message.message_id);
    }
  }

  private async processUpdate(update: TelegramUpdate, signal: AbortSignal): Promise<void> {
    const ownerId = update.message?.from?.id ?? update.callback_query?.from.id;
    const shouldProcess = await this.store.beginTelegramUpdate(update.update_id, ownerId, update);
    if (!shouldProcess) {
      await this.store.advanceTelegramOffset(update.update_id);
      return;
    }
    if (ownerId !== this.config.telegramOwnerId) {
      this.logger.warn("telegram.update_ignored", { updateId: update.update_id, actorId: ownerId });
      await this.store.finishTelegramUpdate(update.update_id, "ignored");
      return;
    }

    try {
      if (update.callback_query) await this.handleCallback(update.callback_query, signal);
      else if (update.message) await this.handleMessage(update, update.message, signal);
      await this.store.finishTelegramUpdate(update.update_id, "processed");
    } catch (error) {
      const message = this.redactor.redactText(errorMessage(error));
      this.logger.error("telegram.update_failed", { updateId: update.update_id, error: message });
      const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
      if (chatId !== undefined) await this.telegram.sendMessage(chatId, `Request failed: ${truncate(message, 1200)}`, undefined, signal).catch(() => undefined);
      // Leave the durable update in received state so a transient failure is retried.
      throw error;
    }
  }

  private async handleMessage(update: TelegramUpdate, message: TelegramMessage, signal: AbortSignal): Promise<void> {
    const chatId = String(message.chat.id);
    const text = message.text?.trim();
    const command = text?.startsWith("/") ? parseCommand(text) : undefined;
    if (command) {
      await this.handleCommand(chatId, command.name, command.argument, signal);
      return;
    }

    const attachment = await this.telegram.saveInboundAttachment(message, update.update_id, signal);
    if (!text && !message.caption && !attachment) {
      await this.telegram.sendMessage(chatId, "Send text, a photo, or a document.", undefined, signal);
      return;
    }

    const parts: string[] = [];
    const userText = text || message.caption?.trim();
    if (userText) parts.push(userText);
    if (attachment) {
      parts.push(
        `${attachment.kind === "photo" ? "Photo" : "Document"} attachment saved at ${attachment.relativePath} ` +
          `(${attachment.originalName}, ${attachment.mimeType}, ${attachment.size} bytes). ` +
          `${attachment.kind === "photo" ? "Use vision.inspect when visual analysis is useful." : "Inspect it with file.read or appropriate workspace tools."}`,
      );
    }
    const prompt = parts.join("\n\n");
    const { task, created } = await this.store.createTaskFromUpdate({
      updateId: update.update_id,
      chatId,
      telegramMessageId: message.message_id,
      prompt,
      messageKind: attachment?.kind ?? "text",
    });
    if (created) await this.telegram.sendMessage(chatId, `Task ${task.id.slice(0, 8)} recorded and queued.`, undefined, signal);
    this.engine.kick();
  }

  private async handleCommand(chatId: string, name: string, argument: string, signal: AbortSignal): Promise<void> {
    switch (name) {
      case "start":
        await this.telegram.sendMessage(
          chatId,
          [
            "Autonomous runner agent is online.",
            "Commands: /status /new /resume /cancel /browser /screenshot /memory [query]",
            "Text, photos, and documents create durable tasks. Risky side effects require inline approval.",
          ].join("\n"),
          undefined,
          signal,
        );
        return;
      case "status":
        await this.telegram.sendLongMessage(chatId, await this.statusText(), signal);
        return;
      case "new": {
        const open = await this.store.latestOpenTask(chatId);
        if (open && ["waiting", "running", "waiting_approval"].includes(open.status)) await this.engine.cancelTask(open.id);
        await this.store.resetConversation(chatId);
        await this.telegram.sendMessage(chatId, "Conversation context reset. Open tasks and approvals were cancelled.", undefined, signal);
        return;
      }
      case "resume": {
        const task = await this.store.latestOpenTask(chatId);
        if (!task) {
          await this.telegram.sendMessage(chatId, "No resumable task found.", undefined, signal);
          return;
        }
        if (task.status === "waiting_approval") {
          await this.telegram.sendMessage(chatId, `Task ${task.id.slice(0, 8)} still needs an approval decision.`, undefined, signal);
          return;
        }
        await this.engine.resumeTask(task);
        await this.telegram.sendMessage(chatId, `Task ${task.id.slice(0, 8)} resumed from checkpoint ${task.iteration}.`, undefined, signal);
        return;
      }
      case "cancel": {
        const task = await this.store.latestOpenTask(chatId);
        if (!task || !["waiting", "running", "waiting_approval", "failed"].includes(task.status)) {
          await this.telegram.sendMessage(chatId, "No active task to cancel.", undefined, signal);
          return;
        }
        await this.engine.cancelTask(task.id);
        await this.telegram.sendMessage(chatId, `Task ${task.id.slice(0, 8)} cancelled.`, undefined, signal);
        return;
      }
      case "browser":
        await this.telegram.sendLongMessage(chatId, await this.browser.snapshot(), signal);
        return;
      case "screenshot": {
        const screenshot = await this.browser.screenshot();
        const bytes = await this.browser.readScreenshot(screenshot.path);
        await this.telegram.sendPhoto(chatId, bytes, "screenshot.png", "Current browser page", signal);
        return;
      }
      case "memory": {
        const results = await this.store.searchMemory(argument, 10);
        const output = results.length === 0
          ? "No matching durable memory."
          : results.map((item) => `[${item.source} ${item.id}] ${item.createdAt}\n${truncate(this.redactor.redactText(item.content), 700)}`).join("\n\n");
        await this.telegram.sendLongMessage(chatId, output, signal);
        return;
      }
      default:
        await this.telegram.sendMessage(chatId, `Unknown command /${name}. Use /start for commands.`, undefined, signal);
    }
  }

  private async handleCallback(callback: TelegramCallbackQuery, signal: AbortSignal): Promise<void> {
    const data = callback.data ?? "";
    const match = data.match(/^(approve|reject):([0-9a-f-]{36}):([A-Za-z0-9_-]{6,})$/i);
    if (!match?.[1] || !match[2] || !match[3]) {
      await this.telegram.answerCallbackQuery(callback.id, "Invalid or expired action", signal);
      return;
    }
    const decision = match[1].toLowerCase() === "approve" ? "approved" : "rejected";
    const current = await this.store.getApproval(match[2]);
    if (!current) {
      await this.telegram.answerCallbackQuery(callback.id, "Approval not found", signal);
      return;
    }
    if (current.status !== "pending") {
      await this.telegram.answerCallbackQuery(callback.id, `Already ${current.status}`, signal);
      return;
    }
    let approval: ApprovalRecord | undefined;
    try {
      approval = await this.store.decideApproval(match[2], match[3], decision);
    } catch {
      await this.telegram.answerCallbackQuery(callback.id, "Invalid or expired action", signal);
      return;
    }
    if (!approval) {
      await this.telegram.answerCallbackQuery(callback.id, "Approval not found", signal);
      return;
    }
    if (approval.status !== decision) {
      await this.telegram.answerCallbackQuery(callback.id, `Already ${approval.status}`, signal);
      return;
    }
    await this.store.transitionTask(approval.task_id, "waiting", decision === "rejected" ? "Approval rejected by owner" : null);
    await this.telegram.answerCallbackQuery(callback.id, decision === "approved" ? "Approved" : "Rejected", signal);
    if (callback.message) await this.telegram.sendMessage(callback.message.chat.id, `${decision === "approved" ? "Approved" : "Rejected"}: ${approval.reason}`, undefined, signal);
    this.logger.info("agent.approval_decided", { approvalId: approval.id, taskId: approval.task_id, decision });
    this.engine.kick();
  }

  private async statusText(): Promise<string> {
    const [lease, tasks] = await Promise.all([this.lease.current(), this.store.listOpenTasks()]);
    const uptime = Math.floor((Date.now() - this.startedAt) / 1000);
    const taskLines = tasks.length === 0
      ? ["Tasks: none"]
      : ["Tasks:", ...tasks.map((task) => `- ${task.id.slice(0, 8)} ${task.status} iter=${task.iteration} updated=${task.updated_at}`)];
    return [
      `Runner: ${this.config.runnerId}`,
      `Uptime: ${uptime}s`,
      `Model: ${this.ollama.modelName()}`,
      `Vision: ${this.ollama.visionModelName()}`,
      `Lease: ${lease?.holder_id === this.config.runnerId ? "held" : "not held"} holder=${lease?.holder_id || "none"} expires=${lease?.expires_at ?? "unknown"}`,
      `Contender: ${lease?.contender_id ?? "none"}${lease?.contender_seen_at ? ` seen=${lease.contender_seen_at}` : ""}`,
      `Browser: ${this.browser.isStarted() ? "started" : "not started"}`,
      `Unsafe auto: ${this.config.unsafeAuto ? "enabled" : "disabled"}`,
      ...taskLines,
    ].join("\n");
  }
}

function parseCommand(text: string): { name: string; argument: string } {
  const [head = "", ...rest] = text.split(/\s+/);
  const name = head.slice(1).split("@")[0]?.toLowerCase() ?? "";
  return { name, argument: rest.join(" ").trim() };
}
