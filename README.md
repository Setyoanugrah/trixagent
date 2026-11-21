# Telegram Autonomous Runner Agent

Node.js 20+ ESM TypeScript agent for ephemeral Ubuntu runners (the integrated workflow uses Node.js 22). Telegram is the control plane, Ollama supplies local text and vision models, Nebula is the only durable state, lease, snapshot, and artifact backend, and Patchright controls Chromium.

## Properties

- Only updates whose numeric sender ID exactly matches `TELEGRAM_OWNER_ID` are handled.
- A typed state blob contains KV data, Telegram updates and offset, messages, tasks, checkpoints, tool runs, approvals, and runner instances.
- Every state mutation is persisted through optimistic CAS. Conflicts reload the latest blob and reapply the mutation under a serialized local mutex.
- Processed updates and old terminal history are pruned while recent searchable messages and task summaries are retained. The serialized blob is kept below 4 MiB.
- A renewable Nebula lease ensures only one overlapping runner polls Telegram or executes tasks at a time. Other runner jobs may remain alive and acquire the lease when it expires.
- Every task and user message is durable before model execution. Every tool call transitions through pending, running, and a terminal state.
- Running and waiting tasks resume from checkpoints after restart. A shell process interrupted with its runner is recorded as failed and is not silently rerun.
- Native Ollama tool calls are preferred. Models without tool support use a strict single-object JSON protocol.
- Browser and document content is treated as untrusted data. Child processes receive an allowlisted environment without agent credentials.
- Risky actions create a durable approval with Telegram Approve/Reject buttons. `AGENT_UNSAFE_AUTO` defaults to `false`.

## Commands

`/start`, `/status`, `/new`, `/resume`, `/cancel`, `/browser`, `/screenshot`, and `/memory [query]` are supported. Normal text, photos, and documents create durable tasks.

## Setup

```bash
npm ci
npm test
npm run typecheck
npm run build
npm start
```

`npm start` runs `dist/src/index.js`, so build first.

### Required Environment

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token used only by the Telegram client |
| `TELEGRAM_OWNER_ID` | Positive numeric Telegram user ID |
| `NEBULA_API_KEY` | Bearer and `X-API-Key` credential for state, lease, and file APIs |
| `WORKSPACE_ROOT` | Existing directory all agent file operations are confined to |

### Model And Browser Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama HTTP endpoint |
| `AGENT_MODEL` | `qwen3:4b-instruct-2507-q4_K_M` | Text and tool model |
| `VISION_MODEL` | `qwen3-vl:4b-instruct-q4_K_M` | Screenshot and image model |
| `CHROMIUM_EXECUTABLE_PATH` | Patchright default | Explicit Chromium binary |
| `BROWSER_HEADLESS` | `true` | Headless persistent context |
| `AGENT_MAX_ITERATIONS` | `16` | Bounded steps per run or resume |
| `AGENT_MAX_CONTEXT_TOKENS` | `32768` | Text context; vision is capped at `16384` |
| `AGENT_UNSAFE_AUTO` | `false` | Bypass the approval classifier only when explicitly enabled |

The Chromium profile lives at `WORKSPACE_ROOT/.agent/browser-profile`. Browser cookies and local storage are checkpointed in the Nebula state blob; when `STATE_ENCRYPTION_KEY` is set, that KV value is AES-256-GCM encrypted.

### Nebula Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEBULA_BASE_URL` | `https://drive.rikuzetsi.my.id` | Nebula API base |
| `LEASE_NAME` | `telegram-autonomous-agent` | Lease name and durable state key |
| `LEASE_TTL_SECONDS` | `90` | Lease lifetime |
| `LEASE_HEARTBEAT_SECONDS` | `25` | Lease renewal interval |
| `STATE_ENCRYPTION_KEY` | unset | 32-byte base64/hex key or passphrase-derived key |
| `NEBULA_SNAPSHOT_ON_SHUTDOWN` | `false` (workflow: `true`) | Restore the latest encrypted snapshot, periodically back up, and upload on graceful shutdown |
| `NEBULA_SNAPSHOT_INTERVAL_MINUTES` | `30` | Periodic encrypted snapshot interval |

Durable state uses `GET/PUT /api/agent/state/:key`. The `PUT` body is `{version,value}` and conflicts are retried after a reload. Leases use `GET /api/agent/lease/:name` and `POST /api/agent/lease/:name/acquire|renew|release` with `{holder_id,ttl_seconds}`.

File storage uses `GET /api/files`, `POST /api/upload/init` with `name`, `size`, `folder`, and `mime`, raw chunks at `/api/upload/chunk?id=&offset=`, and `POST /api/upload/finish` with `id`. Downloads prefer `/api/file/:id/download` and retain plural/query fallbacks. Upload throttling is durable in the state blob. Set `STATE_ENCRYPTION_KEY` before enabling snapshots.

## Approval Rules

Read, coding, tests, local builds, ordinary browser navigation, and read-only page evaluation auto-run. Git push, deployment, destructive shell operations, external sends, publication, secret-bearing files or commands, side-effecting browser actions, and money-related actions pause the task.

Even after approval, agent credentials are never inherited by shell children or inserted into model context or logs. Known token formats are redacted from tool results and structured logs.

## GitHub Actions Runner

`.github/workflows/runner.yml` integrates the agent into the existing Trixvler runner. It uses Node.js 22, installs both lockfiles with `npm ci`, runs the root and agent checks, and installs Chromium once for both Patchright applications.

Ollama is pinned to `0.40.17`. The exact cached models are `qwen3:4b-instruct-2507-q4_K_M` (`0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0`) and `qwen3-vl:4b-instruct-q4_K_M` (`84f7ed8042fa7cdbd902f7dcb7d0370e032095047cc3244179f263b77b5bc318`). Ollama uses a 32768-token context, one loaded model, one parallel request, a 10-minute keep-alive, and cloud features disabled. The agent requests 32768 tokens for text and caps vision requests at 16384.

The agent workspace is an isolated directory under `RUNNER_TEMP`, never the live captcha checkout. Its clean environment receives only the runtime basics, Telegram credentials, Nebula URL/key, state encryption key, model settings, workspace and runner identity, lease settings, and explicit browser/snapshot settings. It does not receive Trixvler, provider, GitHub, tunnel, SSH, Cloudflare, or D1 credentials; durable state remains Nebula-only.

Add these four repository secrets for the agent: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, `NEBULA_API_KEY`, and `STATE_ENCRYPTION_KEY`. Existing Trixvler, Tailscale, SSH, provider, and tunnel settings remain independent.

Overlapping workflow runs are intentional and there is no blocking concurrency group. The Nebula lease selects the active runner while another may remain at `lease.waiting`; the workflow redispatches at minute 270, stops its keepalive at minute 300, and gives graceful agent snapshot/checkpoint/lease cleanup up to five minutes.

Tests use mocked network responses and do not start Ollama, Telegram, Chromium, or Nebula.

## Files

- `src/index.ts`: startup order, lease ownership, snapshot restore, and graceful shutdown.
- `src/nebula-state.ts`: authenticated state CAS and lease transport with bounded retries and timeouts.
- `src/store.ts`: typed in-memory state, pruning, conflict reapplication, and searchable memory.
- `src/agent.ts`: bounded model/tool loop and durable approvals.
- `src/tools.ts`: confined tool implementations and secret-free subprocesses.
- `src/browser.ts`: Patchright persistent context, CDP snapshots, screenshots, and durable browser state.
- `src/telegram.ts`, `src/ollama.ts`, `src/nebula.ts`: native-fetch service clients.
- `src/security.ts`, `src/crypto.ts`: path/risk controls, redaction, and AES-256-GCM helpers.
- `tests/`: offline coverage including state conflicts and lease transport.
