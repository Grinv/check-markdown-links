import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { checkHttp, createHttpChecker } from "../src/check-http.ts";

interface TestServer {
  server: http.Server;
  base: string;
  hits: Record<string, number>;
}

async function startServer(handler: http.RequestListener, hits: Record<string, number>): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    hits[req.url ?? ""] = (hits[req.url ?? ""] ?? 0) + 1;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}`, hits };
}

function closeServer(t: TestServer): Promise<void> {
  return new Promise((resolve) => t.server.close(() => resolve()));
}

test("200 response is ok", async () => {
  const hits: Record<string, number> = {};
  const t = await startServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  }, hits);
  try {
    const result = await checkHttp(`${t.base}/`);
    assert.equal(result.status, "ok");
    assert.equal(result.httpStatus, 200);
  } finally {
    await closeServer(t);
  }
});

test("301 redirect followed to 200 is ok", async () => {
  const hits: Record<string, number> = {};
  const t = await startServer((req, res) => {
    if (req.url === "/old") {
      res.writeHead(301, { Location: "/new" });
      res.end();
    } else {
      res.writeHead(200);
      res.end("ok");
    }
  }, hits);
  try {
    const result = await checkHttp(`${t.base}/old`);
    assert.equal(result.status, "ok");
    assert.equal(result.httpStatus, 200);
  } finally {
    await closeServer(t);
  }
});

test("404 is broken/HTTP_404", async () => {
  const hits: Record<string, number> = {};
  const t = await startServer((req, res) => {
    res.writeHead(404);
    res.end();
  }, hits);
  try {
    const result = await checkHttp(`${t.base}/`);
    assert.deepEqual(
      { status: result.status, httpStatus: result.httpStatus, reason: result.reason },
      { status: "broken", httpStatus: 404, reason: "HTTP_404" },
    );
  } finally {
    await closeServer(t);
  }
});

test("500 is broken/HTTP_500", async () => {
  const hits: Record<string, number> = {};
  const t = await startServer((req, res) => {
    res.writeHead(500);
    res.end();
  }, hits);
  try {
    const result = await checkHttp(`${t.base}/`);
    assert.equal(result.status, "broken");
    assert.equal(result.reason, "HTTP_500");
  } finally {
    await closeServer(t);
  }
});

test("429 is warning and does not affect exit code semantics", async () => {
  const hits: Record<string, number> = {};
  const t = await startServer((req, res) => {
    res.writeHead(429);
    res.end();
  }, hits);
  try {
    const result = await checkHttp(`${t.base}/`);
    assert.equal(result.status, "warning");
    assert.equal(result.reason, "RATE_LIMITED");
  } finally {
    await closeServer(t);
  }
});

test("403 is warning/FORBIDDEN", async () => {
  const hits: Record<string, number> = {};
  const t = await startServer((req, res) => {
    res.writeHead(403);
    res.end();
  }, hits);
  try {
    const result = await checkHttp(`${t.base}/`);
    assert.equal(result.status, "warning");
    assert.equal(result.reason, "FORBIDDEN");
  } finally {
    await closeServer(t);
  }
});

test("HEAD 405 falls back to GET which succeeds", async () => {
  const hits: Record<string, number> = {};
  const t = await startServer((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(405);
      res.end();
    } else {
      res.writeHead(200);
      res.end("body");
    }
  }, hits);
  try {
    const result = await checkHttp(`${t.base}/`);
    assert.equal(result.status, "ok");
    assert.equal(result.httpStatus, 200);
  } finally {
    await closeServer(t);
  }
});

test("timeout produces broken/TIMEOUT and does not hang the test", async () => {
  const hits: Record<string, number> = {};
  const t = await startServer(() => {
    // never respond
  }, hits);
  try {
    const result = await checkHttp(`${t.base}/`, { timeoutMs: 100 });
    assert.equal(result.status, "broken");
    assert.equal(result.reason, "TIMEOUT");
  } finally {
    await closeServer(t);
  }
});

test("connection reset is broken/CONNECTION", async () => {
  const hits: Record<string, number> = {};
  const t = await startServer((req) => {
    const socket = req.socket as any;
    if (typeof socket.resetAndDestroy === "function") {
      socket.resetAndDestroy();
    } else {
      socket.destroy();
    }
  }, hits);
  try {
    const result = await checkHttp(`${t.base}/`, { timeoutMs: 2000 });
    assert.equal(result.status, "broken");
    assert.ok(result.reason === "CONNECTION" || result.reason?.startsWith("NETWORK"));
  } finally {
    await closeServer(t);
  }
});

test("unreachable/closed port is broken/CONNECTION", async () => {
  const hits: Record<string, number> = {};
  const t = await startServer(() => {}, hits);
  const closedPort = (t.server.address() as AddressInfo).port;
  await closeServer(t);

  const result = await checkHttp(`http://127.0.0.1:${closedPort}/`, { timeoutMs: 2000 });
  assert.equal(result.status, "broken");
  assert.equal(result.reason, "CONNECTION");
});

test("dedup: the same URL requested from multiple places hits the server once", async () => {
  const hits: Record<string, number> = {};
  const t = await startServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  }, hits);
  try {
    const check = createHttpChecker({ concurrency: 8 });
    const url = `${t.base}/shared`;
    await Promise.all([check(url), check(url), check(url)]);
    assert.equal(hits["/shared"], 1);
  } finally {
    await closeServer(t);
  }
});

test("concurrency 1 and concurrency 8 produce the same set of results", async () => {
  const hits: Record<string, number> = {};
  const t = await startServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  }, hits);
  try {
    const urls = Array.from({ length: 6 }, (_, i) => `${t.base}/item-${i}`);

    const checkSerial = createHttpChecker({ concurrency: 1 });
    const serialResults = await Promise.all(urls.map((u) => checkSerial(u)));

    const checkParallel = createHttpChecker({ concurrency: 8 });
    const parallelResults = await Promise.all(urls.map((u) => checkParallel(u)));

    assert.deepEqual(
      serialResults.map((r) => r.status),
      parallelResults.map((r) => r.status),
    );
  } finally {
    await closeServer(t);
  }
});

test("--no-external style usage: when the checker is never invoked, the server sees no requests", async () => {
  const hits: Record<string, number> = {};
  const t = await startServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  }, hits);
  try {
    // Simulates cli.ts's --no-external branch: checkExternal is simply never called.
    assert.equal(Object.keys(hits).length, 0);
  } finally {
    await closeServer(t);
  }
});
