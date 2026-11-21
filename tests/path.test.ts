import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { resolveConfinedPath } from "../src/security.js";

test("resolveConfinedPath accepts nested workspace paths and rejects traversal", async (t) => {
  const testParent = join(process.cwd(), ".tmp");
  await mkdir(testParent, { recursive: true });
  const fixture = await mkdtemp(join(testParent, "path-test-"));
  t.after(async () => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "workspace");
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "nested", "file.txt"), "ok");

  assert.equal(await resolveConfinedPath(root, "nested/file.txt"), join(root, "nested", "file.txt"));
  await assert.rejects(resolveConfinedPath(root, "../outside.txt"), /escapes WORKSPACE_ROOT/);
  await assert.rejects(resolveConfinedPath(root, join(fixture, "absolute-outside.txt")), /escapes WORKSPACE_ROOT/);
});

test("resolveConfinedPath rejects symlinks whose target leaves the workspace", async (t) => {
  const testParent = join(process.cwd(), ".tmp");
  await mkdir(testParent, { recursive: true });
  const fixture = await mkdtemp(join(testParent, "symlink-test-"));
  t.after(async () => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, "workspace");
  const outside = join(fixture, "outside");
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, join(root, "escape"));

  await assert.rejects(resolveConfinedPath(root, "escape/new.txt"), /outside WORKSPACE_ROOT/);
});
