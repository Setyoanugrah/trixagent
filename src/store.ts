import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { NebulaStateConflictError, type NebulaStateClient } from "./nebula-state.js";
import type {
  ApprovalRecord,
  ChatMessage,
  TaskCheckpoint,
  TaskRecord,
  TaskStatus,
  ToolCall,
  ToolRunRecord,
} from "./types.js";

const STATE_SCHEMA_VERSION = 1;
export const MAX_AGENT_STATE_BYTES = 4 * 1024 * 1024;
const TARGET_AGENT_STATE_BYTES = 3_750_000;
const CAS_ATTEMPTS = 8;

interface KvRecord {
  value: string;
  updated_at: string;
}

export interface TelegramUpdateRecord {
  update_id: number;
  owner_id: string | null;
  payload: unknown | null;
  status: "received" | "processed" | "ignored";
  received_at: string;
  processed_at: string | null;
  error: string | null;
}

export interface StoredMessage {
  id: string;
  chat_id: string;
  task_id: string | null;
  source_update_id: number | null;
  telegram_message_id: number | null;
  role: "user" | "assistant";
  kind: string;
  content: string;
  created_at: string;
}

export interface RunnerInstanceRecord {
  id: string;
  status: string;
  model: string;
  started_at: string;
  last_seen_at: string;
  stopped_at: string | null;
  metadata_json: string;
}

export interface AgentStateBlob {
  schema_version: 1;
  kv: Record<string, KvRecord>;
  telegram_updates: TelegramUpdateRecord[];
  messages: StoredMessage[];
  tasks: TaskRecord[];
  tool_runs: ToolRunRecord[];
  approvals: ApprovalRecord[];
  runner_instances: RunnerInstanceRecord[];
}

export interface MemoryResult {
  source: "message" | "task";
  id: string;
  createdAt: string;
  content: string;
}

interface Mutation<T> {
  value: T;
  changed: boolean;
}

export function emptyAgentState(): AgentStateBlob {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    kv: {},
    telegram_updates: [],
    messages: [],
    tasks: [],
    tool_runs: [],
    approvals: [],
    runner_instances: [],
  };
}

export class AgentStore {
  private state = emptyAgentState();
  private version: number | null = null;
  private loaded = false;
  private mutexTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly client: NebulaStateClient,
    private readonly stateKey = "telegram-autonomous-agent",
  ) {}

  public async load(signal?: AbortSignal): Promise<void> {
    await this.withMutex(async () => {
      for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
        const record = await this.client.getState<unknown>(this.stateKey, signal);
        if (!record) {
          this.state = emptyAgentState();
          this.version = null;
          this.loaded = true;
          return;
        }

        const state = decodeState(record.value);
        const before = JSON.stringify(state);
        pruneState(state);
        assertStateSize(state);
        const after = JSON.stringify(state);
        if (before === after) {
          this.state = state;
          this.version = record.version;
          this.loaded = true;
          return;
        }

        try {
          const saved = await this.client.putState(this.stateKey, record.version, state, signal);
          this.state = decodeState(saved.value);
          this.version = saved.version;
          this.loaded = true;
          return;
        } catch (error) {
          if (error instanceof NebulaStateConflictError && attempt < CAS_ATTEMPTS - 1) continue;
          throw error;
        }
      }
      throw new Error("Nebula state could not be loaded after repeated conflicts");
    });
  }

  public async checkpoint(): Promise<void> {
    await this.withMutex(async () => this.assertLoaded());
  }

  public async getKv(key: string): Promise<string | undefined> {
    return this.read((state) => state.kv[key]?.value);
  }

  public async setKv(key: string, value: string): Promise<void> {
    const now = new Date().toISOString();
    await this.mutate((state) => {
      state.kv[key] = { value, updated_at: now };
      return changed(undefined);
    });
  }

  public async beginTelegramUpdate(updateId: number, ownerId: number | undefined, payload: unknown): Promise<boolean> {
    const now = new Date().toISOString();
    return this.mutate((state) => {
      const existing = state.telegram_updates.find((item) => item.update_id === updateId);
      if (existing) return unchanged(existing.status === "received");
      state.telegram_updates.push({
        update_id: updateId,
        owner_id: ownerId === undefined ? null : String(ownerId),
        payload,
        status: "received",
        received_at: now,
        processed_at: null,
        error: null,
      });
      return changed(true);
    });
  }

  public async finishTelegramUpdate(updateId: number, status: "processed" | "ignored", error: string | null = null): Promise<void> {
    const now = new Date().toISOString();
    await this.mutate((state) => {
      const update = state.telegram_updates.find((item) => item.update_id === updateId);
      if (update) {
        update.status = status;
        update.processed_at = now;
        update.error = error;
        update.payload = null;
      }
      state.kv.telegram_update_offset = { value: String(updateId + 1), updated_at: now };
      return changed(undefined);
    });
  }

  public async telegramOffset(): Promise<number> {
    const value = await this.getKv("telegram_update_offset");
    const offset = Number(value ?? "0");
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  }

  public async advanceTelegramOffset(updateId: number): Promise<void> {
    await this.setKv("telegram_update_offset", String(updateId + 1));
  }

  public async createTaskFromUpdate(input: {
    updateId: number;
    chatId: string;
    telegramMessageId: number;
    prompt: string;
    messageKind: string;
  }): Promise<{ task: TaskRecord; created: boolean }> {
    const taskId = randomUUID();
    const messageId = randomUUID();
    const now = new Date().toISOString();
    return this.mutate((state) => {
      let task = state.tasks.find((item) => item.source_update_id === input.updateId);
      let wasCreated = task?.id === taskId;
      let didChange = false;
      if (!task) {
        task = {
          id: taskId,
          chat_id: input.chatId,
          source_update_id: input.updateId,
          status: "waiting",
          prompt: input.prompt,
          summary: "",
          checkpoint_json: JSON.stringify({ messages: [], pending: [] }),
          iteration: 0,
          last_error: null,
          created_at: now,
          updated_at: now,
        };
        state.tasks.push(task);
        wasCreated = true;
        didChange = true;
      }
      if (!state.messages.some((item) => item.source_update_id === input.updateId)) {
        state.messages.push({
          id: messageId,
          chat_id: input.chatId,
          task_id: task.id,
          source_update_id: input.updateId,
          telegram_message_id: input.telegramMessageId,
          role: "user",
          kind: input.messageKind,
          content: input.prompt,
          created_at: now,
        });
        didChange = true;
      }
      return { value: { task: clone(task), created: wasCreated }, changed: didChange };
    });
  }

  public async appendMessage(
    chatId: string,
    taskId: string | null,
    role: "user" | "assistant",
    kind: string,
    content: string,
  ): Promise<void> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.mutate((state) => {
      if (state.messages.some((item) => item.id === id)) return unchanged(undefined);
      state.messages.push({
        id,
        chat_id: chatId,
        task_id: taskId,
        source_update_id: null,
        telegram_message_id: null,
        role,
        kind,
        content,
        created_at: now,
      });
      return changed(undefined);
    });
  }

  public async recentMessages(chatId: string, limit = 16, through?: string): Promise<ChatMessage[]> {
    return this.read((state) => {
      if (limit <= 0) return [];
      const since = state.kv[`conversation_start:${chatId}`]?.value;
      return state.messages
        .filter((message) => message.chat_id === chatId)
        .filter((message) => since === undefined || message.created_at >= since)
        .filter((message) => through === undefined || message.created_at <= through)
        .sort(compareCreated)
        .slice(-Math.max(0, limit))
        .map((message) => ({ role: message.role, content: message.content }));
    });
  }

  public async resetConversation(chatId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.mutate((state) => {
      for (const task of state.tasks) {
        if (task.chat_id === chatId && ["waiting", "running", "waiting_approval"].includes(task.status)) {
          task.status = "cancelled";
          task.last_error = "Superseded by /new";
          task.updated_at = now;
        }
      }
      for (const approval of state.approvals) {
        if (approval.chat_id === chatId && approval.status === "pending") {
          approval.status = "rejected";
          approval.decided_at = now;
        }
      }
      state.kv[`conversation_start:${chatId}`] = { value: now, updated_at: now };
      return changed(undefined);
    });
  }

  public async getTask(id: string): Promise<TaskRecord | undefined> {
    return this.read((state) => state.tasks.find((task) => task.id === id));
  }

  public async nextRunnableTask(): Promise<TaskRecord | undefined> {
    return this.read((state) => state.tasks
      .filter((task) => task.status === "running" || task.status === "waiting")
      .sort((a, b) => taskRank(a.status) - taskRank(b.status) || a.updated_at.localeCompare(b.updated_at))[0]);
  }

  public async latestOpenTask(chatId: string): Promise<TaskRecord | undefined> {
    return this.read((state) => state.tasks
      .filter((task) => task.chat_id === chatId && ["waiting", "running", "waiting_approval", "failed"].includes(task.status))
      .sort((a, b) => openTaskRank(a.status) - openTaskRank(b.status) || b.updated_at.localeCompare(a.updated_at))[0]);
  }

  public async listOpenTasks(limit = 8): Promise<TaskRecord[]> {
    return this.read((state) => state.tasks
      .filter((task) => ["waiting", "running", "waiting_approval"].includes(task.status))
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
      .slice(0, Math.max(0, limit)));
  }

  public async updateTask(
    id: string,
    status: TaskStatus,
    summary: string,
    checkpoint: TaskCheckpoint,
    iteration: number,
    lastError: string | null = null,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.mutate((state) => {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) return unchanged(undefined);
      task.status = status;
      task.summary = summary;
      task.checkpoint_json = JSON.stringify(checkpoint);
      task.iteration = iteration;
      task.last_error = lastError;
      task.updated_at = now;
      return changed(undefined);
    });
  }

  public async transitionTask(id: string, status: TaskStatus, lastError: string | null = null): Promise<void> {
    const now = new Date().toISOString();
    await this.mutate((state) => {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) return unchanged(undefined);
      task.status = status;
      task.last_error = lastError;
      task.updated_at = now;
      return changed(undefined);
    });
  }

  public async cancelTask(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.mutate((state) => {
      const task = state.tasks.find((item) => item.id === id);
      if (task && ["waiting", "running", "waiting_approval", "failed"].includes(task.status)) {
        task.status = "cancelled";
        task.last_error = "Cancelled by owner";
        task.updated_at = now;
      }
      for (const approval of state.approvals) {
        if (approval.task_id === id && approval.status === "pending") {
          approval.status = "rejected";
          approval.decided_at = now;
        }
      }
      return changed(undefined);
    });
  }

  public async createToolRun(taskId: string, iteration: number, call: ToolCall): Promise<ToolRunRecord> {
    const row: ToolRunRecord = {
      id: randomUUID(),
      task_id: taskId,
      iteration,
      tool_name: call.name,
      arguments_json: JSON.stringify(call.arguments),
      status: "pending",
      output: null,
      error: null,
      approval_id: null,
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
    };
    return this.mutate((state) => {
      const existing = state.tool_runs.find((item) => item.id === row.id);
      if (existing) return unchanged(existing);
      if (!state.tasks.some((task) => task.id === taskId)) throw new Error("Cannot create a tool run for a missing task");
      state.tool_runs.push(clone(row));
      return changed(row);
    });
  }

  public async getToolRun(id: string): Promise<ToolRunRecord | undefined> {
    return this.read((state) => state.tool_runs.find((run) => run.id === id));
  }

  public async markToolRunning(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.mutate((state) => {
      const run = state.tool_runs.find((item) => item.id === id);
      if (!run || (run.status !== "pending" && run.status !== "running")) return unchanged(undefined);
      run.status = "running";
      run.started_at = now;
      run.error = null;
      return changed(undefined);
    });
  }

  public async completeTool(id: string, output: string): Promise<void> {
    await this.finishTool(id, "completed", output, null);
  }

  public async failTool(id: string, error: string): Promise<void> {
    await this.finishTool(id, "failed", null, error);
  }

  public async rejectTool(id: string, reason: string): Promise<void> {
    await this.finishTool(id, "rejected", null, reason);
  }

  public async createApproval(
    taskId: string,
    toolRunId: string,
    chatId: string,
    reason: string,
  ): Promise<{ approval: ApprovalRecord; nonce: string }> {
    const nonce = randomBytes(8).toString("base64url");
    const approval: ApprovalRecord = {
      id: randomUUID(),
      task_id: taskId,
      tool_run_id: toolRunId,
      chat_id: chatId,
      reason,
      status: "pending",
      nonce_hash: createHash("sha256").update(nonce).digest("hex"),
      requested_at: new Date().toISOString(),
      decided_at: null,
      telegram_message_id: null,
    };
    return this.mutate((state) => {
      const existing = state.approvals.find((item) => item.id === approval.id);
      if (existing) return unchanged({ approval: existing, nonce });
      const run = state.tool_runs.find((item) => item.id === toolRunId);
      if (!run || !state.tasks.some((task) => task.id === taskId)) throw new Error("Cannot create approval for a missing task or tool run");
      state.approvals.push(clone(approval));
      run.approval_id = approval.id;
      return changed({ approval, nonce });
    });
  }

  public async setApprovalTelegramMessage(id: string, messageId: number): Promise<void> {
    await this.mutate((state) => {
      const approval = state.approvals.find((item) => item.id === id);
      if (!approval) return unchanged(undefined);
      approval.telegram_message_id = messageId;
      return changed(undefined);
    });
  }

  public async getApproval(id: string): Promise<ApprovalRecord | undefined> {
    return this.read((state) => state.approvals.find((approval) => approval.id === id));
  }

  public async listUnannouncedApprovals(limit = 20): Promise<ApprovalRecord[]> {
    return this.read((state) => state.approvals
      .filter((approval) => approval.status === "pending" && approval.telegram_message_id === null)
      .sort((a, b) => a.requested_at.localeCompare(b.requested_at))
      .slice(0, Math.max(0, limit)));
  }

  public async rotateApprovalNonce(id: string): Promise<string> {
    const nonce = randomBytes(8).toString("base64url");
    const hash = createHash("sha256").update(nonce).digest("hex");
    return this.mutate((state) => {
      const approval = state.approvals.find((item) => item.id === id);
      if (!approval || approval.status !== "pending") throw new Error("Approval is no longer pending");
      approval.nonce_hash = hash;
      return changed(nonce);
    });
  }

  public async decideApproval(
    id: string,
    nonce: string,
    decision: "approved" | "rejected",
  ): Promise<ApprovalRecord | undefined> {
    const supplied = createHash("sha256").update(nonce).digest();
    const now = new Date().toISOString();
    return this.mutate((state) => {
      const approval = state.approvals.find((item) => item.id === id);
      if (!approval || approval.status !== "pending") return unchanged(approval);
      const expected = Buffer.from(approval.nonce_hash, "hex");
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error("Invalid approval nonce");
      approval.status = decision;
      approval.decided_at = now;
      return changed(approval);
    });
  }

  public async searchMemory(query: string, limit = 8): Promise<MemoryResult[]> {
    const needle = query.toLocaleLowerCase();
    return this.read((state) => [
      ...state.messages
        .filter((message) => message.content.toLocaleLowerCase().includes(needle))
        .map((message) => ({ source: "message" as const, id: message.id, createdAt: message.created_at, content: message.content })),
      ...state.tasks
        .filter((task) => task.summary.toLocaleLowerCase().includes(needle))
        .map((task) => ({ source: "task" as const, id: task.id, createdAt: task.updated_at, content: task.summary })),
    ]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(0, limit)));
  }

  public async registerRunner(id: string, model: string, metadata: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    const metadataJson = JSON.stringify(metadata);
    await this.mutate((state) => {
      const runner = state.runner_instances.find((item) => item.id === id);
      if (runner) {
        runner.status = "starting";
        runner.last_seen_at = now;
        runner.metadata_json = metadataJson;
      } else {
        state.runner_instances.push({
          id,
          status: "starting",
          model,
          started_at: now,
          last_seen_at: now,
          stopped_at: null,
          metadata_json: metadataJson,
        });
      }
      return changed(undefined);
    });
  }

  public async heartbeatRunner(id: string, status = "active"): Promise<void> {
    const now = new Date().toISOString();
    await this.mutate((state) => {
      const runner = state.runner_instances.find((item) => item.id === id);
      if (!runner) return unchanged(undefined);
      runner.status = status;
      runner.last_seen_at = now;
      return changed(undefined);
    });
  }

  public async stopRunner(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.mutate((state) => {
      const runner = state.runner_instances.find((item) => item.id === id);
      if (!runner) return unchanged(undefined);
      runner.status = "stopped";
      runner.last_seen_at = now;
      runner.stopped_at = now;
      return changed(undefined);
    });
  }

  private async finishTool(
    id: string,
    status: "completed" | "failed" | "rejected",
    output: string | null,
    error: string | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.mutate((state) => {
      const run = state.tool_runs.find((item) => item.id === id);
      if (!run) return unchanged(undefined);
      run.status = status;
      run.output = output;
      run.error = error;
      run.completed_at = now;
      return changed(undefined);
    });
  }

  private async read<T>(reader: (state: AgentStateBlob) => T): Promise<T> {
    return this.withMutex(async () => {
      this.assertLoaded();
      return clone(reader(this.state));
    });
  }

  private async mutate<T>(operation: (state: AgentStateBlob) => Mutation<T>): Promise<T> {
    return this.withMutex(async () => {
      this.assertLoaded();
      for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
        const draft = clone(this.state);
        const mutation = operation(draft);
        if (!mutation.changed) return clone(mutation.value);
        pruneState(draft);
        assertStateSize(draft);
        try {
          const saved = await this.client.putState(this.stateKey, this.version, draft);
          const savedState = decodeState(saved.value);
          pruneState(savedState);
          assertStateSize(savedState);
          this.state = savedState;
          this.version = saved.version;
          return clone(mutation.value);
        } catch (error) {
          if (!(error instanceof NebulaStateConflictError) || attempt >= CAS_ATTEMPTS - 1) throw error;
          await this.reload();
        }
      }
      throw new Error("Nebula state mutation exhausted conflict retries");
    });
  }

  private async reload(): Promise<void> {
    const record = await this.client.getState<unknown>(this.stateKey);
    this.state = record ? decodeState(record.value) : emptyAgentState();
    this.version = record?.version ?? null;
    pruneState(this.state);
    assertStateSize(this.state);
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("AgentStore.load() must complete before the store is used");
  }

  private async withMutex<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutexTail;
    let release!: () => void;
    this.mutexTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function decodeState(value: unknown): AgentStateBlob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Nebula agent state is not an object");
  const source = value as Record<string, unknown>;
  if (source.schema_version !== STATE_SCHEMA_VERSION) throw new Error("Nebula agent state has an unsupported schema version");
  if (!isRecord(source.kv)) throw new Error("Nebula agent state has invalid kv data");
  const arrays = ["telegram_updates", "messages", "tasks", "tool_runs", "approvals", "runner_instances"] as const;
  for (const key of arrays) if (!Array.isArray(source[key])) throw new Error(`Nebula agent state has invalid ${key} data`);
  for (const entry of Object.values(source.kv)) {
    if (!isRecord(entry) || typeof entry.value !== "string" || typeof entry.updated_at !== "string") {
      throw new Error("Nebula agent state has an invalid kv entry");
    }
  }
  return clone(value as AgentStateBlob);
}

function pruneState(state: AgentStateBlob): void {
  const received = state.telegram_updates.filter((update) => update.status === "received");
  const processed = newest(state.telegram_updates.filter((update) => update.status !== "received"), 512, (update) => update.processed_at ?? update.received_at);
  for (const update of processed) update.payload = null;
  state.telegram_updates = [...received, ...processed].sort((a, b) => a.update_id - b.update_id);

  state.messages = newest(state.messages, 1_200, (message) => message.created_at).sort(compareCreated);
  const activeTasks = state.tasks.filter((task) => ["waiting", "running", "waiting_approval"].includes(task.status));
  const retainedTerminalTasks = newest(
    state.tasks.filter((task) => !["waiting", "running", "waiting_approval"].includes(task.status)),
    256,
    (task) => task.updated_at,
  );
  state.tasks = [...activeTasks, ...retainedTerminalTasks].sort(compareCreated);

  const retainedTaskIds = new Set(state.tasks.map((task) => task.id));
  const protectedRuns = checkpointReferences(state.tasks, "toolRunId");
  const requiredRuns = state.tool_runs.filter((run) => run.status === "pending" || run.status === "running" || protectedRuns.has(run.id));
  const requiredRunIds = new Set(requiredRuns.map((run) => run.id));
  const oldRuns = newest(
    state.tool_runs.filter((run) => !requiredRunIds.has(run.id) && retainedTaskIds.has(run.task_id)),
    320,
    (run) => run.completed_at ?? run.created_at,
  );
  state.tool_runs = [...requiredRuns, ...oldRuns].sort(compareCreated);

  const protectedApprovals = checkpointReferences(state.tasks, "approvalId");
  const pendingApprovals = state.approvals.filter((approval) => approval.status === "pending" || protectedApprovals.has(approval.id));
  const pendingApprovalIds = new Set(pendingApprovals.map((approval) => approval.id));
  const resolvedApprovals = newest(
    state.approvals.filter((approval) => !pendingApprovalIds.has(approval.id) && retainedTaskIds.has(approval.task_id)),
    192,
    (approval) => approval.decided_at ?? approval.requested_at,
  );
  state.approvals = [...pendingApprovals, ...resolvedApprovals].sort((a, b) => a.requested_at.localeCompare(b.requested_at));

  const running = newest(state.runner_instances.filter((runner) => runner.status !== "stopped"), 32, (runner) => runner.last_seen_at);
  const stopped = newest(state.runner_instances.filter((runner) => runner.status === "stopped"), 32, (runner) => runner.last_seen_at);
  state.runner_instances = [...running, ...stopped].sort((a, b) => a.started_at.localeCompare(b.started_at));

  if (stateBytes(state) <= TARGET_AGENT_STATE_BYTES) return;
  state.telegram_updates = [
    ...state.telegram_updates.filter((update) => update.status === "received"),
    ...newest(state.telegram_updates.filter((update) => update.status !== "received"), 64, (update) => update.processed_at ?? update.received_at),
  ].sort((a, b) => a.update_id - b.update_id);
  if (stateBytes(state) <= TARGET_AGENT_STATE_BYTES) return;

  const protectedRunIds = checkpointReferences(state.tasks, "toolRunId");
  state.tool_runs = [
    ...state.tool_runs.filter((run) => run.status === "pending" || run.status === "running" || protectedRunIds.has(run.id)),
    ...newest(
      state.tool_runs.filter((run) => run.status !== "pending" && run.status !== "running" && !protectedRunIds.has(run.id)),
      64,
      (run) => run.completed_at ?? run.created_at,
    ),
  ].sort(compareCreated);
  if (stateBytes(state) <= TARGET_AGENT_STATE_BYTES) return;

  state.approvals = [
    ...state.approvals.filter((approval) => approval.status === "pending"),
    ...newest(state.approvals.filter((approval) => approval.status !== "pending"), 32, (approval) => approval.decided_at ?? approval.requested_at),
  ].sort((a, b) => a.requested_at.localeCompare(b.requested_at));
  state.runner_instances = newest(state.runner_instances, 16, (runner) => runner.last_seen_at).sort((a, b) => a.started_at.localeCompare(b.started_at));
  if (stateBytes(state) <= TARGET_AGENT_STATE_BYTES) return;

  for (const run of state.tool_runs) {
    if (run.status === "completed" || run.status === "failed" || run.status === "rejected") {
      run.arguments_json = cap(run.arguments_json, 4_000);
      if (run.output !== null) run.output = cap(run.output, 4_000);
      if (run.error !== null) run.error = cap(run.error, 2_000);
    }
  }
  for (const task of state.tasks) {
    if (task.status === "completed" || task.status === "cancelled") {
      task.prompt = cap(task.prompt, 4_000);
      task.summary = cap(task.summary, 6_000);
      task.checkpoint_json = JSON.stringify({ messages: [], pending: [] });
    }
  }
  for (const message of state.messages) message.content = cap(message.content, 12_000);
  if (stateBytes(state) <= TARGET_AGENT_STATE_BYTES) return;

  state.messages = newest(state.messages, 128, (message) => message.created_at).sort(compareCreated);
  if (stateBytes(state) <= TARGET_AGENT_STATE_BYTES) return;
  const liveTasks = state.tasks.filter((task) => ["waiting", "running", "waiting_approval"].includes(task.status));
  const terminalTasks = newest(
    state.tasks.filter((task) => !["waiting", "running", "waiting_approval"].includes(task.status)),
    32,
    (task) => task.updated_at,
  );
  state.tasks = [...liveTasks, ...terminalTasks].sort(compareCreated);
}

function checkpointReferences(tasks: TaskRecord[], field: "toolRunId" | "approvalId"): Set<string> {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (task.status === "completed" || task.status === "cancelled") continue;
    try {
      const checkpoint = JSON.parse(task.checkpoint_json) as Partial<TaskCheckpoint>;
      if (!Array.isArray(checkpoint.pending)) continue;
      for (const pending of checkpoint.pending) {
        const value = pending[field];
        if (typeof value === "string") ids.add(value);
      }
    } catch {
      // Invalid checkpoints are handled by the agent's existing recovery path.
    }
  }
  return ids;
}

function assertStateSize(state: AgentStateBlob): void {
  const bytes = stateBytes(state);
  if (bytes >= MAX_AGENT_STATE_BYTES) throw new Error(`Agent state exceeds the 4 MiB limit after pruning (${bytes} bytes)`);
}

function stateBytes(state: AgentStateBlob): number {
  return Buffer.byteLength(JSON.stringify(state), "utf8");
}

function newest<T>(items: T[], limit: number, timestamp: (item: T) => string): T[] {
  if (limit <= 0) return [];
  return [...items].sort((a, b) => timestamp(a).localeCompare(timestamp(b))).slice(-limit);
}

function compareCreated(a: { created_at: string }, b: { created_at: string }): number {
  return a.created_at.localeCompare(b.created_at);
}

function taskRank(status: TaskStatus): number {
  return status === "running" ? 0 : 1;
}

function openTaskRank(status: TaskStatus): number {
  if (status === "running") return 0;
  if (status === "waiting_approval") return 1;
  if (status === "waiting") return 2;
  return 3;
}

function cap(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 16))}\n...[truncated]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function changed<T>(value: T): Mutation<T> {
  return { value, changed: true };
}

function unchanged<T>(value: T): Mutation<T> {
  return { value, changed: false };
}
