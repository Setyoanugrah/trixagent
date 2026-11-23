"use strict";

(() => {
  const API_BASE = "https://drive.rikuzetsi.my.id";
  const TOKEN_KEY = "trixagent.web.token";
  const POLL_ACTIVE_MS = 2_000;
  const POLL_WAITING_MS = 5_000;
  const POLL_IDLE_MS = 10_000;
  const STATUS_MS = 20_000;
  const REQUEST_TIMEOUT_MS = 12_000;
  const OPEN_STATUSES = new Set(["waiting", "running", "waiting_approval"]);

  const state = {
    token: sessionStorage.getItem(TOKEN_KEY) || "",
    messages: [],
    tasks: [],
    signature: "",
    activeTask: null,
    publicStatus: null,
    sending: false,
    loading: false,
    pollTimer: 0,
    statusTimer: 0,
    toastTimer: 0,
    taskModalId: null,
    taskModalTask: null,
    authError: "",
  };

  const el = {};

  class AuthError extends Error {}

  function initialize() {
    for (const id of [
      "app-shell",
      "sidebar",
      "sidebar-close",
      "sidebar-scrim",
      "menu-button",
      "new-chat",
      "task-list",
      "task-count",
      "sidebar-status",
      "sidebar-signal",
      "status-toggle",
      "settings-button",
      "status-chip",
      "top-status",
      "top-signal",
      "model-name",
      "conversation-name",
      "transcript",
      "welcome",
      "prompt-grid",
      "composer",
      "message-input",
      "send-button",
      "stop-button",
      "composer-status",
      "status-panel",
      "status-close",
      "status-refresh",
      "panel-signal",
      "panel-state",
      "panel-context",
      "panel-runner",
      "panel-lease",
      "panel-waiting",
      "panel-running",
      "panel-approval",
      "panel-completed",
      "panel-messages",
      "panel-tools",
      "panel-text-model",
      "panel-vision-model",
      "panel-updated",
      "auth-gate",
      "auth-form",
      "auth-submit",
      "token-input",
      "reveal-token",
      "auth-error",
      "task-modal",
      "task-modal-close",
      "task-modal-title",
      "task-modal-meta",
      "task-modal-messages",
      "task-modal-cancel",
      "task-modal-dismiss",
      "toast-region",
      "connection-banner",
      "connection-text",
      "connection-retry",
    ]) {
      el[id] = document.getElementById(id);
    }

    bindEvents();
    updateComposer();

    if (state.token) {
      hideAuth();
      void refreshConversation({ initial: true });
    } else {
      showAuth();
    }

    void refreshPublicStatus();
    state.statusTimer = window.setInterval(() => void refreshPublicStatus(), STATUS_MS);
  }

  function bindEvents() {
    el["auth-form"].addEventListener("submit", onAuthSubmit);
    el["reveal-token"].addEventListener("click", toggleTokenVisibility);
    el["settings-button"].addEventListener("click", showAuth);
    el["composer"].addEventListener("submit", onSend);
    el["message-input"].addEventListener("input", onInput);
    el["message-input"].addEventListener("keydown", onComposerKeydown);
    el["send-button"].addEventListener("click", onSend);
    el["stop-button"].addEventListener("click", cancelActiveTask);
    el["new-chat"].addEventListener("click", newChat);
    el["status-toggle"].addEventListener("click", toggleStatusPanel);
    el["status-chip"].addEventListener("click", toggleStatusPanel);
    el["status-close"].addEventListener("click", closeStatusPanel);
    el["status-refresh"].addEventListener("click", () => void refreshPublicStatus(true));
    el["menu-button"].addEventListener("click", openSidebar);
    el["sidebar-close"].addEventListener("click", closeSidebar);
    el["sidebar-scrim"].addEventListener("click", closeSidebar);
    el["connection-retry"].addEventListener("click", () => {
      void refreshConversation({ force: true });
      void refreshPublicStatus(true);
    });
    el["task-modal-close"].addEventListener("click", closeTaskModal);
    el["task-modal-dismiss"].addEventListener("click", closeTaskModal);
    el["task-modal-cancel"].addEventListener("click", cancelModalTask);
    el["task-modal"].addEventListener("click", (event) => {
      if (event.target === el["task-modal"]) closeTaskModal();
    });
    el["prompt-grid"].addEventListener("click", (event) => {
      const button = event.target.closest("[data-prompt]");
      if (!button) return;
      el["message-input"].value = button.dataset.prompt || "";
      autoResize();
      updateComposer();
      el["message-input"].focus();
    });
    el["task-list"].addEventListener("click", (event) => {
      const button = event.target.closest("[data-task-id]");
      if (!button) return;
      closeSidebar();
      void openTaskModal(button.dataset.taskId);
    });
    document.addEventListener("keydown", onGlobalKeydown);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void refreshConversation({ silent: true });
        void refreshPublicStatus();
      }
    });
  }

  function onGlobalKeydown(event) {
    if (event.key === "Escape") {
      if (!el["task-modal"].hidden) {
        closeTaskModal();
      } else if (!el["status-panel"].hidden) {
        closeStatusPanel();
      } else if (el.sidebar.classList.contains("is-open")) {
        closeSidebar();
      }
    }
    if (
      event.key.toLowerCase() === "n" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      el["auth-gate"].hidden &&
      el["task-modal"].hidden &&
      el["status-panel"].hidden &&
      !isEditable(document.activeElement)
    ) {
      event.preventDefault();
      void newChat();
    }
  }

  function isEditable(node) {
    return node instanceof HTMLElement && (
      node.tagName === "INPUT" ||
      node.tagName === "TEXTAREA" ||
      node.isContentEditable
    );
  }

  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const headers = { Accept: "application/json" };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: options.method || "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      let payload = null;
      if (response.status !== 204) {
        payload = await response.json().catch(() => null);
      }
      if (response.status === 401) throw new AuthError("Access key was rejected.");
      if (response.status === 503) throw new Error("Web chat is not configured on the runner yet.");
      if (!response.ok) {
        const message = payload && typeof payload.error === "string" ? payload.error : `Request failed with HTTP ${response.status}.`;
        throw new Error(message);
      }
      return payload;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new Error("The request timed out.");
      if (error instanceof TypeError) throw new Error("Could not reach the runner.");
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function onAuthSubmit(event) {
    event.preventDefault();
    const token = el["token-input"].value.trim();
    if (!token) {
      setAuthError("Paste the access key first.");
      return;
    }
    el["auth-submit"].disabled = true;
    el["auth-submit"].textContent = "Checking…";
    setAuthError("");
    const previous = state.token;
    state.token = token;
    try {
      await api("/api/agent/web/conversation");
      sessionStorage.setItem(TOKEN_KEY, token);
      hideAuth();
      el["token-input"].value = "";
      showToast("Console unlocked.");
      await refreshConversation({ force: true });
      void refreshPublicStatus(true);
    } catch (error) {
      state.token = previous;
      sessionStorage.removeItem(TOKEN_KEY);
      setAuthError(error instanceof AuthError ? "That key was rejected." : error.message);
    } finally {
      el["auth-submit"].disabled = false;
      el["auth-submit"].textContent = "Enter console";
    }
  }

  function showAuth() {
    el["auth-gate"].hidden = false;
    el["auth-error"].hidden = true;
    el["auth-error"].textContent = "";
    if (state.token) el["token-input"].value = state.token;
    window.setTimeout(() => el["token-input"].focus(), 30);
  }

  function hideAuth() {
    el["auth-gate"].hidden = true;
  }

  function setAuthError(message) {
    state.authError = message;
    el["auth-error"].hidden = !message;
    el["auth-error"].textContent = message;
  }

  function toggleTokenVisibility() {
    const input = el["token-input"];
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    el["reveal-token"].textContent = reveal ? "Hide" : "Show";
    el["reveal-token"].setAttribute("aria-label", reveal ? "Hide access key" : "Show access key");
  }

  async function refreshConversation(options = {}) {
    if (!state.token || state.loading) return;
    state.loading = true;
    try {
      const payload = await api("/api/agent/web/conversation");
      applyConversation(payload, options);
      hideConnectionError();
      if (options.initial) showConnectionReady();
    } catch (error) {
      if (error instanceof AuthError) {
        state.token = "";
        sessionStorage.removeItem(TOKEN_KEY);
        showAuth();
        setAuthError("Your session key expired. Unlock again.");
        return;
      }
      if (!options.silent) showConnectionError(error.message);
      if (options.force) showToast(error.message, "error");
    } finally {
      state.loading = false;
      scheduleConversationPoll();
    }
  }

  function applyConversation(payload, options = {}) {
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
    const nextSignature = JSON.stringify({ messages, tasks });
    const changed = nextSignature !== state.signature;
    state.messages = messages;
    state.tasks = tasks;
    state.activeTask = latestOpenTask(tasks);
    if (changed) {
      state.signature = nextSignature;
      renderTaskList();
      renderMessages({ stick: options.force === true || options.initial === true || isNearBottom() });
      updateComposer();
    } else {
      updateComposer();
    }
  }

  function latestOpenTask(tasks) {
    return tasks.find((task) => OPEN_STATUSES.has(task.status)) || null;
  }

  function renderMessages(options = {}) {
    const stick = options.stick !== false;
    for (const node of Array.from(el.transcript.children)) {
      if (node !== el.welcome) node.remove();
    }

    if (state.messages.length === 0) {
      el.welcome.hidden = false;
    } else {
      el.welcome.hidden = true;
      for (const message of state.messages) {
        el.transcript.append(renderMessage(message));
      }
    }

    const task = latestTask();
    if (task && task.status === "running") {
      el.transcript.append(renderTaskNote("Working", `Iteration ${task.iteration || 0}. The runner is inspecting or executing.`, "thinking"));
    } else if (task && task.status === "waiting") {
      el.transcript.append(renderTaskNote("Queued", "Waiting for the active runner to pick up this task.", "thinking"));
    } else if (task && task.status === "waiting_approval") {
      el.transcript.append(renderTaskNote(
        "Approval required",
        "A risky tool call is paused. Open Telegram to approve or reject it; this console will update automatically.",
        "note",
      ));
    } else if (task && task.status === "failed" && task.last_error) {
      el.transcript.append(renderTaskNote("Task failed", task.last_error, "note"));
    }

    if (stick) scrollToBottom();
  }

  function renderMessage(message) {
    const article = document.createElement("article");
    article.className = `message ${message.role === "user" ? "user" : "agent"}`;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = message.role === "user" ? "Y" : "T";

    const content = document.createElement("div");
    const head = document.createElement("div");
    head.className = "message-head";
    const author = document.createElement("strong");
    author.textContent = message.role === "user" ? "You" : "TrixAgent";
    const time = document.createElement("time");
    time.dateTime = message.created_at || "";
    time.textContent = formatTime(message.created_at);
    head.append(author, time);

    const body = document.createElement("div");
    body.className = "message-body";
    renderRichText(body, message.content || "");

    content.append(head, body);
    article.append(avatar, content);
    return article;
  }

  function renderTaskNote(label, text, kind) {
    const note = document.createElement("div");
    note.className = kind === "thinking" ? "thinking" : "task-note";
    if (kind === "thinking") {
      const dots = document.createElement("span");
      dots.className = "thinking-dots";
      dots.setAttribute("aria-hidden", "true");
      for (let index = 0; index < 3; index += 1) dots.append(document.createElement("i"));
      const copy = document.createElement("span");
      copy.textContent = `${label} · ${text}`;
      note.append(dots, copy);
    } else {
      const strong = document.createElement("strong");
      strong.textContent = `${label}: `;
      note.append(strong, document.createTextNode(text));
    }
    return note;
  }

  function renderRichText(parent, text) {
    const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
    let cursor = 0;
    let match;
    while ((match = fence.exec(text)) !== null) {
      if (match.index > cursor) appendProse(parent, text.slice(cursor, match.index));
      appendCodeBlock(parent, (match[1] || "").trim(), match[2] || "");
      cursor = fence.lastIndex;
    }
    if (cursor < text.length) appendProse(parent, text.slice(cursor));
  }

  function appendProse(parent, text) {
    const blocks = text.replace(/^\n+|\n+$/g, "").split(/\n{2,}/);
    for (const block of blocks) {
      if (!block.trim()) continue;
      const paragraph = document.createElement("p");
      const lines = block.split("\n");
      lines.forEach((line, index) => {
        appendInline(paragraph, line);
        if (index < lines.length - 1) paragraph.append(document.createElement("br"));
      });
      parent.append(paragraph);
    }
  }

  function appendInline(parent, text) {
    const parts = text.split(/(`[^`\n]+`)/g);
    for (const part of parts) {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        const code = document.createElement("code");
        code.textContent = part.slice(1, -1);
        parent.append(code);
      } else if (part) {
        parent.append(document.createTextNode(part));
      }
    }
  }

  function appendCodeBlock(parent, language, code) {
    const block = document.createElement("div");
    block.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-head";
    const label = document.createElement("span");
    label.textContent = language || "code";
    const copy = document.createElement("button");
    copy.className = "copy-code";
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(code).then(() => {
        copy.textContent = "Copied";
        window.setTimeout(() => { copy.textContent = "Copy"; }, 1_500);
      }).catch(() => showToast("Clipboard is unavailable.", "error"));
    });
    head.append(label, copy);
    const pre = document.createElement("pre");
    const codeEl = document.createElement("code");
    codeEl.textContent = code.replace(/\n$/, "");
    pre.append(codeEl);
    block.append(head, pre);
    parent.append(block);
  }

  function renderTaskList() {
    el["task-list"].replaceChildren();
    el["task-count"].textContent = String(state.tasks.length);
    if (state.tasks.length === 0) {
      const empty = document.createElement("p");
      empty.className = "sidebar-empty";
      empty.textContent = "Tasks appear here once you send the first message.";
      el["task-list"].append(empty);
      return;
    }

    for (const task of state.tasks.slice(0, 12)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "task-item";
      button.dataset.taskId = task.id;
      const dot = document.createElement("span");
      dot.className = "task-state-dot";
      dot.dataset.status = task.status;
      dot.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = taskTitle(task);
      const meta = document.createElement("small");
      meta.textContent = `${statusLabel(task.status)} · ${relativeTime(task.updated_at || task.created_at)}`;
      copy.append(title, meta);
      button.append(dot, copy);
      el["task-list"].append(button);
    }
  }

  function taskTitle(task) {
    const message = state.messages.find((item) => item.task_id === task.id && item.role === "user");
    const text = (message?.content || "Task").replace(/\s+/g, " ").trim();
    return text.length > 58 ? `${text.slice(0, 58)}…` : text;
  }

  function statusLabel(status) {
    return {
      waiting: "Queued",
      running: "Running",
      waiting_approval: "Approval",
      completed: "Complete",
      failed: "Failed",
      cancelled: "Cancelled",
    }[status] || "Task";
  }

  function relativeTime(value) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return "just now";
    const seconds = Math.round((Date.now() - timestamp) / 1000);
    if (seconds < 45) return "just now";
    if (seconds < 3_600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h ago`;
    return `${Math.round(seconds / 86_400)}d ago`;
  }

  function formatTime(value) {
    const timestamp = Date.parse(value || "");
    if (!Number.isFinite(timestamp)) return "";
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(timestamp);
  }

  function onInput() {
    autoResize();
    updateComposer();
  }

  function autoResize() {
    const input = el["message-input"];
    input.style.height = "auto";
    input.style.height = `${Math.min(210, Math.max(54, input.scrollHeight))}px`;
  }

  function onComposerKeydown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!el["send-button"].disabled) void onSend(event);
  }

  async function onSend(event) {
    event.preventDefault();
    if (state.sending || !state.token) return;
    const content = el["message-input"].value.trim();
    if (!content) return;

    state.sending = true;
    el["message-input"].value = "";
    autoResize();
    updateComposer();

    const optimistic = {
      id: `local-${Date.now()}`,
      task_id: null,
      role: "user",
      kind: "text",
      content,
      created_at: new Date().toISOString(),
    };
    state.messages.push(optimistic);
    state.signature = "";
    renderMessages({ stick: true });

    try {
      const payload = await api("/api/agent/web/message", { method: "POST", body: { content } });
      if (payload?.task?.id) {
        state.activeTask = payload.task;
      }
      await refreshConversation({ force: true, silent: true });
      showToast("Task queued. The runner will pick it up.");
    } catch (error) {
      state.messages = state.messages.filter((message) => message.id !== optimistic.id);
      state.signature = "";
      renderMessages({ stick: true });
      el["message-input"].value = content;
      autoResize();
      updateComposer();
      if (error instanceof AuthError) {
        state.token = "";
        sessionStorage.removeItem(TOKEN_KEY);
        showAuth();
        setAuthError("Your session key expired. Unlock again.");
      } else {
        showToast(error.message, "error");
      }
    } finally {
      state.sending = false;
      updateComposer();
      scheduleConversationPoll();
      el["message-input"].focus();
    }
  }

  function updateComposer() {
    const input = el["message-input"];
    const active = state.activeTask;
    const canSend = Boolean(state.token) && !state.sending && input.value.trim().length > 0;
    el["send-button"].disabled = !canSend;
    el["stop-button"].hidden = !active;
    if (state.sending) {
      el["composer-status"].textContent = "Queueing";
      el["composer-status"].dataset.state = "active";
    } else if (active) {
      el["composer-status"].textContent = statusLabel(active.status);
      el["composer-status"].dataset.state = active.status === "waiting_approval" ? "error" : "active";
    } else {
      el["composer-status"].textContent = "Ready";
      el["composer-status"].dataset.state = "";
    }
  }

  async function cancelActiveTask() {
    const task = latestOpenTask(state.tasks);
    if (!task) return;
    el["stop-button"].disabled = true;
    try {
      await api(`/api/agent/web/task/${encodeURIComponent(task.id)}/cancel`, { method: "POST" });
      showToast("Cancellation recorded.");
      await refreshConversation({ force: true, silent: true });
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      el["stop-button"].disabled = false;
      updateComposer();
    }
  }

  async function newChat() {
    if (!state.token) {
      showAuth();
      return;
    }
    const open = latestOpenTask(state.tasks);
    if (open && !window.confirm("Start a new chat? Open web tasks will be cancelled. Telegram context stays untouched.")) return;
    try {
      await api("/api/agent/web/new", { method: "POST" });
      state.messages = [];
      state.signature = "";
      state.activeTask = null;
      renderMessages({ stick: false });
      await refreshConversation({ force: true, silent: true });
      showToast("New chat started.");
      closeSidebar();
      el["message-input"].focus();
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  function scheduleConversationPoll() {
    window.clearTimeout(state.pollTimer);
    const active = latestOpenTask(state.tasks);
    let delay = POLL_IDLE_MS;
    if (state.sending || active?.status === "running" || active?.status === "waiting") delay = POLL_ACTIVE_MS;
    else if (active?.status === "waiting_approval") delay = POLL_WAITING_MS;
    if (document.visibilityState === "hidden") delay = Math.max(delay, 15_000);
    state.pollTimer = window.setTimeout(() => void refreshConversation({ silent: true }), delay);
  }

  function latestTask() {
    return state.tasks[0] || null;
  }

  function isNearBottom() {
    return el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 160;
  }

  function scrollToBottom() {
    window.requestAnimationFrame(() => {
      el.transcript.scrollTop = el.transcript.scrollHeight;
    });
  }

  function showConnectionReady() {
    hideConnectionError();
  }

  function showConnectionError(message) {
    el["connection-text"].textContent = message || "Connection lost. Retrying…";
    el["connection-banner"].hidden = false;
  }

  function hideConnectionError() {
    el["connection-banner"].hidden = true;
  }

  function showToast(message, kind = "info") {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.dataset.kind = kind;
    toast.textContent = message;
    el["toast-region"].append(toast);
    window.setTimeout(() => toast.remove(), 4_200);
  }

  async function refreshPublicStatus(force = false) {
    try {
      const response = await fetch(`${API_BASE}/api/agent/public-status`, {
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Status HTTP ${response.status}`);
      const payload = await response.json();
      applyPublicStatus(payload);
    } catch {
      applyPublicStatus(null);
      if (force) showToast("Public status is unavailable.", "error");
    }
  }

  function applyPublicStatus(payload) {
    state.publicStatus = payload;
    const online = Boolean(payload?.ok && payload?.online);
    const taskSummary = payload?.tasks || {};
    const running = Number(taskSummary.running || 0);
    const statusState = online ? (running > 0 ? "busy" : "online") : "offline";
    const statusText = online ? (running > 0 ? "Running a task" : "Online") : "Offline";
    const runnerStatus = payload?.runner?.status || "unknown";
    const model = payload?.runner?.model || "";

    for (const dot of [el["sidebar-signal"], el["top-signal"], el["panel-signal"]]) {
      dot.dataset.state = statusState;
    }
    el["sidebar-status"].textContent = statusText;
    el["top-status"].textContent = online ? (running > 0 ? "Working" : "Online") : "Offline";
    el["panel-state"].textContent = online ? "Runner online" : "Runner offline";
    el["panel-context"].textContent = online
      ? `Lease held by the active runner. Status: ${runnerStatus}.`
      : "No live lease and no recent runner heartbeat.";
    el["panel-runner"].textContent = online ? runnerLabel(runnerStatus) : "—";
    el["panel-lease"].textContent = payload?.lease?.holder_present ? "Held" : "Open";
    el["panel-waiting"].textContent = count(taskSummary.waiting);
    el["panel-running"].textContent = count(taskSummary.running);
    el["panel-approval"].textContent = count(taskSummary.waiting_approval);
    el["panel-completed"].textContent = count(taskSummary.completed);
    el["panel-messages"].textContent = count(payload?.memory?.messages);
    el["panel-tools"].textContent = count(payload?.memory?.tool_runs);
    el["panel-text-model"].textContent = payload?.providers?.text || "Groq GPT-OSS 120B";
    el["panel-vision-model"].textContent = payload?.providers?.vision || "Gemini Flash";
    el["model-name"].textContent = modelLabel(model) || "Groq · GPT-OSS 120B";
    el["panel-updated"].textContent = payload?.checked_at
      ? `Checked ${formatTime(new Date(payload.checked_at * 1000).toISOString())}`
      : "Not checked yet";
  }

  function count(value) {
    return Number.isFinite(Number(value)) ? String(Number(value)) : "—";
  }

  function runnerLabel(value) {
    if (!value || value === "unknown") return "Unknown";
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  function modelLabel(model) {
    if (!model) return "";
    if (/gpt-oss/i.test(model)) return "Groq · GPT-OSS 120B";
    if (/gemini/i.test(model)) return `Gemini · ${model.replace(/^.*\//, "")}`;
    return model;
  }

  function toggleStatusPanel() {
    if (el["status-panel"].hidden) {
      el["status-panel"].hidden = false;
      el["status-toggle"].setAttribute("aria-expanded", "true");
      el["status-chip"].setAttribute("aria-expanded", "true");
      void refreshPublicStatus();
    } else {
      closeStatusPanel();
    }
  }

  function closeStatusPanel() {
    el["status-panel"].hidden = true;
    el["status-toggle"].setAttribute("aria-expanded", "false");
    el["status-chip"].setAttribute("aria-expanded", "false");
  }

  function openSidebar() {
    el.sidebar.classList.add("is-open");
    el["sidebar-scrim"].hidden = false;
    el["menu-button"].setAttribute("aria-expanded", "true");
  }

  function closeSidebar() {
    el.sidebar.classList.remove("is-open");
    el["sidebar-scrim"].hidden = true;
    el["menu-button"].setAttribute("aria-expanded", "false");
  }

  async function openTaskModal(taskId) {
    if (!taskId) return;
    el["task-modal"].hidden = false;
    el["task-modal-title"].textContent = "Loading task";
    el["task-modal-meta"].replaceChildren();
    el["task-modal-messages"].replaceChildren();
    el["task-modal-cancel"].hidden = true;
    state.taskModalId = taskId;
    try {
      const payload = await api(`/api/agent/web/task/${encodeURIComponent(taskId)}`);
      state.taskModalTask = payload.task;
      renderTaskModal(payload);
    } catch (error) {
      closeTaskModal();
      showToast(error.message, "error");
    }
  }

  function renderTaskModal(payload) {
    const task = payload.task || {};
    state.taskModalTask = task;
    el["task-modal-title"].textContent = `Task ${String(task.id || "").slice(0, 8)}`;
    el["task-modal-meta"].replaceChildren();
    for (const value of [
      statusLabel(task.status),
      `iteration ${task.iteration || 0}`,
      task.updated_at ? `updated ${relativeTime(task.updated_at)}` : "",
    ]) {
      if (!value) continue;
      const span = document.createElement("span");
      span.textContent = value;
      el["task-modal-meta"].append(span);
    }
    el["task-modal-messages"].replaceChildren();
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (messages.length === 0) {
      const empty = document.createElement("p");
      empty.className = "task-message";
      empty.textContent = "No visible messages for this task yet.";
      el["task-modal-messages"].append(empty);
    } else {
      for (const message of messages) {
        const block = document.createElement("div");
        block.className = "task-message";
        const label = document.createElement("strong");
        label.textContent = message.role === "user" ? "You" : "TrixAgent";
        const body = document.createElement("div");
        renderRichText(body, message.content || "");
        block.append(label, body);
        el["task-modal-messages"].append(block);
      }
    }
    if (task.last_error) {
      const error = document.createElement("p");
      error.className = "task-message task-error";
      error.textContent = task.last_error;
      el["task-modal-messages"].append(error);
    }
    el["task-modal-cancel"].hidden = !OPEN_STATUSES.has(task.status) && task.status !== "failed";
  }

  function closeTaskModal() {
    el["task-modal"].hidden = true;
    state.taskModalId = null;
    state.taskModalTask = null;
  }

  async function cancelModalTask() {
    const task = state.taskModalTask;
    if (!task) return;
    el["task-modal-cancel"].disabled = true;
    try {
      await api(`/api/agent/web/task/${encodeURIComponent(task.id)}/cancel`, { method: "POST" });
      showToast("Task cancelled.");
      closeTaskModal();
      await refreshConversation({ force: true, silent: true });
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      el["task-modal-cancel"].disabled = false;
    }
  }

  initialize();
})();
