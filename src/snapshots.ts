import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./logger.js";
import type { NebulaClient } from "./nebula.js";
import { sanitizedChildEnvironment } from "./security.js";
import { combineSignals } from "./utils.js";

export class SnapshotService {
  private active?: Promise<Record<string, unknown>>;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly nebula: NebulaClient,
    private readonly logger: Logger,
  ) {}

  public async backup(signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.active) return this.active;
    this.active = this.createBackup(signal).finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  public async restoreLatest(signal?: AbortSignal): Promise<boolean> {
    const files = await this.nebula.list(signal);
    const latest = files
      .filter((file) => file.status === "ready" && /^workspace-.*\.tar\.gz\.enc$/.test(file.name ?? ""))
      .sort((a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0))[0];
    if (!latest) return false;

    const restoreDirectory = join(this.workspaceRoot, ".agent", "restore");
    const archive = join(restoreDirectory, "workspace.tar.gz");
    await mkdir(restoreDirectory, { recursive: true, mode: 0o700 });
    try {
      await this.nebula.downloadFile(latest.id, archive, { decrypt: true }, signal);
      await runTarExtract(this.workspaceRoot, archive, signal);
      this.logger.info("snapshot.restored", { id: latest.id, name: latest.name });
      return true;
    } finally {
      await rm(archive, { force: true }).catch(() => undefined);
    }
  }

  private async createBackup(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const backupDirectory = join(this.workspaceRoot, ".agent", "backups");
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archive = join(backupDirectory, `workspace-${stamp}.tar.gz`);
    try {
      await runTar(this.workspaceRoot, archive, signal);
      const uploaded = await this.nebula.uploadFile(
        archive,
        { name: `workspace-${stamp}.tar.gz`, mimeType: "application/gzip", encrypt: true },
        signal,
      );
      this.logger.info("snapshot.uploaded", { name: `workspace-${stamp}.tar.gz.enc` });
      return uploaded;
    } finally {
      await rm(archive, { force: true }).catch(() => undefined);
    }
  }
}

async function runTar(root: string, output: string, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "tar",
      [
        "-czf",
        output,
        "--exclude=.git",
        "--exclude=node_modules",
        "--exclude=dist",
        "--exclude=.agent/backups",
        "--exclude=.npm-cache",
        ".",
      ],
      { cwd: root, env: sanitizedChildEnvironment(root), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
    });
    const timeout = AbortSignal.timeout(5 * 60_000);
    const combined = combineSignals(signal, timeout);
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    combined?.addEventListener("abort", onAbort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      combined?.removeEventListener("abort", onAbort);
      if (combined?.aborted) reject(combined.reason);
      else if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}: ${stderr}`));
    });
  });
}

async function runTarExtract(root: string, archive: string, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "tar",
      ["-xzf", archive, "-C", root, "--no-same-owner", "--no-same-permissions"],
      { cwd: root, env: sanitizedChildEnvironment(root), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
    });
    const combined = combineSignals(signal, AbortSignal.timeout(5 * 60_000));
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    combined?.addEventListener("abort", onAbort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      combined?.removeEventListener("abort", onAbort);
      if (combined?.aborted) reject(combined.reason);
      else if (code === 0) resolve();
      else reject(new Error(`tar extract exited with code ${code}: ${stderr}`));
    });
  });
}
