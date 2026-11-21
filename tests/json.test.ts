import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonFallback } from "../src/utils.js";

test("parseJsonFallback accepts strict tool and final objects", () => {
  assert.deepEqual(parseJsonFallback('{"type":"tool","name":"file.read","arguments":{"path":"README.md"}}'), {
    type: "tool",
    call: { name: "file.read", arguments: { path: "README.md" } },
  });
  assert.deepEqual(parseJsonFallback('{"type":"final","content":"complete"}'), {
    type: "final",
    content: "complete",
  });
  assert.deepEqual(parseJsonFallback('```json\n{"tool":"git.status","arguments":{}}\n```'), {
    type: "tool",
    call: { name: "git.status", arguments: {} },
  });
});

test("parseJsonFallback rejects prose, arrays, and malformed arguments", () => {
  assert.throws(() => parseJsonFallback('Here is JSON: {"type":"final","content":"x"}'), /single valid JSON/);
  assert.throws(() => parseJsonFallback("[]"), /must be a JSON object/);
  assert.throws(() => parseJsonFallback('{"type":"tool","name":"file.read","arguments":"bad"}'), /arguments object/);
  assert.throws(() => parseJsonFallback('{"type":"final","content":""}'), /non-empty/);
});
