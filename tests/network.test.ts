import assert from "node:assert/strict";
import test from "node:test";
import { LeaseManager } from "../src/lease.js";
import { Logger } from "../src/logger.js";
import { NebulaStateClient } from "../src/nebula-state.js";
import { SecretRedactor } from "../src/security.js";
import { AgentStore, emptyAgentState, MAX_AGENT_STATE_BYTES, type AgentStateBlob } from "../src/store.js";

function testLogger(secret = "test-nebula-key"): Logger {
  return new Logger(new SecretRedactor([secret]));
}

test("Nebula state transport sends both auth headers and CAS payload", async () => {
  const requests: Array<{ url: string; method: string; headers: Headers; body?: unknown }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...(body === undefined ? {} : { body }),
    });
    if (init?.method === "GET") return new Response("", { status: 404 });
    return Response.json({
      key: "agent/test",
      version: 0,
      value: (body as { value: unknown }).value,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  };
  const client = new NebulaStateClient("https://nebula.example/", "test-nebula-key", testLogger(), mockFetch);
  assert.equal(await client.getState("agent/test"), undefined);
  const saved = await client.putState("agent/test", null, { ready: true });
  assert.equal(saved.version, 0);
  assert.deepEqual(saved.value, { ready: true });
  assert.match(requests[0]?.url ?? "", /\/api\/agent\/state\/agent%2Ftest$/);
  assert.equal(requests[1]?.headers.get("authorization"), "Bearer test-nebula-key");
  assert.equal(requests[1]?.headers.get("x-api-key"), "test-nebula-key");
  assert.deepEqual(requests[1]?.body, { version: null, value: { ready: true } });
});

test("Nebula state transport reads the record after an empty successful PUT", async () => {
  let calls = 0;
  const mockFetch: typeof fetch = async (_input, init) => {
    calls += 1;
    if (init?.method === "PUT") return new Response(null, { status: 204 });
    return Response.json({
      key: "agent",
      version: 4,
      value: { durable: true },
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  };
  const client = new NebulaStateClient("https://nebula.example", "test-nebula-key", testLogger(), mockFetch);
  const saved = await client.putState("agent", 3, { durable: true });
  assert.equal(saved.version, 4);
  assert.deepEqual(saved.value, { durable: true });
  assert.equal(calls, 2);
});

test("AgentStore reloads and reapplies a mutation after a CAS conflict", async () => {
  let remote: AgentStateBlob = emptyAgentState();
  let version = 1;
  let putCount = 0;
  const attemptedVersions: Array<number | null> = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    if (init?.method === "GET") {
      return Response.json({ key: "agent-state", version, value: remote, updated_at: new Date().toISOString() });
    }
    const body = JSON.parse(String(init?.body)) as { version: number | null; value: AgentStateBlob };
    attemptedVersions.push(body.version);
    putCount += 1;
    if (putCount === 1) {
      remote = emptyAgentState();
      remote.kv.concurrent = { value: "writer-b", updated_at: new Date().toISOString() };
      version = 2;
      return Response.json({ error: "conflict" }, { status: 409 });
    }
    assert.equal(body.version, version);
    remote = body.value;
    version += 1;
    return Response.json({ key: "agent-state", version, value: remote, updated_at: new Date().toISOString() });
  };
  const client = new NebulaStateClient("https://nebula.example", "test-nebula-key", testLogger(), mockFetch);
  const store = new AgentStore(client, "agent-state");
  await store.load();
  await store.setKv("local", "writer-a");

  assert.deepEqual(attemptedVersions, [1, 2]);
  assert.equal(await store.getKv("local"), "writer-a");
  assert.equal(await store.getKv("concurrent"), "writer-b");
  assert.equal(remote.kv.local?.value, "writer-a");
});

test("AgentStore prunes oversized history while keeping recent searchable memory", async () => {
  let remote = emptyAgentState();
  remote.messages = Array.from({ length: 1_400 }, (_, index) => ({
    id: `message-${index}`,
    chat_id: "1",
    task_id: null,
    source_update_id: null,
    telegram_message_id: null,
    role: "user" as const,
    kind: "text",
    content: `searchable-${index}-${"x".repeat(4_000)}`,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  let version = 1;
  const mockFetch: typeof fetch = async (_input, init) => {
    if (init?.method === "GET") {
      return Response.json({ key: "agent-state", version, value: remote, updated_at: new Date().toISOString() });
    }
    const body = JSON.parse(String(init?.body)) as { value: AgentStateBlob };
    remote = body.value;
    version += 1;
    return Response.json({ key: "agent-state", version, value: remote, updated_at: new Date().toISOString() });
  };
  const client = new NebulaStateClient("https://nebula.example", "test-nebula-key", testLogger(), mockFetch);
  const store = new AgentStore(client, "agent-state");
  await store.load();

  assert.ok(Buffer.byteLength(JSON.stringify(remote), "utf8") < MAX_AGENT_STATE_BYTES);
  assert.ok(remote.messages.length < 1_400);
  assert.match((await store.searchMemory("searchable-1399", 1))[0]?.content ?? "", /searchable-1399/);
});

test("Nebula lease transport uses acquire, current, renew, and release endpoints", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ path: url.pathname, method: init?.method ?? "GET", ...(body === undefined ? {} : { body }) });
    if (init?.method === "GET") {
      return Response.json({
        name: "runner lease",
        holder_id: "runner-1",
        acquired_at: "2026-01-01T00:00:00.000Z",
        expires_at: "2026-01-01T00:01:30.000Z",
        contender_id: null,
        contender_seen_at: null,
      });
    }
    const action = url.pathname.split("/").at(-1);
    return Response.json({ [action === "acquire" ? "acquired" : action === "renew" ? "renewed" : "released"]: true });
  };
  const logger = testLogger();
  const client = new NebulaStateClient("https://nebula.example", "test-nebula-key", logger, mockFetch);
  const lease = new LeaseManager(client, "runner lease", "runner-1", 90, 25, logger);

  assert.equal(await lease.acquire(), true);
  assert.equal((await lease.current())?.holder_id, "runner-1");
  await lease.renew();
  await lease.release();

  assert.deepEqual(calls.map((call) => [call.method, call.path]), [
    ["POST", "/api/agent/lease/runner%20lease/acquire"],
    ["GET", "/api/agent/lease/runner%20lease"],
    ["POST", "/api/agent/lease/runner%20lease/renew"],
    ["POST", "/api/agent/lease/runner%20lease/release"],
  ]);
  assert.deepEqual(calls[0]?.body, { holder_id: "runner-1", ttl_seconds: 90 });
  assert.deepEqual(calls[2]?.body, { holder_id: "runner-1", ttl_seconds: 90 });
  assert.deepEqual(calls[3]?.body, { holder_id: "runner-1", ttl_seconds: 90 });
});

test("Nebula lease acquire reports an occupied lease without retrying", async () => {
  let calls = 0;
  const mockFetch: typeof fetch = async () => {
    calls += 1;
    return Response.json({ acquired: false }, { status: 409 });
  };
  const client = new NebulaStateClient("https://nebula.example", "test-nebula-key", testLogger(), mockFetch);
  assert.equal(await client.acquireLease("agent", "runner-2", 90), false);
  assert.equal(calls, 1);
});
