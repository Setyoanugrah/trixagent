import type { Logger } from "./logger.js";
import type { NebulaStateClient } from "./nebula-state.js";
import type { LeaseRecord } from "./types.js";
import { errorMessage, sleep } from "./utils.js";

export class LeaseManager {
  private heartbeatTimer?: NodeJS.Timeout;
  private expiresAt = 0;

  public constructor(
    private readonly client: NebulaStateClient,
    private readonly name: string,
    private readonly holderId: string,
    private readonly ttlSeconds: number,
    private readonly heartbeatSeconds: number,
    private readonly logger: Logger,
  ) {}

  public async acquire(signal?: AbortSignal): Promise<boolean> {
    const acquired = await this.client.acquireLease(this.name, this.holderId, this.ttlSeconds, signal);
    if (acquired) this.expiresAt = Date.now() + this.ttlSeconds * 1_000;
    return acquired;
  }

  public async acquireLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (await this.acquire(signal)) {
        this.logger.info("lease.acquired", { lease: this.name, holder: this.holderId });
        return;
      }
      const current = await this.current(signal).catch(() => undefined);
      this.logger.info("lease.waiting", {
        lease: this.name,
        holder: current?.holder_id,
        expiresAt: current?.expires_at,
        contender: this.holderId,
      });
      await sleep(10_000, signal);
    }
  }

  public startHeartbeat(onLost: (reason: Error) => void): void {
    if (this.heartbeatTimer !== undefined) return;
    this.heartbeatTimer = setInterval(() => {
      void this.renew().catch((error) => {
        this.logger.warn("lease.heartbeat_failed", { error: errorMessage(error), expiresAt: new Date(this.expiresAt).toISOString() });
        if (Date.now() + this.heartbeatSeconds * 1_000 >= this.expiresAt) {
          onLost(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }, this.heartbeatSeconds * 1_000);
    this.heartbeatTimer.unref();
  }

  public async renew(signal?: AbortSignal): Promise<void> {
    const renewed = await this.client.renewLease(this.name, this.holderId, this.ttlSeconds, signal);
    if (!renewed) throw new Error("Lease ownership was lost");
    this.expiresAt = Date.now() + this.ttlSeconds * 1_000;
  }

  public async current(signal?: AbortSignal): Promise<LeaseRecord | undefined> {
    return this.client.getLease(this.name, signal);
  }

  public async release(signal?: AbortSignal): Promise<void> {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    await this.client.releaseLease(this.name, this.holderId, this.ttlSeconds, signal);
    this.logger.info("lease.released", { lease: this.name, holder: this.holderId });
  }
}
