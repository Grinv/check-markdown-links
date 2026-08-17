import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkLocal, checkAnchor } from "../src/check-local.ts";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "checkmdlinks-local-"));
}

test("existing file is ok", async () => {
  const dir = await makeTempDir();
  try {
    const file = path.join(dir, "a.md");
    await writeFile(file, "hello");
    const result = await checkLocal(file);
    assert.equal(result.status, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing directory is ok/DIRECTORY", async () => {
  const dir = await makeTempDir();
  try {
    const result = await checkLocal(dir);
    assert.deepEqual(result, { status: "ok", reason: "DIRECTORY" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing file is broken/NOT_FOUND", async () => {
  const dir = await makeTempDir();
  try {
    const result = await checkLocal(path.join(dir, "missing.md"));
    assert.deepEqual(result, { status: "broken", reason: "NOT_FOUND" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dangling symlink is broken/BROKEN_SYMLINK", async () => {
  const dir = await makeTempDir();
  try {
    const link = path.join(dir, "dangling");
    await symlink(path.join(dir, "does-not-exist"), link);
    const result = await checkLocal(link);
    assert.deepEqual(result, { status: "broken", reason: "BROKEN_SYMLINK" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("symlink to an existing file is ok", async () => {
  const dir = await makeTempDir();
  try {
    const target = path.join(dir, "target.md");
    await writeFile(target, "hi");
    const link = path.join(dir, "link.md");
    await symlink(target, link);
    const result = await checkLocal(link);
    assert.equal(result.status, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unreadable file is broken/NO_ACCESS", async (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip("running as root, permission bits are not enforced");
    return;
  }
  const dir = await makeTempDir();
  try {
    const nested = path.join(dir, "locked");
    await mkdir(nested);
    const file = path.join(nested, "a.md");
    await writeFile(file, "x");
    await chmod(nested, 0o000);
    const result = await checkLocal(file);
    assert.equal(result.status, "broken");
    assert.equal(result.reason, "NO_ACCESS");
    await chmod(nested, 0o755);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("results are cached — only one stat per path", async () => {
  const dir = await makeTempDir();
  try {
    const file = path.join(dir, "a.md");
    await writeFile(file, "hi");
    const cache = new Map();
    const first = await checkLocal(file, cache);
    // remove file after first check; cached result should still say ok
    await rm(file);
    const second = await checkLocal(file, cache);
    assert.deepEqual(first, second);
    assert.equal(cache.size, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("independent calls without a shared cache do not leak state between tests", async () => {
  const dir = await makeTempDir();
  try {
    const file = path.join(dir, "a.md");
    await writeFile(file, "hi");
    const result = await checkLocal(file);
    assert.equal(result.status, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkAnchor finds a matching heading slug", async () => {
  const dir = await makeTempDir();
  try {
    const file = path.join(dir, "a.md");
    await writeFile(file, "# Getting Started\n\n## Installation\n");
    assert.equal(await checkAnchor(file, "installation"), true);
    assert.equal(await checkAnchor(file, "getting-started"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkAnchor returns false for a missing heading", async () => {
  const dir = await makeTempDir();
  try {
    const file = path.join(dir, "a.md");
    await writeFile(file, "# Getting Started\n");
    assert.equal(await checkAnchor(file, "does-not-exist"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkAnchor caches the heading set — only one read per path", async () => {
  const dir = await makeTempDir();
  try {
    const file = path.join(dir, "a.md");
    await writeFile(file, "# Intro\n");
    const cache = new Map();
    const first = await checkAnchor(file, "intro", cache);
    await writeFile(file, "# Changed\n");
    const second = await checkAnchor(file, "intro", cache);
    assert.equal(first, true);
    assert.equal(second, true); // still cached from before the write
    assert.equal(cache.size, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
