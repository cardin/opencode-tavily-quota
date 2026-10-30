import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { CACHE_TTL_MS, MIN_REQUEST_INTERVAL_MS, createQuotaClient, fetchQuotaWithFallback } from "./quota-client.ts";

const execFileAsync = promisify(execFile);

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "tavily-client-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.UTC(2026, 9, 30, 12);
  let requests = 0;
  let response = async () => new Response(JSON.stringify({ key: { usage: requests, limit: 100 } }));
  const request = {
    apiKey: "mock-shared-key", env: {},
    fetchImpl: (async () => {
      requests++;
      return response();
    }) as typeof fetch,
  };
  const client = () => createQuotaClient({ directory, now: () => now });
  return {
    directory, request, client,
    get requests() { return requests; },
    get now() { return now; },
    advance(ms: number) { now += ms; },
    respond(next: typeof response) { response = next; },
  };
}

test("concurrent quota reads coalesce before the HTTP response completes", async (t) => {
  const f = await fixture(t);
  let started!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  f.respond(async () => {
    started();
    await paused;
    return new Response(JSON.stringify({ key: { usage: 2, limit: 10 } }));
  });
  const client = f.client();
  const pending = Array.from({ length: 12 }, () => client(f.request));
  await sending;
  try {
    assert.equal(f.requests, 1);
  } finally {
    resume();
  }
  const results = await Promise.all(pending);
  assert.ok(results[0].ok);
  for (const result of results) assert.deepEqual(result, results[0]);
});

test("independent quota clients share the cache and lock", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.client()(f.request)));
  assert.equal(f.requests, 1);
  assert.ok(results[0].ok);
  for (const result of results) assert.deepEqual(result, results[0]);
});

test("a restarted client reuses a snapshot until its TTL expires", async (t) => {
  const f = await fixture(t);
  const first = await f.client()(f.request);
  f.advance(CACHE_TTL_MS - 1);
  assert.deepEqual(await f.client()(f.request), first);
  assert.equal(f.requests, 1);
  f.advance(1);
  const next = await f.client()(f.request);
  assert.equal(f.requests, 2);
  assert.notDeepEqual(next, first);
});

test("manual refresh bypasses freshness but not the shared minimum interval", async (t) => {
  const f = await fixture(t);
  const first = await f.client()(f.request);
  f.advance(MIN_REQUEST_INTERVAL_MS - 1);
  assert.deepEqual(await f.client()({ ...f.request, force: true }), first);
  assert.equal(f.requests, 1);
  f.advance(1);
  const next = await f.client()({ ...f.request, force: true });
  assert.equal(f.requests, 2);
  assert.notDeepEqual(next, first);
});

test("forced reads stay within ten HTTP requests in a rolling ten-minute window", async (t) => {
  const f = await fixture(t);
  const client = f.client();
  const sentAt: number[] = [];
  for (let second = 0; second < 1_200; second += 10) {
    const before = f.requests;
    await client({ ...f.request, force: true });
    if (f.requests > before) sentAt.push(second);
    assert.ok(sentAt.filter((at) => at > second - 600).length <= 10);
    f.advance(10_000);
  }
  assert.ok(f.requests > 10, "the clock must span multiple rate-limit windows");
});

test("429 cooldown survives new clients and cannot be bypassed by manual refresh", async (t) => {
  const f = await fixture(t);
  f.respond(async () => new Response("", { status: 429, headers: { "Retry-After": "1800" } }));
  const limited = await f.client()(f.request);
  assert.equal(limited.ok, false);
  f.advance(600_000);
  assert.deepEqual(await f.client()({ ...f.request, force: true }), limited);
  assert.equal(f.requests, 1);
  f.advance(1_200_000);
  f.respond(async () => new Response(JSON.stringify({ key: { usage: 2, limit: 10 } })));
  assert.equal((await f.client()({ ...f.request, force: true })).ok, true);
  assert.equal(f.requests, 2);
});

test("429 without Retry-After blocks every client for the fallback window", async (t) => {
  const f = await fixture(t);
  f.respond(async () => new Response("", { status: 429 }));
  const limited = await f.client()(f.request);
  f.advance(600_000 - 1);
  assert.deepEqual(await f.client()({ ...f.request, force: true }), limited);
  assert.equal(f.requests, 1);
  f.advance(1);
  await f.client()(f.request);
  assert.equal(f.requests, 2);
});

test("a valid short Retry-After still respects the minimum request interval", async (t) => {
  const f = await fixture(t);
  f.respond(async () => new Response("", { status: 429, headers: { "Retry-After": "1" } }));
  await f.client()(f.request);
  f.advance(MIN_REQUEST_INTERVAL_MS - 1);
  await f.client()({ ...f.request, force: true });
  assert.equal(f.requests, 1);
  f.advance(1);
  await f.client()(f.request);
  assert.equal(f.requests, 2);
});

test("failed requests are also throttled and release the lock for later retries", async (t) => {
  const f = await fixture(t);
  f.respond(async () => { throw new Error("mock offline"); });
  const failed = await f.client()(f.request);
  assert.equal(failed.ok, false);
  assert.deepEqual(await f.client()({ ...f.request, force: true }), failed);
  assert.equal(f.requests, 1);
  f.advance(MIN_REQUEST_INTERVAL_MS);
  f.respond(async () => new Response(JSON.stringify({ key: { usage: 2, limit: 10 } })));
  assert.equal((await f.client()(f.request)).ok, true);
  assert.equal(f.requests, 2);
});

test("different credentials do not share snapshots or cooldowns", async (t) => {
  const f = await fixture(t);
  const first = await f.client()(f.request);
  const other = await f.client()({ ...f.request, apiKey: "another-mock-key" });
  assert.equal(f.requests, 2);
  assert.notDeepEqual(other, first);
  assert.deepEqual(await f.client()(f.request), first);
});

test("cache files use a fingerprint, contain no API key, and are private", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.client()(f.request)).ok, true);
  const files = await readdir(f.directory);
  assert.equal(files.length, 1, "the released lock and temporary file must be gone");
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  const path = join(f.directory, files[0]);
  assert.equal((await readFile(path, "utf8")).includes(f.request.apiKey), false);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("fetch errors cannot leak the key into the RPC result or persisted cache", async (t) => {
  const f = await fixture(t);
  f.respond(async () => { throw new Error(`invalid Authorization: Bearer ${f.request.apiKey}`); });
  const result = await f.client()(f.request);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(f.request.apiKey), false);
  const [file] = await readdir(f.directory);
  assert.equal((await readFile(join(f.directory, file), "utf8")).includes(f.request.apiKey), false);
});

test("a stale lock left by a dead process can be recovered", async (t) => {
  const f = await fixture(t);
  await f.client()(f.request);
  f.advance(CACHE_TTL_MS);
  const [file] = await readdir(f.directory);
  const lockPath = join(f.directory, `${file}.lock`);
  await mkdir(lockPath);
  const stale = new Date(Date.now() - 120_000);
  await utimes(lockPath, stale, stale);
  assert.equal((await f.client()(f.request)).ok, true);
  assert.equal(f.requests, 2);
});

test("missing or unreadable local credentials do not touch the cache or network", async (t) => {
  const f = await fixture(t);
  const missing = await f.client()({ env: {}, fetchImpl: f.request.fetchImpl });
  assert.equal(missing.ok, false);
  const unreadable = await f.client()({
    env: {}, apiKey: "{file:/mock-missing-key}", fetchImpl: f.request.fetchImpl,
    readFile: () => { throw new Error("mock ENOENT"); },
  });
  assert.equal(unreadable.ok, false);
  assert.equal(f.requests, 0);
  assert.deepEqual(await readdir(f.directory), []);
});

test("corrupt or incomplete cache records are recovered without breaking the sidebar", async (t) => {
  const f = await fixture(t);
  await f.client()(f.request);
  const [file] = await readdir(f.directory);
  for (const contents of ["not JSON", "null", '{"version":1}']) {
    await writeFile(join(f.directory, file), contents);
    assert.equal((await f.client()(f.request)).ok, true);
  }
  assert.equal(f.requests, 4);
});

test("unavailable cache storage fails closed instead of sending uncoordinated requests", async (t) => {
  const f = await fixture(t);
  const blocked = join(f.directory, "not-a-directory");
  await writeFile(blocked, "mock");
  const result = await createQuotaClient({ directory: blocked })(f.request);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /quota cache unavailable/);
  assert.equal(f.requests, 0);
});

test("local credential fallback uses the shared client and never falls through after a local error", async (t) => {
  const f = await fixture(t);
  let remoteCalls = 0;
  let authorization: string | null = null;
  const client = f.client();
  const remote = async () => {
    remoteCalls++;
    return { ok: false as const, message: "not connected" };
  };
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ key: { usage: 2, limit: 10 } }));
  }) as typeof fetch;
  const local = await fetchQuotaWithFallback({
    env: { TAVILY_API_KEY: "env-key" }, apiKey: "option-key", remote, fetchImpl, client,
  });
  assert.equal(local.ok, true);
  assert.equal(authorization, "Bearer env-key");
  assert.equal(remoteCalls, 0);
  const option = await fetchQuotaWithFallback({ env: {}, apiKey: "option-key", remote, fetchImpl, client });
  assert.equal(option.ok, true);
  assert.equal(authorization, "Bearer option-key");
  assert.equal(remoteCalls, 0);
  const connected = await fetchQuotaWithFallback({ env: {}, remote, fetchImpl, client });
  assert.deepEqual(connected, { ok: false, message: "not connected" });
  assert.equal(remoteCalls, 1);
  const rejected = await fetchQuotaWithFallback({
    env: {}, apiKey: "bad-key", remote, client,
    fetchImpl: async () => new Response("", { status: 401 }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(remoteCalls, 1);
});

test("separate processes share a single quota request without real network access", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const moduleUrl = new URL("./quota-client.ts", import.meta.url).href;
  const script = `
    const { createQuotaClient } = await import(process.argv[2]);
    let requests = 0;
    const result = await createQuotaClient({ directory: process.argv[1] })({
      apiKey: 'mock-process-key', env: {},
      fetchImpl: async () => {
        requests++;
        return new Response(JSON.stringify({ key: { usage: 2, limit: 10 } }));
      },
    });
    console.log(JSON.stringify({ requests, result }));
  `;
  const run = async () => {
    const { stdout } = await execFileAsync(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, f.directory, moduleUrl],
      { timeout: 20_000 });
    return JSON.parse(stdout) as { requests: number; result: unknown };
  };
  const results = await Promise.all(Array.from({ length: 6 }, run));
  assert.equal(results.reduce((sum, item) => sum + item.requests, 0), 1);
  assert.equal((results[0].result as { ok: boolean }).ok, true);
  for (const { result } of results) assert.deepEqual(result, results[0].result);
  assert.equal((await run()).requests, 0, "a new process must reuse the persisted snapshot");
});

test("a process exit during a request preserves the reserved interval", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const moduleUrl = new URL("./quota-client.ts", import.meta.url).href;
  const script = `
    const { createQuotaClient } = await import(process.argv[2]);
    await createQuotaClient({ directory: process.argv[1], now: () => Number(process.argv[3]) })({
      apiKey: 'mock-shared-key', env: {}, fetchImpl: async () => process.exit(0),
    });
  `;
  await execFileAsync(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script, f.directory, moduleUrl, String(f.now)],
    { timeout: 20_000 });
  assert.equal((await f.client()({ ...f.request, force: true })).ok, false);
  assert.equal(f.requests, 0, "a restart must not immediately send another request");
  f.advance(MIN_REQUEST_INTERVAL_MS);
  assert.equal((await f.client()(f.request)).ok, true);
  assert.equal(f.requests, 1);
});
