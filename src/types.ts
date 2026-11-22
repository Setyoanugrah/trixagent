export type TaskStatus =
  | "waiting"
  | "running"
  | "waiting_approval"
  | "completed"
  | "cancelled"
  | "failed";

export interface TaskRecord {
  id: string;
  chat_id: string;
  source_update_id: number | null;
  status: TaskStatus;
  prompt: string;
  summary: string;
  checkpoint_json: string;
  iteration: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: ModelToolCall[];
  tool_name?: string;
  tool_call_id?: string;
}

export interface PendingToolCall {
  toolRunId: string;
  call: ToolCall;
  approvalId?: string;
}

export interface TaskCheckpoint {
  messages: ChatMessage[];
  pending: PendingToolCall[];
}

export interface ToolRunRecord {
  id: string;
  task_id: string;
  iteration: number;
  tool_name: string;
  arguments_json: string;
  status: "pending" | "running" | "completed" | "failed" | "rejected";
  output: string | null;
  error: string | null;
  approval_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface ApprovalRecord {
  id: string;
  task_id: string;
  tool_run_id: string;
  chat_id: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  nonce_hash: string;
  requested_at: string;
  decided_at: string | null;
  telegram_message_id: number | null;
}

export interface LeaseRecord {
  name: string;
  holder_id: string;
  acquired_at: string;
  expires_at: string;
  contender_id: string | null;
  contender_seen_at: string | null;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
