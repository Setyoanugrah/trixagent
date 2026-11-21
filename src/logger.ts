import { SecretRedactor } from "./security.js";

type LogLevel = "debug" | "info" | "warn" | "error";

export class Logger {
  public constructor(private readonly redactor: SecretRedactor) {}

  public debug(event: string, fields: Record<string, unknown> = {}): void {
    if (process.env.LOG_LEVEL === "debug") this.write("debug", event, fields);
  }

  public info(event: string, fields: Record<string, unknown> = {}): void {
    this.write("info", event, fields);
  }

  public warn(event: string, fields: Record<string, unknown> = {}): void {
    this.write("warn", event, fields);
  }

  public error(event: string, fields: Record<string, unknown> = {}): void {
    this.write("error", event, fields);
  }

  private write(level: LogLevel, event: string, fields: Record<string, unknown>): void {
    const entry = this.redactor.redactValue({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...fields,
    });
    const line = JSON.stringify(entry);
    if (level === "error") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}
