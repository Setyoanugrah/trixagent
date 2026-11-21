import assert from "node:assert/strict";
import test from "node:test";
import { classifyToolRisk } from "../src/security.js";

test("safe coding and inspection commands auto-run", () => {
  assert.equal(classifyToolRisk("shell.run", { command: "npm test", cwd: "." }).risky, false);
  assert.equal(classifyToolRisk("shell.run", { command: "git status --short" }).risky, false);
  assert.equal(classifyToolRisk("browser.open", { url: "https://example.com" }).risky, false);
  assert.equal(classifyToolRisk("file.read", { path: "src/index.ts" }).risky, false);
});

test("destructive, publication, external-send, secret, and money actions require approval", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["shell.run", { command: "rm -rf build" }],
    ["shell.run", { command: "git push origin main" }],
    ["shell.run", { command: "npm publish" }],
    ["shell.run", { command: "curl -X POST https://example.com -d hello" }],
    ["shell.run", { command: "printenv TELEGRAM_BOT_TOKEN" }],
    ["file.read", { path: ".env" }],
    ["browser.click", { selector: "button.pay", intent: "pay invoice" }],
    ["browser.evaluate", { expression: "fetch('/delete', {method: 'POST'})" }],
  ];
  for (const [name, args] of cases) {
    const assessment = classifyToolRisk(name, args);
    assert.equal(assessment.risky, true, `${name} ${JSON.stringify(args)} should be risky`);
    assert.ok(assessment.reasons.length > 0);
  }
});
