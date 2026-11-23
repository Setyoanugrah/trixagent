import { stat } from "node:fs/promises";
import { AgentEngine } from "./agent.js";
import { BrowserManager } from "./browser.js";
import { TelegramBotController } from "./bot.js";
import { configuredSecrets, loadConfig } from "./config.js";
import { LeaseManager } from "./lease.js";
import { Logger } from "./logger.js";
import { ModelClient } from "./model.js";
import { NebulaClient } from "./nebula.js";
import { NebulaStateClient } from "./nebula-state.js";
import { SecretRedactor } from "./security.js";
import { SnapshotService } from "./snapshots.js";
import { AgentStore } from "./store.js";
import { TelegramClient } from "./telegram.js";
import { ToolExecutor } from "./tools.js";
import { errorMessage } from "./utils.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const redactor = new SecretRedactor(configuredSecrets(config));
  const logger = new Logger(redactor);
  const shutdown = new AbortController();
  let shutdownReason = "normal";
  const requestShutdown = (reason: string): void => {
    if (shutdown.signal.aborted) return;
    shutdownReason = reason;
    logger.info("runner.shutdown_requested", { reason });
    shutdown.abort(new DOMException(reason, "AbortError"));
  };
  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  process.once("SIGINT", () => requestShutdown("SIGINT"));

  const workspace = await stat(config.workspaceRoot);
  if (!workspace.isDirectory()) throw new Error("WORKSPACE_ROOT must be an existing directory");

  const stateClient = new NebulaStateClient(config.nebulaBaseUrl, config.nebulaApiKey, logger);
  const store = new AgentStore(stateClient, config.leaseName);
  await store.load(shutdown.signal);
  await store.registerRunner(config.runnerId, config.agentModel, {
    node: process.version,
    pid: process.pid,
    workspaceRoot: config.workspaceRoot,
  });

  const lease = new LeaseManager(
    stateClient,
    config.leaseName,
    config.runnerId,
    config.leaseTtlSeconds,
    config.leaseHeartbeatSeconds,
    logger,
  );
  let leaseHeld = false;
  let runnerHeartbeat: NodeJS.Timeout | undefined;
  let snapshotTimer: NodeJS.Timeout | undefined;
  let taskKickTimer: NodeJS.Timeout | undefined;
  let engine: AgentEngine | undefined;
  let browser: BrowserManager | undefined;
  let snapshots: SnapshotService | undefined;

  try {
    await lease.acquireLoop(shutdown.signal);
    shutdown.signal.throwIfAborted();
    leaseHeld = true;
    lease.startHeartbeat((error) => requestShutdown(`Lease lost: ${error.message}`));
    await store.heartbeatRunner(config.runnerId);
    runnerHeartbeat = setInterval(() => {
      void store.heartbeatRunner(config.runnerId).catch((error) => logger.warn("runner.heartbeat_failed", { error: errorMessage(error) }));
    }, 30_000);
    runnerHeartbeat.unref();

    const nebula = new NebulaClient(config.nebulaBaseUrl, config.nebulaApiKey, store, config.stateEncryptionKey);
    if (config.snapshotOnShutdown) {
      if (!config.stateEncryptionKey) {
        logger.warn("snapshot.disabled", { reason: "STATE_ENCRYPTION_KEY is required" });
      } else {
        snapshots = new SnapshotService(config.workspaceRoot, nebula, logger);
        await snapshots.restoreLatest(shutdown.signal).catch((error) => {
          logger.warn("snapshot.restore_failed", { error: errorMessage(error) });
        });
        snapshotTimer = setInterval(() => {
          void snapshots?.backup().catch((error) => logger.warn("snapshot.periodic_failed", { error: errorMessage(error) }));
        }, config.snapshotIntervalMinutes * 60_000);
        snapshotTimer.unref();
      }
    }

    browser = new BrowserManager(
      config.workspaceRoot,
      store,
      logger,
      {
        headless: config.browserHeadless,
        ...(config.chromiumExecutablePath === undefined ? {} : { executablePath: config.chromiumExecutablePath }),
        ...(config.stateEncryptionKey === undefined ? {} : { encryptionKey: config.stateEncryptionKey }),
      },
      nebula,
    );
    const modelClient = new ModelClient(
      config.groqApiKey,
      config.geminiApiKey,
      config.agentModel,
      config.visionModel,
      config.geminiFallbackModel,
    );
    await browser.initialize().catch((error) => {
      logger.warn("browser.startup_failed", { error: errorMessage(error) });
    });
    const telegram = new TelegramClient(
      config.telegramToken,
      config.workspaceRoot,
      config.maxAttachmentBytes,
      logger,
    );
    const tools = new ToolExecutor(
      config.workspaceRoot,
      config.shellTimeoutMs,
      config.maxToolOutputBytes,
      browser,
      modelClient,
      store,
      redactor,
      nebula,
    );
    engine = new AgentEngine(config, store, modelClient, tools, telegram, logger, redactor);
    const bot = new TelegramBotController(config, telegram, store, lease, engine, browser, modelClient, logger, redactor);

    logger.info("runner.ready", {
      runnerId: config.runnerId,
      textProvider: "groq",
      model: config.agentModel,
      visionProvider: "gemini",
      visionModel: config.visionModel,
      geminiFallbackModel: config.geminiFallbackModel,
      workspaceRoot: config.workspaceRoot,
      unsafeAuto: config.unsafeAuto,
    });
    await bot.restorePendingApprovals(shutdown.signal).catch((error) => {
      logger.warn("agent.approval_restore_failed", { error: errorMessage(error) });
    });
    taskKickTimer = setInterval(() => engine?.kick(), 4_000);
    taskKickTimer.unref();
    engine.kick();
    await bot.poll(shutdown.signal);
  } finally {
    if (runnerHeartbeat !== undefined) clearInterval(runnerHeartbeat);
    if (snapshotTimer !== undefined) clearInterval(snapshotTimer);
    if (taskKickTimer !== undefined) clearInterval(taskKickTimer);
    await engine?.shutdown().catch((error) => logger.warn("runner.engine_shutdown_failed", { error: errorMessage(error) }));
    await browser?.close().catch((error) => logger.warn("runner.browser_shutdown_failed", { error: errorMessage(error) }));
    await store.stopRunner(config.runnerId).catch((error) => logger.warn("runner.stop_record_failed", { error: errorMessage(error) }));
    await store.checkpoint().catch((error) => logger.warn("runner.checkpoint_failed", { error: errorMessage(error) }));
    if (snapshots) {
      await snapshots.backup(AbortSignal.timeout(5 * 60_000)).catch((error) => logger.warn("snapshot.shutdown_failed", { error: errorMessage(error) }));
    }
    if (leaseHeld) await lease.release().catch((error) => logger.error("lease.release_failed", { error: errorMessage(error) }));
    logger.info("runner.stopped", { runnerId: config.runnerId, reason: shutdownReason });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event: "runner.fatal", error: message })}\n`);
  process.exitCode = 1;
});
