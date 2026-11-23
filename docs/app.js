"use strict";

(() => {
  const STATUS_URL = "https://drive.rikuzetsi.my.id/api/agent/public-status";
  const POLL_INTERVAL_MS = 20_000;
  const REQUEST_TIMEOUT_MS = 8_000;
  const MAX_BACKOFF_MS = 160_000;
  const DEFAULT_STALE_AFTER_SECONDS = 120;

  const elements = {};
  const ids = [
    "live-state",
    "state-context",
    "state-announcement",
    "last-checked",
    "next-check",
    "api-transport",
    "status-detail",
    "refresh-button",
    "operating-mode",
    "snapshot-note",
    "lease-state",
    "lease-caption",
    "lease-expiry",
    "lease-handoff",
    "runner-state",
    "runner-caption",
    "runner-last-seen",
    "runner-recency",
    "task-state",
    "task-caption",
    "task-iteration",
    "task-updated",
    "queue-waiting",
    "queue-running",
    "queue-approval",
    "queue-total",
    "memory-messages",
    "memory-tasks",
    "memory-bytes",
    "tools-completed",
    "tools-running",
    "tools-failed",
    "tools-total",
    "activity-list",
  ];

  let pollTimer;
  let clockTimer;
  let nextPollAt = 0;
  let inFlight = false;
  let failureCount = 0;
  let lastSnapshot = null;
  let lastAnnouncedState = "booting";

  function initialize() {
    for (const id of ids) elements[id] = document.getElementById(id);
    elements["refresh-button"].addEventListener("click", pollNow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", pollNow);
    window.addEventListener("offline", () => renderUnavailable("Browser network is offline."));
    clockTimer = window.setInterval(updateClocks, 1_000);
    updateClocks();
    void pollStatus();
  }

  function pollNow() {
    if (inFlight) return;
    window.clearTimeout(pollTimer);
    void pollStatus();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible" && !inFlight && Date.now() >= nextPollAt) pollNow();
  }

  async function pollStatus() {
    if (inFlight) return;
    inFlight = true;
    elements["refresh-button"].disabled = true;
    elements["refresh-button"].textContent = "Checking";
    elements["next-check"].textContent = "Checking now";

    try {
      const payload = await fetchPublicStatus();
      const snapshot = normalizeStatus(payload);
      failureCount = 0;
      lastSnapshot = snapshot;
      renderSnapshot(snapshot);
    } catch (error) {
      failureCount += 1;
      const message = error instanceof Error ? error.message : "Public status request failed.";
      renderUnavailable(message);
    } finally {
      inFlight = false;
      elements["refresh-button"].disabled = false;
      elements["refresh-button"].textContent = "Check now";
      const delay = failureCount === 0
        ? POLL_INTERVAL_MS
        : Math.min(POLL_INTERVAL_MS * (2 ** Math.min(failureCount - 1, 3)), MAX_BACKOFF_MS);
      schedulePoll(delay);
    }
  }

  async function fetchPublicStatus() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(STATUS_URL, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Public status returned HTTP ${response.status}.`);
      const payload = await response.json();
      if (!isRecord(payload)) throw new Error("Public status returned an invalid payload.");
      return payload;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("Public status timed out after 8 seconds.");
      }
      if (error instanceof SyntaxError) throw new Error("Public status returned invalid JSON.");
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function schedulePoll(delay) {
    window.clearTimeout(pollTimer);
    nextPollAt = Date.now() + delay;
    pollTimer = window.setTimeout(() => void pollStatus(), delay);
    updateClocks();
  }

  function normalizeStatus(payload) {
    const root = isRecord(payload.data) ? payload.data : payload;
    const agent = record(root.agent);
    const lease = record(firstDefined(root.lease, agent.lease));
    const runner = record(firstDefined(root.runner, root.active_runner, agent.runner));
    const taskAggregate = record(root.tasks);
    const task = record(firstDefined(root.current_task, root.task, agent.current_task, {
      status: taskAggregate.last_status,
      iteration: taskAggregate.last_iteration,
      updated_at: taskAggregate.last_updated_at,
    }));
    const queue = record(firstDefined(root.queue, root.queues, agent.queue, taskAggregate));
    const stats = record(firstDefined(root.stats, agent.stats));
    const memory = record(firstDefined(root.memory, stats.memory, agent.memory));
    const tools = record(firstDefined(root.tools, root.tool_stats, stats.tools, agent.tools));

    const generatedAt = parseTimestamp(firstDefined(
      root.generated_at,
      root.checked_at,
      root.updated_at,
      payload.generated_at,
      payload.updated_at,
    ));
    const leaseExpiresAt = parseTimestamp(firstDefined(lease.expires_at, lease.expiresAt, root.lease_expires_at));
    const leaseUpdatedAt = parseTimestamp(firstDefined(lease.updated_at, lease.updatedAt));
    const contenderSeenAt = parseTimestamp(firstDefined(lease.contender_seen_at, lease.contenderSeenAt));
    const runnerLastSeenAt = parseTimestamp(firstDefined(
      runner.last_seen_at,
      runner.lastSeenAt,
      runner.heartbeat_at,
      runner.updated_at,
      root.runner_last_seen_at,
    ));
    const taskUpdatedAt = parseTimestamp(firstDefined(task.updated_at, task.updatedAt));

    const leaseActiveFlag = toBoolean(firstDefined(lease.active, lease.held, lease.holder_present, root.lease_active, root.lease_held));
    const leaseActive = leaseActiveFlag ?? (leaseExpiresAt === null ? null : leaseExpiresAt > Date.now());
    const contender = toBoolean(firstDefined(lease.contender, lease.handoff_ready, root.handoff_ready))
      ?? toBoolean(lease.contender_present)
      ?? (firstDefined(lease.contender_id, lease.contenderId) != null)
      ?? false;

    const waiting = toCount(firstDefined(queue.waiting, queue.pending, queue.queued, root.queue_waiting));
    const running = toCount(firstDefined(queue.running, queue.active, root.queue_running));
    const approval = toCount(firstDefined(
      queue.waiting_approval,
      queue.waitingApproval,
      queue.approval,
      queue.approvals,
      root.queue_waiting_approval,
    ));
    const explicitTotal = toCount(firstDefined(queue.total, queue.open, root.queue_total));
    const queueValues = [waiting, running, approval];
    const total = explicitTotal ?? (queueValues.every((value) => value !== null)
      ? queueValues.reduce((sum, value) => sum + value, 0)
      : null);

    const toolCompleted = toCount(firstDefined(tools.completed, tools.succeeded, tools.success));
    const toolRunning = toCount(firstDefined(tools.running, tools.pending, tools.in_flight, tools.inFlight));
    const toolFailed = toCount(firstDefined(tools.failed, tools.errors));
    const explicitToolTotal = toCount(firstDefined(tools.total, tools.count));
    const toolValues = [toolCompleted, toolRunning, toolFailed];
    const toolTotal = explicitToolTotal ?? (toolValues.every((value) => value !== null)
      ? toolValues.reduce((sum, value) => sum + value, 0)
      : null);

    const status = normalizedStatus(firstDefined(root.status, root.state, root.agent_status, agent.status));
    const runnerStatus = normalizedStatus(firstDefined(runner.status, runner.state, root.runner_status));
    const taskStatus = normalizedStatus(firstDefined(task.status, task.state));
    const online = toBoolean(firstDefined(root.online, root.is_online, agent.online, runner.online));
    const staleAfterSeconds = toPositiveNumber(firstDefined(
      root.stale_after_seconds,
      runner.stale_after_seconds,
      runner.staleAfterSeconds,
    )) ?? DEFAULT_STALE_AFTER_SECONDS;

    const snapshot = {
      generatedAt,
      status,
      online,
      staleAfterSeconds,
      lease: {
        active: leaseActive,
        expiresAt: leaseExpiresAt,
        updatedAt: leaseUpdatedAt,
        contender,
        contenderSeenAt,
      },
      runner: {
        status: runnerStatus,
        lastSeenAt: runnerLastSeenAt,
      },
      task: {
        status: taskStatus,
        iteration: toCount(firstDefined(task.iteration, task.step)),
        updatedAt: taskUpdatedAt,
      },
      queue: { waiting, running, approval, total },
      memory: {
        messages: toCount(firstDefined(memory.messages, memory.message_count, memory.retained_messages)),
        tasks: toCount(firstDefined(memory.tasks, memory.task_count, memory.task_records, memory.summaries, taskAggregate.total)),
        bytes: toCount(firstDefined(memory.bytes, memory.state_bytes, memory.size_bytes, stats.state_bytes)),
      },
      tools: {
        completed: toolCompleted,
        running: toolRunning,
        failed: toolFailed,
        total: toolTotal ?? toCount(memory.tool_runs),
      },
    };

    snapshot.displayState = deriveDisplayState(snapshot);
    snapshot.standby = deriveStandby(snapshot);
    return snapshot;
  }

  function deriveDisplayState(snapshot) {
    const status = snapshot.status;
    const runnerStatus = snapshot.runner.status;
    const bootStates = new Set(["booting", "starting", "initializing"]);
    const offlineStates = new Set(["offline", "stopped", "shutdown", "unavailable"]);
    const onlineStates = new Set(["online", "active", "ready", "running", "standby", "idle", "waiting"]);

    if (bootStates.has(status) || bootStates.has(runnerStatus)) return "booting";
    if (snapshot.online === false || offlineStates.has(status) || offlineStates.has(runnerStatus)) return "offline";
    if (snapshot.runner.lastSeenAt !== null
      && Date.now() - snapshot.runner.lastSeenAt > snapshot.staleAfterSeconds * 1_000) return "offline";
    if (snapshot.online === true || onlineStates.has(status) || onlineStates.has(runnerStatus)) return "online";
    if (snapshot.lease.active === true || snapshot.runner.lastSeenAt !== null) return "online";
    if (snapshot.lease.active === false && snapshot.lease.expiresAt !== null) return "offline";
    return "booting";
  }

  function deriveStandby(snapshot) {
    const standbyStates = new Set(["standby", "idle", "waiting"]);
    if (standbyStates.has(snapshot.status) || standbyStates.has(snapshot.runner.status)) return true;
    if (snapshot.displayState !== "online") return false;
    const activeTask = new Set(["running", "waiting_approval"]);
    if (activeTask.has(snapshot.task.status)) return false;
    return snapshot.queue.running === 0 || (snapshot.task.status === "unknown" && snapshot.queue.total === 0);
  }

  function renderSnapshot(snapshot) {
    document.body.dataset.agentState = snapshot.displayState;
    document.body.dataset.stale = "false";

    const visualState = snapshot.displayState.toUpperCase();
    setText("live-state", visualState);
    setText("api-transport", "CONNECTED");
    setText("status-detail", "Public aggregate received without credentials.");
    setCheckedTime(Date.now());

    let context;
    let mode;
    if (snapshot.displayState === "online" && snapshot.standby) {
      context = "Online and standing by for the next Telegram task.";
      mode = "ONLINE · STANDBY";
    } else if (snapshot.displayState === "online") {
      context = snapshot.task.status === "unknown"
        ? "Runner heartbeat and lease are current."
        : `Current task is ${humanStatus(snapshot.task.status)}.`;
      mode = snapshot.task.status === "unknown" ? "ONLINE" : `ONLINE · ${snapshot.task.status.toUpperCase()}`;
    } else if (snapshot.displayState === "offline") {
      context = "No current runner heartbeat is confirmed by the aggregate.";
      mode = "OFFLINE";
    } else {
      context = "The service is reachable while the runner initializes.";
      mode = "BOOTING";
    }

    setText("state-context", context);
    setText("operating-mode", mode);
    announceState(snapshot.displayState, context);

    if (snapshot.generatedAt !== null) {
      setText("snapshot-note", `Snapshot generated ${relativeTime(snapshot.generatedAt)}.`);
    } else {
      setText("snapshot-note", "Current aggregate response; source timestamp not supplied.");
    }

    renderLease(snapshot.lease);
    renderRunner(snapshot.runner, snapshot.staleAfterSeconds);
    renderTask(snapshot.task, snapshot.standby);
    renderCounts(snapshot);
    renderTimeline(snapshot);
  }

  function renderLease(lease) {
    let state = "UNKNOWN";
    let caption = "Lease state not supplied";
    if (lease.active === true) {
      state = "HELD";
      caption = "Single active runner selected";
    } else if (lease.active === false) {
      state = lease.expiresAt !== null && lease.expiresAt <= Date.now() ? "EXPIRED" : "RELEASED";
      caption = "No active lease confirmed";
    }
    setText("lease-state", state);
    setText("lease-caption", caption);
    setTime("lease-expiry", lease.expiresAt, "—");
    setText("lease-handoff", lease.contender ? "STANDBY SEEN" : lease.active === null ? "—" : "CLEAR");
  }

  function renderRunner(runner, staleAfterSeconds) {
    const status = runner.status === "unknown" ? "UNKNOWN" : runner.status.toUpperCase();
    setText("runner-state", status);
    setText("runner-caption", runner.status === "unknown" ? "Runner state not supplied" : `Aggregate runner state: ${humanStatus(runner.status)}`);
    setTime("runner-last-seen", runner.lastSeenAt, "—");
    if (runner.lastSeenAt === null) {
      setText("runner-recency", "—");
      return;
    }
    const ageSeconds = Math.max(0, Math.floor((Date.now() - runner.lastSeenAt) / 1_000));
    setText("runner-recency", ageSeconds > staleAfterSeconds ? "STALE" : "CURRENT");
  }

  function renderTask(task, standby) {
    const noTask = task.status === "unknown";
    setText("task-state", noTask ? (standby ? "NONE" : "UNKNOWN") : task.status.toUpperCase());
    setText("task-caption", noTask ? (standby ? "No active aggregate task" : "Task state not supplied") : `Current task is ${humanStatus(task.status)}`);
    setText("task-iteration", task.iteration === null ? "—" : formatCount(task.iteration));
    setTime("task-updated", task.updatedAt, "—");
  }

  function renderCounts(snapshot) {
    setCount("queue-waiting", snapshot.queue.waiting);
    setCount("queue-running", snapshot.queue.running);
    setCount("queue-approval", snapshot.queue.approval);
    setCount("queue-total", snapshot.queue.total);
    setCount("memory-messages", snapshot.memory.messages);
    setCount("memory-tasks", snapshot.memory.tasks);
    setText("memory-bytes", snapshot.memory.bytes === null ? "—" : formatBytes(snapshot.memory.bytes));
    setCount("tools-completed", snapshot.tools.completed);
    setCount("tools-running", snapshot.tools.running);
    setCount("tools-failed", snapshot.tools.failed);
    setCount("tools-total", snapshot.tools.total);
  }

  function renderTimeline(snapshot) {
    const events = [];
    if (snapshot.generatedAt !== null) {
      events.push({
        time: snapshot.generatedAt,
        title: "Aggregate snapshot",
        detail: "Public status snapshot generated by the source.",
      });
    }
    if (snapshot.runner.lastSeenAt !== null) {
      events.push({
        time: snapshot.runner.lastSeenAt,
        title: "Runner heartbeat",
        detail: snapshot.runner.status === "unknown"
          ? "Runner last-seen timestamp recorded."
          : `Runner reported ${humanStatus(snapshot.runner.status)}.`,
      });
    }
    if (snapshot.task.updatedAt !== null) {
      const iteration = snapshot.task.iteration === null ? "iteration not supplied" : `iteration ${formatCount(snapshot.task.iteration)}`;
      events.push({
        time: snapshot.task.updatedAt,
        title: "Current task updated",
        detail: `${humanStatus(snapshot.task.status)} · ${iteration}.`,
      });
    }
    if (snapshot.lease.updatedAt !== null) {
      events.push({
        time: snapshot.lease.updatedAt,
        title: "Lease record updated",
        detail: snapshot.lease.active === true ? "Active runner lease confirmed." : "Lease is not active.",
      });
    }
    if (snapshot.lease.contenderSeenAt !== null) {
      events.push({
        time: snapshot.lease.contenderSeenAt,
        title: "Standby runner observed",
        detail: "Aggregate lease data reports a handoff contender.",
      });
    }

    events.sort((left, right) => right.time - left.time);
    elements["activity-list"].replaceChildren();
    if (events.length === 0) {
      renderEmptyTimeline("No timestamped aggregate activity is present in this snapshot.");
      return;
    }

    for (const event of events.slice(0, 5)) {
      const item = document.createElement("li");
      const time = document.createElement("time");
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      const detail = document.createElement("span");

      time.dateTime = new Date(event.time).toISOString();
      time.textContent = formatExactTime(event.time);
      time.title = relativeTime(event.time);
      copy.className = "activity-copy";
      title.textContent = event.title;
      detail.textContent = event.detail;
      copy.append(title, detail);
      item.append(time, copy);
      elements["activity-list"].append(item);
    }
  }

  function renderEmptyTimeline(message) {
    const item = document.createElement("li");
    item.className = "activity-empty";
    item.textContent = message;
    elements["activity-list"].replaceChildren(item);
  }

  function renderUnavailable(message) {
    document.body.dataset.agentState = "unavailable";
    document.body.dataset.stale = lastSnapshot === null ? "false" : "true";
    setText("live-state", "API UNAVAILABLE");
    setText("state-context", "The public API did not return a current snapshot. Agent state is not inferred.");
    setText("operating-mode", "API UNAVAILABLE");
    setText("api-transport", "RETRYING");
    setText("status-detail", sanitizeMessage(message));
    setCheckedTime(Date.now());
    setText("snapshot-note", lastSnapshot === null
      ? "No aggregate snapshot is available."
      : "Showing the last valid snapshot as stale data.");
    announceState("unavailable", "Public status API is unavailable; no agent state is inferred.");
    if (lastSnapshot === null) renderEmptyTimeline("No aggregate activity is available while the status API is unreachable.");
  }

  function announceState(state, context) {
    if (state === lastAnnouncedState) return;
    lastAnnouncedState = state;
    setText("state-announcement", `TrixAgent status: ${state}. ${context}`);
  }

  function setCheckedTime(timestamp) {
    setTime("last-checked", timestamp, "Not checked yet");
  }

  function setTime(id, timestamp, fallback) {
    const element = elements[id];
    if (timestamp === null || !Number.isFinite(timestamp)) {
      delete element.dataset.timestamp;
      element.removeAttribute("datetime");
      element.removeAttribute("title");
      element.textContent = fallback;
      return;
    }
    element.dataset.timestamp = String(timestamp);
    element.dateTime = new Date(timestamp).toISOString();
    element.title = formatExactTime(timestamp);
    element.textContent = relativeTime(timestamp);
  }

  function updateClocks() {
    for (const element of document.querySelectorAll("time[data-timestamp]")) {
      const timestamp = Number(element.dataset.timestamp);
      if (Number.isFinite(timestamp)) element.textContent = relativeTime(timestamp);
    }

    if (!inFlight && nextPollAt > 0) {
      const remaining = Math.max(0, Math.ceil((nextPollAt - Date.now()) / 1_000));
      const backoff = failureCount > 1 ? " · backoff" : "";
      elements["next-check"].textContent = remaining === 0 ? "Due now" : `In ${remaining}s${backoff}`;
    }

    if (lastSnapshot !== null && document.body.dataset.agentState !== "unavailable") {
      renderRunner(lastSnapshot.runner, lastSnapshot.staleAfterSeconds);
      if (lastSnapshot.lease.expiresAt !== null) setTime("lease-expiry", lastSnapshot.lease.expiresAt, "—");
      if (lastSnapshot.task.updatedAt !== null) setTime("task-updated", lastSnapshot.task.updatedAt, "—");
    }
  }

  function setCount(id, value) {
    setText(id, value === null ? "—" : formatCount(value));
  }

  function setText(id, value) {
    elements[id].textContent = value;
  }

  function relativeTime(timestamp) {
    const deltaSeconds = Math.round((timestamp - Date.now()) / 1_000);
    const absolute = Math.abs(deltaSeconds);
    if (absolute < 5) return "just now";

    let value;
    let unit;
    if (absolute < 60) {
      value = absolute;
      unit = "s";
    } else if (absolute < 3_600) {
      value = Math.round(absolute / 60);
      unit = "m";
    } else if (absolute < 86_400) {
      value = Math.round(absolute / 3_600);
      unit = "h";
    } else {
      value = Math.round(absolute / 86_400);
      unit = "d";
    }
    return deltaSeconds < 0 ? `${value}${unit} ago` : `in ${value}${unit}`;
  }

  function formatExactTime(timestamp) {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(timestamp));
  }

  function formatCount(value) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  }

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KiB", "MiB", "GiB"];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** unitIndex);
    return `${value.toFixed(unitIndex === 0 || value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
  }

  function parseTimestamp(value) {
    if (value === null || value === undefined || value === "") return null;
    let timestamp;
    if (typeof value === "number" && Number.isFinite(value)) {
      timestamp = value < 1_000_000_000_000 ? value * 1_000 : value;
    } else if (typeof value === "string" && /^\d{10,13}$/.test(value.trim())) {
      const numeric = Number(value);
      timestamp = value.trim().length <= 10 ? numeric * 1_000 : numeric;
    } else if (typeof value === "string") {
      timestamp = Date.parse(value);
    } else {
      return null;
    }
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function normalizedStatus(value) {
    if (typeof value !== "string") return "unknown";
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
    const allowed = new Set([
      "active",
      "booting",
      "cancelled",
      "completed",
      "failed",
      "idle",
      "initializing",
      "offline",
      "online",
      "ready",
      "running",
      "shutdown",
      "standby",
      "starting",
      "stopped",
      "unavailable",
      "waiting",
      "waiting_approval",
    ]);
    return allowed.has(normalized) ? normalized : "unknown";
  }

  function humanStatus(status) {
    if (status === "unknown") return "status not supplied";
    return status.replaceAll("_", " ");
  }

  function toCount(value) {
    if (typeof value === "boolean" || value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  }

  function toPositiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function toBoolean(value) {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true") return true;
    if (value === 0 || value === "0" || value === "false") return false;
    return null;
  }

  function firstDefined(...values) {
    return values.find((value) => value !== undefined && value !== null);
  }

  function record(value) {
    return isRecord(value) ? value : {};
  }

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function sanitizeMessage(message) {
    const safeMessages = [
      "Browser network is offline.",
      "Public status timed out after 8 seconds.",
      "Public status returned an invalid payload.",
      "Public status returned invalid JSON.",
    ];
    if (safeMessages.includes(message) || /^Public status returned HTTP \d{3}\.$/.test(message)) return message;
    return "Public status could not be reached. A retry is scheduled.";
  }

  initialize();
})();
