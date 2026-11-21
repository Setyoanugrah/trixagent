import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function resolveConfinedPath(root: string, requested = "."): Promise<string> {
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, requested);
  if (!isInside(rootReal, candidate)) throw new Error(`Path escapes WORKSPACE_ROOT: ${requested}`);

  try {
    const targetReal = await realpath(candidate);
    if (!isInside(rootReal, targetReal)) throw new Error(`Path resolves outside WORKSPACE_ROOT: ${requested}`);
    return targetReal;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  let existingParent = dirname(candidate);
  while (isInside(rootReal, existingParent)) {
    try {
      const parentReal = await realpath(existingParent);
      if (!isInside(rootReal, parentReal)) throw new Error(`Parent resolves outside WORKSPACE_ROOT: ${requested}`);
      return candidate;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      if (existingParent === rootReal) break;
      existingParent = dirname(existingParent);
    }
  }
  throw new Error(`No confined parent exists for path: ${requested}`);
}

export interface RiskAssessment {
  risky: boolean;
  reasons: string[];
}

const SECRET_PATH = /(^|[\\/])(\.env(?:\.|$)|\.npmrc$|\.pypirc$|credentials?$|secrets?$|id_(?:rsa|ed25519)|.*\.(?:pem|p12|pfx|key))([\\/]|$)/i;

export function isSecretBearingPath(path: string): boolean {
  return SECRET_PATH.test(path);
}

function argString(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? args[key] : "";
}

export function classifyToolRisk(name: string, args: Record<string, unknown>): RiskAssessment {
  const reasons = new Set<string>();
  const serialized = JSON.stringify(args).toLowerCase();

  if (name === "shell.run") {
    const command = argString(args, "command").trim().toLowerCase();
    if (/(^|[;&|()]\s*|\bsudo\s+)(rm|rmdir|shred|wipefs|mkfs(?:\.\w+)?|fdisk|parted)\b/.test(command)) {
      reasons.add("destructive shell command");
    }
    if (/\b(git\s+push|git\s+clean\b|git\s+reset\s+--hard|git\s+checkout\s+--|find\b[^\n]*\s-delete\b|dd\s+[^\n]*\bof=|truncate\s+-s\s*0)\b/.test(command)) {
      reasons.add("destructive or remote git/filesystem operation");
    }
    if (/\b(npm|pnpm|yarn|cargo|gem)\s+(?:\w+\s+)?publish\b|\btwine\s+upload\b/.test(command)) {
      reasons.add("package publication");
    }
    if (/\b(kubectl\s+(?:apply|delete)|terraform\s+(?:apply|destroy)|wrangler\s+deploy|vercel\s+(?:deploy|--prod)|flyctl?\s+deploy|docker\s+push|gh\s+(?:release|pr|issue)\s+(?:create|comment|edit|close|merge))\b/.test(command)) {
      reasons.add("deployment or externally visible change");
    }
    if (/\b(curl|http|wget)\b[^\n]*(--data|-d\s|--form|-f\s|--request\s+(post|put|patch|delete)|-x\s*(post|put|patch|delete))\b/.test(command) || /\b(ssh|scp|sftp)\b/.test(command)) {
      reasons.add("external message or data transfer");
    }
    if (/\b(drop\s+(table|database)|delete\s+from|shutdown\b|reboot\b|poweroff\b)\b/.test(command)) {
      reasons.add("destructive system or database operation");
    }
    if (/\b(telegram_bot_token|nebula_api_key|state_encryption_key|password|secret)\b|\bprintenv\b|\/proc\/\d+\/environ/.test(command)) {
      reasons.add("secret access");
    }
    if (/(^|[\s/])(\.env(?:\.[\w-]+)?|\.npmrc|\.pypirc|\.git-credentials|id_rsa|id_ed25519)(\s|$)/.test(command)) {
      reasons.add("secret-bearing file access");
    }
    if (/\b(eval|source)\b|\b(?:ba|z|fi)?sh\s+-c\b|\b(base64|xxd)\b[^\n]*\|\s*(?:ba|z|fi)?sh\b|\$\([^)]*\)|`[^`]+`/.test(command)) {
      reasons.add("indirect shell execution requires review");
    }
    if (/\b(?:node|python\d*|ruby|perl)\s+-[ec]\b[^\n]*\b(unlink|rmdir|rmSync|rm\s*\(|remove\s*\(|rmtree|requests\.(?:post|put|patch|delete)|fetch\s*\()/.test(command)) {
      reasons.add("embedded destructive or external operation");
    }
  }

  const path = argString(args, "path");
  if ((name === "file.read" || name === "file.write" || name === "nebula.upload") && isSecretBearingPath(path)) {
    reasons.add("secret-bearing file");
  }

  if (name === "browser.evaluate") {
    const expression = argString(args, "expression").toLowerCase();
    if (/\b(fetch|xmlhttprequest|submit\s*\(|requestsubmit|websocket|sendbeacon|\.click\s*\()/.test(expression)) {
      reasons.add("page script can cause an external side effect");
    }
  }

  if (name === "browser.click" || name === "browser.type") {
    const intent = `${argString(args, "intent")} ${argString(args, "selector")}`.toLowerCase();
    if (/\b(send|submit|publish|post|comment|message|buy|purchase|pay|checkout|transfer|delete|remove|confirm|deploy|merge)\b/.test(intent)) {
      reasons.add("browser action may create an external side effect");
    }
    if (/\b(password|passcode|api.?key|secret|credit.?card|cvv|wallet)\b/.test(intent)) reasons.add("secret or payment input");
    if (name === "browser.type" && args.submit === true) reasons.add("form submission can create an external side effect");
  }

  if (/\b(pay|payment|purchase|checkout|credit.?card|bank.?transfer|crypto.?transfer|wallet)\b/.test(serialized)) {
    reasons.add("money-related operation");
  }

  return { risky: reasons.size > 0, reasons: [...reasons] };
}

export class SecretRedactor {
  private readonly secrets: string[];

  public constructor(secrets: Array<string | undefined> = []) {
    this.secrets = secrets.filter((value): value is string => typeof value === "string" && value.length >= 4).sort((a, b) => b.length - a.length);
  }

  public redactText(input: string): string {
    let output = input;
    for (const secret of this.secrets) output = output.split(secret).join("[REDACTED]");
    output = output.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [REDACTED]");
    output = output.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_TOKEN]");
    output = output.replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]");
    output = output.replace(/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/g, "[REDACTED_PEM_BLOCK]");
    output = output.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]");
    output = output.replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]");
    output = output.replace(
      /\b(token|secret|password|passwd|api[_-]?key|authorization)(\s*[=:]\s*)(["']?)[^\s,"'}]{8,}\3/gi,
      (_match, label: string, separator: string) => `${label}${separator}[REDACTED]`,
    );
    return output;
  }

  public redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
    if (typeof value === "string") return this.redactText(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item, seen));

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/token|secret|password|authorization|api.?key/i.test(key)) output[key] = "[REDACTED]";
      else output[key] = this.redactValue(item, seen);
    }
    return output;
  }
}

export function sanitizedChildEnvironment(workspaceRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TERM: process.env.TERM ?? "dumb",
    CI: "true",
    HOME: workspaceRoot,
    TMPDIR: resolve(workspaceRoot, ".agent", "tmp"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    NO_COLOR: "1",
  };
}
