import assert from "node:assert/strict";
import test from "node:test";
import { isTelegramChat, isWebChat, notificationChatId } from "../src/chat.js";

test("web chats are not sent to Telegram", () => {
  assert.equal(isWebChat("web:owner"), true);
  assert.equal(isTelegramChat("web:owner"), false);
  assert.equal(notificationChatId("web:owner", 123), "123");
});

test("telegram chats keep their own notification target", () => {
  assert.equal(isWebChat("123"), false);
  assert.equal(isTelegramChat("123"), true);
  assert.equal(notificationChatId("123", 999), "123");
});
