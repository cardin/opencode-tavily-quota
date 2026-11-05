import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  CACHE_STORAGE_KEY,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_MIN_INTERVAL_MS,
  createQuotaService,
  createSharedQuotaStorage,
  keyIdentity,
  type QuotaResponse,
  type QuotaStorage,
} from "../quota-cache.ts";
import type { QuotaResult } from "../usage.ts";

const execFileAsync = promisify(execFile);
const initialTime = Date.UTC(2026, 9, 30, 12);

function memoryStorage(): QuotaStorage {
  const values = new Map<string, unknown>();
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => { values.set(key, structuredClone(value)); },
    remove: async (key) => { values.delete(key); },
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "tavily-process-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = initialTime;
  let calls = 0;
  const identity = keyIdentity("mock-process-key");
  const fetch = async (): Promise<QuotaResult> => {
    calls++;
    return {
      ok: true,
      snapshot: { planName: "Tavily", used: calls, limit: 100, remaining: 100 - calls,
        percentRemaining: 100 - calls, updatedAt: now },
    };
  };
  const service = (backing = memoryStorage()) => createQuotaService({
    storage: createSharedQuotaStorage(backing, directory),
    now: () => now,
    resolve: async () => ({ ok: true, identity, fetch }),
  });
  return {
    directory, identity, service,
    get calls() { return calls; },
    advance(ms: number) { now += ms; },
  };
}

test("independent server stores share one locked quota entry", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => f.service().usage(true)));
  assert.equal(f.calls, 1);
  assert.equal(results[0].ok, true);
  for (const result of results) assert.deepEqual(result, results[0]);
});

test("shared entries remain private and are mirrored in server storage", async (t) => {
  const f = await fixture(t);
  const backing = memoryStorage();
  await f.service(backing).usage();
  const [file, ...extra] = await readdir(f.directory);
  assert.deepEqual(extra, [], "lock and temporary files must be released");
  assert.match(file, /^[a-f0-9]{64}\.json$/);
  const path = join(f.directory, file);
  const contents = await readFile(path, "utf8");
  assert.equal(contents.includes("mock-process-key"), false);
  const mirrored = await backing.get(`${CACHE_STORAGE_KEY}/${f.identity}`);
  assert.deepEqual(JSON.parse(contents), mirrored);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("a failed server-storage mirror does not bypass the shared file budget", async (t) => {
  const f = await fixture(t);
  const broken: QuotaStorage = {
    get: async () => { throw new Error("mock storage offline"); },
    set: async () => { throw new Error("mock storage offline"); },
    remove: async () => { throw new Error("mock storage offline"); },
  };
  const first = await f.service(broken).usage();
  assert.equal(first.ok, true);
  assert.deepEqual(await f.service(broken).usage(true), first);
  assert.equal(f.calls, 1);
});

test("an unreadable shared cache fails closed without an HTTP request", async (t) => {
  const f = await fixture(t);
  const blocked = join(f.directory, "blocked");
  await writeFile(blocked, "not a directory");
  let calls = 0;
  const service = createQuotaService({
    storage: createSharedQuotaStorage(memoryStorage(), blocked),
    resolve: async () => ({
      ok: true, identity: f.identity,
      fetch: async () => { calls++; throw new Error("must not fetch"); },
    }),
  });
  const result = await service.usage();
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /quota cache unavailable/);
  assert.equal(calls, 0);
});

test("corrupt shared files recover from the server mirror without another request", async (t) => {
  const f = await fixture(t);
  const backing = memoryStorage();
  const first = await f.service(backing).usage();
  const [file] = await readdir(f.directory);
  for (const contents of ["not JSON", "null", "{}"]) {
    await writeFile(join(f.directory, file), contents);
    assert.deepEqual(await f.service(backing).usage(true), first);
  }
  assert.equal(f.calls, 1);
});

test("shared storage reclaims a stale lock after a dead process", async (t) => {
  const f = await fixture(t);
  await f.service().usage();
  f.advance(DEFAULT_CACHE_TTL_MS);
  const [file] = await readdir(f.directory);
  const lockPath = join(f.directory, `${file}.lock`);
  await mkdir(lockPath);
  const stale = new Date(Date.now() - 120_000);
  await utimes(lockPath, stale, stale);
  assert.equal((await f.service().usage()).ok, true);
  assert.equal(f.calls, 2);
});

const worker = `
  const { createQuotaService, createSharedQuotaStorage, keyIdentity } = await import(process.argv[2]);
  const { fetchQuota } = await import(new URL('./usage.ts', process.argv[2]));
  const directory = process.argv[1];
  const now = Number(process.argv[3]);
  const mode = process.argv[4];
  const values = new Map();
  const backing = {
    get: async key => values.get(key),
    set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); },
  };
  let calls = 0;
  const service = createQuotaService({
    storage: createSharedQuotaStorage(backing, directory), now: () => now,
    resolve: async () => ({
      ok: true, identity: keyIdentity('mock-process-key'),
      fetch: () => fetchQuota({
        apiKey: 'mock-process-key', env: {}, now,
        fetchImpl: async () => {
          calls++;
          if (mode === 'exit') process.exit(0);
          if (mode === 'limited') return new Response('', { status: 429, headers: { 'Retry-After': '1800' } });
          return new Response(JSON.stringify({ key: { usage: 2, limit: 10 } }));
        },
      }),
    }),
  });
  if (mode === 'invalidate') await service.invalidate();
  const result = await service.usage(true);
  console.log(JSON.stringify({ calls, result }));
`;

async function runWorker(directory: string, mode = "success", now = initialTime) {
  const moduleUrl = new URL("../quota-cache.ts", import.meta.url).href;
  const { stdout } = await execFileAsync(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", worker, directory, moduleUrl, String(now), mode],
    { timeout: 20_000 });
  return stdout.trim() ? JSON.parse(stdout) as { calls: number; result: QuotaResponse } : undefined;
}

test("six server processes share one mocked HTTP request and a persisted snapshot", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => runWorker(f.directory)));
  assert.equal(results.reduce((sum, result) => sum + result!.calls, 0), 1);
  assert.equal(results[0]!.result.ok, true);
  for (const result of results) assert.deepEqual(result!.result, results[0]!.result);
  assert.equal((await runWorker(f.directory))!.calls, 0);
});

test("a 429 survives separate servers and invalidation until Retry-After expires", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const first = (await runWorker(f.directory, "limited"))!;
  assert.equal(first.calls, 1);
  assert.equal(first.result.ok, false);
  const waited = (await runWorker(f.directory, "invalidate", initialTime + 600_000))!;
  assert.equal(waited.calls, 0);
  assert.equal(waited.result.retryAt, first.result.retryAt);
  const recovered = (await runWorker(f.directory, "success", initialTime + 1_800_000))!;
  assert.equal(recovered.calls, 1);
  assert.equal(recovered.result.ok, true);
});

test("a server exit during HTTP preserves the reservation for a restarted server", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  await runWorker(f.directory, "exit");
  const interrupted = (await runWorker(f.directory))!;
  assert.equal(interrupted.calls, 0);
  assert.equal(interrupted.result.ok, false);
  const recovered = (await runWorker(f.directory, "success", initialTime + DEFAULT_MIN_INTERVAL_MS))!;
  assert.equal(recovered.calls, 1);
  assert.equal(recovered.result.ok, true);
});
