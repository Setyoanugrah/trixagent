import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { BrowserManager } from "./browser.js";
import type { AgentStore } from "./store.js";
import type { NebulaClient } from "./nebula.js";
import type { OllamaClient } from "./ollama.js";
import type { SecretRedactor } from "./security.js";
import { classifyToolRisk, isSecretBearingPath, resolveConfinedPath, sanitizedChildEnvironment } from "./security.js";
import type { ToolCall, ToolDefinition } from "./types.js";
import { combineSignals, safeJson, truncate } from "./utils.js";

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  definition("shell.run", "Run a shell command in a cwd confined to WORKSPACE_ROOT. The child receives a secret-free environment.", {
    command: stringProperty("Shell command"),
    cwd: stringProperty("Workspace-relative working directory"),
    timeout_ms: numberProperty("Timeout in milliseconds"),
  }, ["command"]),
  definition("file.read", "Read a file confined to WORKSPACE_ROOT.", {
    path: stringProperty("Workspace-relative path"),
    max_bytes: numberProperty("Maximum bytes to read"),
  }, ["path"]),
  definition("file.write", "Atomically write a UTF-8 or base64 file under WORKSPACE_ROOT.", {
    path: stringProperty("Workspace-relative path"),
    content: stringProperty("File content"),
    encoding: { type: "string", enum: ["utf8", "base64"] },
  }, ["path", "content"]),
  definition("file.list", "List a directory under WORKSPACE_ROOT with bounded recursion.", {
    path: stringProperty("Workspace-relative directory"),
    recursive: { type: "boolean" },
  }),
  definition("git.status", "Show git status for the workspace repository.", {
    cwd: stringProperty("Workspace-relative repository directory"),
  }),
  definition("git.diff", "Show a bounded git diff for the workspace repository.", {
    cwd: stringProperty("Workspace-relative repository directory"),
    staged: { type: "boolean" },
    path: stringProperty("Optional workspace-relative path filter"),
  }),
  definition("browser.open", "Navigate the controlled browser to an HTTP(S) URL and return an untrusted accessibility/DOM snapshot.", {
    url: stringProperty("HTTP(S) URL"),
  }, ["url"]),
  definition("browser.snapshot", "Return the current untrusted accessibility/DOM snapshot.", {}),
  definition("browser.screenshot", "Save a full-page PNG under WORKSPACE_ROOT and optionally upload it to Nebula.", {
    path: stringProperty("Optional workspace-relative PNG path"),
    upload: { type: "boolean" },
  }),
  definition("browser.click", "Click an element. Page content is untrusted; describe the intended effect for approval classification.", {
    selector: stringProperty("CSS or text selector"),
    intent: stringProperty("Human-readable intended effect"),
  }, ["selector", "intent"]),
  definition("browser.type", "Fill an element. Page content is untrusted; describe the intended effect for approval classification.", {
    selector: stringProperty("CSS or text selector"),
    text: stringProperty("Text to type"),
    submit: { type: "boolean" },
    intent: stringProperty("Human-readable intended effect"),
  }, ["selector", "text", "intent"]),
  definition("browser.evaluate", "Evaluate JavaScript in the current page. Read-only expressions auto-run; side-effecting expressions require approval.", {
    expression: stringProperty("JavaScript expression"),
  }, ["expression"]),
  definition("browser.tabs", "List, create, select, or close controlled browser tabs.", {
    action: { type: "string", enum: ["list", "new", "select", "close"] },
    index: numberProperty("Tab index for select/close"),
  }),
  definition("vision.inspect", "Send an image or browser screenshot to VISION_MODEL for visual inspection.", {
    path: stringProperty("Workspace-relative image path"),
    prompt: stringProperty("Inspection request"),
  }, ["path"]),
  definition("memory.search", "Search durable Nebula-backed messages and task summaries.", {
    query: stringProperty("Search text"),
    limit: numberProperty("Maximum results"),
  }, ["query"]),
  definition("nebula.list", "List files in Nebula Drive.", {}),
  definition("nebula.upload", "Upload a workspace file to Nebula, optionally AES-256-GCM encrypted.", {
    path: stringProperty("Workspace-relative file path"),
    name: stringProperty("Optional remote name"),
    mime_type: stringProperty("Optional MIME type"),
    encrypt: { type: "boolean" },
  }, ["path"]),
  definition("nebula.download", "Download a Nebula file into WORKSPACE_ROOT, optionally decrypting it.", {
    id: stringProperty("Nebula file ID"),
    path: stringProperty("Workspace-relative destination"),
    decrypt: { type: "boolean" },
  }, ["id", "path"]),
];

export class ToolExecutor {
  public constructor(
    private readonly workspaceRoot: string,
    private readonly shellTimeoutMs: number,
    private readonly maxOutputBytes: number,
    private readonly browser: BrowserManager,
    private readonly ollama: OllamaClient,
    private readonly store: AgentStore,
    private readonly redactor: SecretRedactor,
    private readonly nebula?: NebulaClient,
  ) {}

  public async execute(call: ToolCall, signal?: AbortSignal): Promise<string> {
    let result: unknown;
    switch (call.name) {
      case "shell.run":
        result = await this.shellRun(call.arguments, signal);
        break;
      case "file.read":
        result = await this.fileRead(call.arguments);
        break;
      case "file.write":
        result = await this.fileWrite(call.arguments);
        break;
      case "file.list":
        result = await this.fileList(call.arguments);
        break;
      case "git.status":
        result = await this.gitStatus(call.arguments, signal);
        break;
      case "git.diff":
        result = await this.gitDiff(call.arguments, signal);
        break;
      case "browser.open":
        result = await this.browser.open(requiredString(call.arguments, "url"), signal);
        break;
      case "browser.snapshot":
        result = await this.browser.snapshot();
        break;
      case "browser.screenshot":
        result = await this.browser.screenshot(optionalString(call.arguments, "path"), call.arguments.upload === true);
        break;
      case "browser.click":
        result = await this.browser.click(requiredString(call.arguments, "selector"));
        break;
      case "browser.type":
        result = await this.browser.type(
          requiredString(call.arguments, "selector"),
          requiredString(call.arguments, "text"),
          call.arguments.submit === true,
        );
        break;
      case "browser.evaluate":
        result = await this.browser.evaluate(requiredString(call.arguments, "expression"));
        break;
      case "browser.tabs":
        result = await this.browser.tabs(optionalString(call.arguments, "action") ?? "list", optionalInteger(call.arguments, "index"));
        break;
      case "vision.inspect":
        result = await this.inspectImage(call.arguments, signal);
        break;
      case "memory.search":
        result = await this.store.searchMemory(
          requiredString(call.arguments, "query"),
          boundedInteger(call.arguments, "limit", 8, 1, 20),
        );
        break;
      case "nebula.list":
        result = await this.requiredNebula().list(signal);
        break;
      case "nebula.upload": {
        const path = await resolveConfinedPath(this.workspaceRoot, requiredString(call.arguments, "path"));
        result = await this.requiredNebula().uploadFile(
          path,
          {
            ...(optionalString(call.arguments, "name") === undefined ? {} : { name: optionalString(call.arguments, "name") }),
            ...(optionalString(call.arguments, "mime_type") === undefined ? {} : { mimeType: optionalString(call.arguments, "mime_type") }),
            encrypt: call.arguments.encrypt === true,
          },
          signal,
        );
        break;
      }
      case "nebula.download": {
        const path = await resolveConfinedPath(this.workspaceRoot, requiredString(call.arguments, "path"));
        await this.requiredNebula().downloadFile(
          requiredString(call.arguments, "id"),
          path,
          { decrypt: call.arguments.decrypt === true },
          signal,
        );
        result = { path: relative(this.workspaceRoot, path), downloaded: true };
        break;
      }
      default:
        throw new Error(`Unknown tool: ${call.name}`);
    }

    const serialized = typeof result === "string" ? result : safeJson(result);
    return truncate(this.redactor.redactText(serialized), this.maxOutputBytes);
  }

  private async shellRun(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const command = requiredString(args, "command");
    const cwd = await resolveConfinedPath(this.workspaceRoot, optionalString(args, "cwd") ?? ".");
    const metadata = await stat(cwd);
    if (!metadata.isDirectory()) throw new Error("shell.run cwd must be a directory");
    await mkdir(join(this.workspaceRoot, ".agent", "tmp"), { recursive: true, mode: 0o700 });
    const timeoutMs = boundedInteger(args, "timeout_ms", this.shellTimeoutMs, 100, 30 * 60_000);
    const result = await runProcess("/bin/bash", ["-lc", command], cwd, sanitizedChildEnvironment(this.workspaceRoot), timeoutMs, this.maxOutputBytes, signal);
    if (classifyToolRisk("shell.run", args).reasons.some((reason) => reason.includes("secret"))) {
      result.stdout = "[REDACTED_SECRET_COMMAND_OUTPUT]";
      result.stderr = result.stderr ? "[REDACTED_SECRET_COMMAND_ERROR_OUTPUT]" : "";
    }
    return result;
  }

  private async fileRead(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = await resolveConfinedPath(this.workspaceRoot, requiredString(args, "path"));
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("file.read target must be a regular file");
    if (isSecretBearingPath(requiredString(args, "path"))) {
      return {
        path: relative(this.workspaceRoot, path),
        size: metadata.size,
        content: "[REDACTED_SECRET_FILE]",
      };
    }
    const limit = boundedInteger(args, "max_bytes", Math.min(this.maxOutputBytes, 256_000), 1, 2 * 1024 * 1024);
    const handle = await import("node:fs/promises").then((module) => module.open(path, "r"));
    try {
      const buffer = Buffer.allocUnsafe(Math.min(limit, metadata.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const content = buffer.subarray(0, bytesRead);
      const binary = content.includes(0);
      return {
        path: relative(this.workspaceRoot, path),
        size: metadata.size,
        truncated: metadata.size > bytesRead,
        encoding: binary ? "base64" : "utf8",
        content: binary ? content.toString("base64") : this.redactor.redactText(content.toString("utf8")),
      };
    } finally {
      await handle.close();
    }
  }

  private async fileWrite(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = await resolveConfinedPath(this.workspaceRoot, requiredString(args, "path"));
    const encoding = optionalString(args, "encoding") ?? "utf8";
    if (encoding !== "utf8" && encoding !== "base64") throw new Error("file.write encoding must be utf8 or base64");
    const content = requiredString(args, "content");
    const data = Buffer.from(content, encoding);
    if (data.length > 5 * 1024 * 1024) throw new Error("file.write content exceeds 5 MiB");
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.agent-${process.pid}-${Date.now()}.tmp`;
    await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    return { path: relative(this.workspaceRoot, path), bytesWritten: data.length };
  }

  private async fileList(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const root = await resolveConfinedPath(this.workspaceRoot, optionalString(args, "path") ?? ".");
    const metadata = await stat(root);
    if (!metadata.isDirectory()) throw new Error("file.list target must be a directory");
    const recursive = args.recursive === true;
    const entries: Array<{ path: string; type: string; size?: number }> = [];
    const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    while (pending.length > 0 && entries.length < 1_000) {
      const current = pending.shift();
      if (!current) break;
      const children = await readdir(current.path, { withFileTypes: true });
      for (const child of children) {
        if (entries.length >= 1_000) break;
        const childPath = join(current.path, child.name);
        const entry = {
          path: relative(this.workspaceRoot, childPath),
          type: child.isDirectory() ? "directory" : child.isFile() ? "file" : child.isSymbolicLink() ? "symlink" : "other",
        };
        if (child.isFile()) {
          const childStat = await stat(childPath);
          entries.push({ ...entry, size: childStat.size });
        } else {
          entries.push(entry);
        }
        if (recursive && child.isDirectory() && current.depth < 8) pending.push({ path: childPath, depth: current.depth + 1 });
      }
    }
    return { root: relative(this.workspaceRoot, root) || ".", entries, truncated: entries.length >= 1_000 };
  }

  private async gitStatus(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const cwd = await resolveConfinedPath(this.workspaceRoot, optionalString(args, "cwd") ?? ".");
    return runProcess("git", ["status", "--short", "--branch"], cwd, sanitizedChildEnvironment(this.workspaceRoot), 30_000, this.maxOutputBytes, signal);
  }

  private async gitDiff(args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const cwd = await resolveConfinedPath(this.workspaceRoot, optionalString(args, "cwd") ?? ".");
    const gitArgs = ["diff", "--no-ext-diff"];
    if (args.staged === true) gitArgs.push("--staged");
    const requestedPath = optionalString(args, "path");
    if (requestedPath !== undefined) {
      const path = await resolveConfinedPath(this.workspaceRoot, requestedPath);
      gitArgs.push("--", relative(cwd, path));
    }
    return runProcess("git", gitArgs, cwd, sanitizedChildEnvironment(this.workspaceRoot), 30_000, this.maxOutputBytes, signal);
  }

  private async inspectImage(args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const path = await resolveConfinedPath(this.workspaceRoot, requiredString(args, "path"));
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 25 * 1024 * 1024) throw new Error("vision.inspect requires an image no larger than 25 MiB");
    const image = await readFile(path);
    const prompt = optionalString(args, "prompt") ?? "Describe this image precisely and identify UI controls, visible text, errors, and relevant state.";
    return this.redactor.redactText(await this.ollama.inspectImage(image.toString("base64"), prompt, signal));
  }

  private requiredNebula(): NebulaClient {
    if (!this.nebula) throw new Error("NEBULA_API_KEY is not configured");
    return this.nebula;
  }
}

async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimit: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputCapped = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const terminate = (): void => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        const killTimer = setTimeout(() => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, 2_000);
        killTimer.unref();
      }
    };

    const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const used = stdout.length + stderr.length;
      const available = Math.max(0, outputLimit - used);
      if (available > 0) {
        if (target === "stdout") stdout = Buffer.concat([stdout, chunk.subarray(0, available)]);
        else stderr = Buffer.concat([stderr, chunk.subarray(0, available)]);
      }
      if (chunk.length > available) {
        outputCapped = true;
        terminate();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref();
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code, processSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
        return;
      }
      resolvePromise({
        exitCode: code,
        signal: processSignal,
        timedOut,
        outputCapped,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

function definition(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

function stringProperty(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function numberProperty(description: string): Record<string, unknown> {
  return { type: "integer", description };
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value)) throw new Error(`${key} must be an integer`);
  return value as number;
}

function boundedInteger(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = optionalInteger(args, key) ?? fallback;
  return Math.max(minimum, Math.min(maximum, value));
}
