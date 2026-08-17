import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "bin", "checkmdlinks.ts");

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "checkmdlinks-cli-"));
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runCli(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { env: { ...process.env, ...options.env } },
      (error, stdout, stderr) => {
        const code = error && typeof (error as any).code === "number" ? (error as any).code : error ? 1 : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

test("no arguments: usage on stderr, exit 2", async () => {
  const result = await runCli([]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Usage: checkmdlinks/);
});

test("nonexistent folder: exit 2", async () => {
  const result = await runCli(["/no/such/folder/checkmdlinks-test"]);
  assert.equal(result.code, 2);
});

test("a file instead of a folder: exit 2", async () => {
  const dir = await makeTempDir();
  try {
    const file = path.join(dir, "a.md");
    await writeFile(file, "hi");
    const result = await runCli([file]);
    assert.equal(result.code, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown flag: exit 2", async () => {
  const dir = await makeTempDir();
  try {
    const result = await runCli([dir, "--not-a-real-flag"]);
    assert.equal(result.code, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--timeout abc: exit 2", async () => {
  const dir = await makeTempDir();
  try {
    const result = await runCli([dir, "--timeout", "abc"]);
    assert.equal(result.code, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--concurrency 0: exit 2", async () => {
  const dir = await makeTempDir();
  try {
    const result = await runCli([dir, "--concurrency", "0"]);
    assert.equal(result.code, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--concurrency -1: exit 2", async () => {
  const dir = await makeTempDir();
  try {
    const result = await runCli([dir, "--concurrency", "-1"]);
    assert.equal(result.code, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--help: usage on stdout, exit 0", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: checkmdlinks/);
});

test("--version: exit 0, prints a version string", async () => {
  const result = await runCli(["--version"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("clean fixture (no broken links): exit 0", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(path.join(dir, "a.md"), "[b](./b.md)\n");
    await writeFile(path.join(dir, "b.md"), "back to [a](./a.md)\n");
    const result = await runCli([dir, "--no-external"]);
    assert.equal(result.code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fixture with a broken link: exit 1", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(path.join(dir, "a.md"), "[bad](./missing.md)\n");
    const result = await runCli([dir, "--no-external"]);
    assert.equal(result.code, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--json output parses with JSON.parse, contains documented keys, no ANSI", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(path.join(dir, "a.md"), "[bad](./missing.md)\n");
    const result = await runCli([dir, "--no-external", "--json"]);
    assert.equal(result.code, 1);
    assert.ok(!result.stdout.includes("\x1b["));
    const parsed = JSON.parse(result.stdout);
    assert.ok("root" in parsed);
    assert.ok("results" in parsed);
    assert.ok("summary" in parsed);
    assert.ok("warnings" in parsed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--json suppresses the human-readable table", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(path.join(dir, "a.md"), "[bad](./missing.md)\n");
    const result = await runCli([dir, "--no-external", "--json"]);
    assert.doesNotMatch(result.stdout, /Scanned/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NO_COLOR env var suppresses ANSI on a non-TTY pipe", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(path.join(dir, "a.md"), "[bad](./missing.md)\n");
    const result = await runCli([dir, "--no-external"], { env: { NO_COLOR: "1" } });
    assert.ok(!result.stdout.includes("\x1b["));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-TTY output has no ANSI even without NO_COLOR (execFile pipes are never TTYs)", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(path.join(dir, "a.md"), "[bad](./missing.md)\n");
    const result = await runCli([dir, "--no-external"]);
    assert.ok(!result.stdout.includes("\x1b["));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mailto/tel/data links are skipped, not broken", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(
      path.join(dir, "a.md"),
      "[m](mailto:a@b.com) [t](tel:+123) [d](data:text/plain,x)\n",
    );
    const result = await runCli([dir, "--no-external", "--json"]);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.summary.skipped, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--ignore excludes a custom directory from the scan", async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(path.join(dir, "excluded"));
    await writeFile(path.join(dir, "excluded", "a.md"), "[bad](./missing.md)\n");
    await writeFile(path.join(dir, "good.md"), "hello\n");
    const result = await runCli([dir, "--no-external", "--ignore", "excluded"]);
    assert.equal(result.code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("node_modules and .git are never scanned", async () => {
  const dir = await makeTempDir();
  try {
    await mkdir(path.join(dir, "node_modules"));
    await writeFile(path.join(dir, "node_modules", "a.md"), "[bad](./missing.md)\n");
    await mkdir(path.join(dir, ".git"));
    await writeFile(path.join(dir, ".git", "a.md"), "[bad](./missing.md)\n");
    const result = await runCli([dir, "--no-external"]);
    assert.equal(result.code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--no-external: the HTTP server receives zero requests and links are skipped", async () => {
  let hitCount = 0;
  const server = http.createServer((req, res) => {
    hitCount++;
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  const dir = await makeTempDir();
  try {
    await writeFile(path.join(dir, "a.md"), `[ext](http://127.0.0.1:${port}/)\n`);
    const result = await runCli([dir, "--no-external", "--json"]);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.results[0].status, "skipped");
    assert.equal(hitCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
    server.close();
  }
});

test("--only-external: local links are skipped, external ones are checked", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  const dir = await makeTempDir();
  try {
    await writeFile(
      path.join(dir, "a.md"),
      `[local](./missing.md) [ext](http://127.0.0.1:${port}/)\n`,
    );
    const result = await runCli([dir, "--only-external", "--json"]);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    const local = parsed.results.find((r: any) => r.type === "local");
    const external = parsed.results.find((r: any) => r.type === "external");
    assert.equal(local.status, "skipped");
    assert.equal(external.status, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
    server.close();
  }
});

test("end-to-end: a live local server integrated through the full CLI reports ok/broken correctly", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200);
      res.end("ok");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  const dir = await makeTempDir();
  try {
    await writeFile(
      path.join(dir, "a.md"),
      `[good](http://127.0.0.1:${port}/ok) [bad](http://127.0.0.1:${port}/missing)\n`,
    );
    const result = await runCli([dir, "--json"]);
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.summary.ok, 1);
    assert.equal(parsed.summary.broken, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    server.close();
  }
});

test("a 429 rate-limited link is a warning and does not affect the exit code", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(429);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  const dir = await makeTempDir();
  try {
    await writeFile(path.join(dir, "a.md"), `[rate](http://127.0.0.1:${port}/)\n`);
    const result = await runCli([dir, "--json"]);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.summary.warning, 1);
    assert.equal(parsed.results[0].reason, "RATE_LIMITED");
  } finally {
    await rm(dir, { recursive: true, force: true });
    server.close();
  }
});

test("--timeout 100 against a server that never responds: broken/TIMEOUT, does not hang", async () => {
  const server = http.createServer(() => {
    // never respond
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  const dir = await makeTempDir();
  try {
    await writeFile(path.join(dir, "a.md"), `[slow](http://127.0.0.1:${port}/)\n`);
    const result = await runCli([dir, "--timeout", "100", "--json"]);
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.results[0].status, "broken");
    assert.equal(parsed.results[0].reason, "TIMEOUT");
  } finally {
    await rm(dir, { recursive: true, force: true });
    server.close();
  }
});

test("the same URL referenced from 3 different files hits the server exactly once", async () => {
  let hitCount = 0;
  const server = http.createServer((req, res) => {
    hitCount++;
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  const dir = await makeTempDir();
  try {
    const url = `http://127.0.0.1:${port}/shared`;
    await writeFile(path.join(dir, "a.md"), `[x](${url})\n`);
    await writeFile(path.join(dir, "b.md"), `[y](${url})\n`);
    await writeFile(path.join(dir, "c.md"), `[z](${url})\n`);
    const result = await runCli([dir, "--json"]);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.uniqueExternalUrls, 1);
    assert.equal(hitCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
    server.close();
  }
});

test("an empty folder with no .md files reports zeros and exits 0", async () => {
  const dir = await makeTempDir();
  try {
    const result = await runCli([dir, "--json"]);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.scannedFiles, 0);
    assert.equal(parsed.totalLinks, 0);
    assert.deepEqual(parsed.summary, { ok: 0, broken: 0, warning: 0, skipped: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a same-file anchor matching a heading is ok", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(
      path.join(dir, "a.md"),
      "# Getting Started\n\n[Перейти к разделу](#getting-started)\n",
    );
    const result = await runCli([dir, "--no-external", "--json"]);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.results[0].status, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a same-file anchor with no matching heading is broken/ANCHOR_NOT_FOUND", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(
      path.join(dir, "a.md"),
      "# Getting Started\n\n[Чеклист быстрого старта](#чеклист-быстрого-старта)\n",
    );
    const result = await runCli([dir, "--no-external", "--json"]);
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.results[0].status, "broken");
    assert.equal(parsed.results[0].reason, "ANCHOR_NOT_FOUND");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cross-file anchor is checked against the target file's headings", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(path.join(dir, "a.md"), "[link](./b.md#installation)\n");
    await writeFile(path.join(dir, "b.md"), "# Installation\n");
    const result = await runCli([dir, "--no-external", "--json"]);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.results[0].status, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a bare # (top of document) is always ok, regardless of headings", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(path.join(dir, "a.md"), "no headings here\n\n[top](#)\n");
    const result = await runCli([dir, "--no-external", "--json"]);
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.results[0].status, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
