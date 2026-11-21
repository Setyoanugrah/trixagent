import assert from "node:assert/strict";
import test from "node:test";
import { splitTelegramMessage } from "../src/utils.js";

test("splitTelegramMessage preserves content and Unicode surrogate pairs", () => {
  const text = `${"alpha beta gamma\n".repeat(40)}${"x".repeat(90)}\u{1F680}${"y".repeat(90)}`;
  const chunks = splitTelegramMessage(text, 100);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
    assert.equal(/[\uD800-\uDBFF]$/.test(chunk), false, "chunk must not end with a high surrogate");
    assert.equal(/^[\uDC00-\uDFFF]/.test(chunk), false, "chunk must not begin with a low surrogate");
  }
});

test("splitTelegramMessage handles empty and short messages", () => {
  assert.deepEqual(splitTelegramMessage(""), []);
  assert.deepEqual(splitTelegramMessage("short"), ["short"]);
  assert.throws(() => splitTelegramMessage("x", 1));
});
