export type HttpStatus = "ok" | "broken" | "warning";

export interface CheckHttpResult {
  status: HttpStatus;
  httpStatus: number | null;
  reason: string | null;
  redirects: number;
}

export interface CheckHttpOptions {
  timeoutMs?: number;
  userAgent?: string;
}

const RETRY_HEAD_STATUSES = new Set([405, 501, 403, 404]);
const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ETIMEDOUT", "EPIPE"]);
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const TLS_CODES = new Set(["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

/** Checks a single URL's HTTP availability, with one retry on transient errors. */
export async function checkHttp(url: string, options: CheckHttpOptions = {}): Promise<CheckHttpResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const userAgent = options.userAgent ?? "checkmdlinks/1.0.0";

  const result = await attempt(url, timeoutMs, userAgent);
  if (isRetryable(result)) {
    return attempt(url, timeoutMs, userAgent);
  }
  return result;
}

function isRetryable(result: CheckHttpResult): boolean {
  return result.status === "broken" && (result.reason === "TIMEOUT" || result.reason === "CONNECTION" || result.reason === "NETWORK");
}

async function attempt(url: string, timeoutMs: number, userAgent: string): Promise<CheckHttpResult> {
  const headers = { "User-Agent": userAgent, Accept: "*/*" };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return classifyNetworkError(err);
  }

  let finalResponse = response;
  if (RETRY_HEAD_STATUSES.has(response.status)) {
    await drain(response);
    try {
      finalResponse = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { ...headers, Range: "bytes=0-0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return classifyNetworkError(err);
    }
  }

  const result = classifyResponse(finalResponse);
  await drain(finalResponse);
  return result;
}

async function drain(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore — nothing we can do if the body can't be cancelled
  }
}

function classifyResponse(response: Response): CheckHttpResult {
  const httpStatus = response.status;
  const redirects = response.redirected ? 1 : 0;

  if (httpStatus >= 200 && httpStatus < 400) {
    return { status: "ok", httpStatus, reason: null, redirects };
  }
  if (httpStatus === 429) {
    return { status: "warning", httpStatus, reason: "RATE_LIMITED", redirects };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { status: "warning", httpStatus, reason: "FORBIDDEN", redirects };
  }
  return { status: "broken", httpStatus, reason: `HTTP_${httpStatus}`, redirects };
}

function classifyNetworkError(err: any): CheckHttpResult {
  if (err?.name === "AbortError" || err?.name === "TimeoutError") {
    return { status: "broken", httpStatus: null, reason: "TIMEOUT", redirects: 0 };
  }

  const code: string | undefined = err?.cause?.code ?? err?.code;

  if (code && DNS_CODES.has(code)) {
    return { status: "broken", httpStatus: null, reason: "DNS", redirects: 0 };
  }
  if (code && CONNECTION_CODES.has(code)) {
    return { status: "broken", httpStatus: null, reason: "CONNECTION", redirects: 0 };
  }
  if (code && (TLS_CODES.has(code) || code.startsWith("ERR_TLS"))) {
    return { status: "broken", httpStatus: null, reason: "TLS", redirects: 0 };
  }
  if (code === "ERR_TOO_MANY_REDIRECTS" || /too many redirects/i.test(err?.message ?? "")) {
    return { status: "broken", httpStatus: null, reason: "REDIRECT_LOOP", redirects: 0 };
  }

  const message = err?.cause?.message ?? err?.message ?? String(err);
  return { status: "broken", httpStatus: null, reason: `NETWORK: ${message}`, redirects: 0 };
}

export type HttpCache = Map<string, Promise<CheckHttpResult>>;

export interface HttpCheckerOptions {
  timeoutMs?: number;
  userAgent?: string;
  concurrency?: number;
  cache?: HttpCache;
}

/**
 * Builds a rate-limited, deduplicating HTTP checker: same URL requested once
 * per run, at most `concurrency` requests in flight at a time.
 */
export function createHttpChecker(options: HttpCheckerOptions = {}): (url: string) => Promise<CheckHttpResult> {
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const cache: HttpCache = options.cache ?? new Map();
  const queue: Array<() => void> = [];
  let active = 0;

  function pump(): void {
    while (active < concurrency && queue.length > 0) {
      const task = queue.shift()!;
      task();
    }
  }

  return function check(url: string): Promise<CheckHttpResult> {
    const cached = cache.get(url);
    if (cached) return cached;

    const promise = new Promise<CheckHttpResult>((resolve) => {
      queue.push(() => {
        active++;
        checkHttp(url, options)
          .then(resolve)
          .finally(() => {
            active--;
            pump();
          });
      });
    });

    cache.set(url, promise);
    pump();
    return promise;
  };
}
