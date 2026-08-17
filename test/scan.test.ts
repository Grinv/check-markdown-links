import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanMarkdownFiles } from "../src/scan.ts";

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "checkmdlinks-scan-"));
}

test("finds .md files recursively, sorted", async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "b.md"), "");
    await writeFile(path.join(dir, "a.md"), "");
    await writeFile(path.join(dir, "sub", "c.md"), "");
    const files = await scanMarkdownFiles(dir);
    assert.deepEqual(
      files,
      [...files].sort(),
    );
    assert.equal(files.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(".markdown extension is picked up, .txt and .mdx are not", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(path.join(dir, "a.markdown"), "");
    await writeFile(path.join(dir, "b.txt"), "");
    await writeFile(path.join(dir, "c.mdx"), "");
    const files = await scanMarkdownFiles(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith("a.markdown"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default ignored directories are not traversed", async () => {
  const dir = await makeTempDir();
  try {
    for (const name of ["node_modules", ".git", "dist", "build", "coverage", ".next", ".cache", "vendor"]) {
      await mkdir(path.join(dir, name));
      await writeFile(path.join(dir, name, "broken.md"), "[x](./missing.md)");
    }
    await writeFile(path.join(dir, "real.md"), "");
    const files = await scanMarkdownFiles(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith("real.md"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("other hidden directories are skipped, but hidden .md files are checked", async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(path.join(dir, ".hidden-dir"));
    await writeFile(path.join(dir, ".hidden-dir", "x.md"), "");
    await writeFile(path.join(dir, ".hidden.md"), "");
    const files = await scanMarkdownFiles(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith(".hidden.md"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--ignore excludes a custom directory", async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(path.join(dir, "custom"));
    await writeFile(path.join(dir, "custom", "x.md"), "");
    await writeFile(path.join(dir, "keep.md"), "");
    const files = await scanMarkdownFiles(dir, { ignore: ["custom"] });
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith("keep.md"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("symlinked directories are not traversed (cycle protection)", async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(path.join(dir, "real"));
    await writeFile(path.join(dir, "real", "x.md"), "");
    await symlink(path.join(dir, "real"), path.join(dir, "loop"), "dir");
    const files = await scanMarkdownFiles(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].includes(`${path.sep}real${path.sep}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("symlinks to files are treated as files", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(path.join(dir, "target.md"), "");
    await symlink(path.join(dir, "target.md"), path.join(dir, "link.md"));
    const files = await scanMarkdownFiles(dir);
    assert.equal(files.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty folder with no .md files reports zero files", async () => {
  const dir = await makeTempDir();
  try {
    const files = await scanMarkdownFiles(dir);
    assert.deepEqual(files, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("EACCES on a subdirectory is reported as a warning and the scan continues", async (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip("running as root, permission bits are not enforced");
    return;
  }
  const dir = await makeTempDir();
  try {
    const locked = path.join(dir, "locked");
    await mkdir(locked);
    await writeFile(path.join(locked, "hidden.md"), "");
    await writeFile(path.join(dir, "visible.md"), "");
    await chmod(locked, 0o000);

    const warnings: string[] = [];
    const files = await scanMarkdownFiles(dir, { onWarning: (m) => warnings.push(m) });

    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith("visible.md"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /EACCES|EPERM/);

    await chmod(locked, 0o755);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
