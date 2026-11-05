import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import plugin from "../index.ts";

type Handlers = {
  usage: (input?: { force?: boolean }) => Promise<unknown>;
  invalidate: () => Promise<unknown>;
};

type FakeContext = Parameters<typeof plugin.setup>[0];

/** Run a test without an ambient TAVILY_API_KEY so precedence is deterministic. */
async function withoutAmbientKey<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.TAVILY_API_KEY;
  const savedCache = process.env.XDG_CACHE_HOME;
  const directory = mkdtempSync(join(tmpdir(), "tavily-server-cache-"));
  process.env.XDG_CACHE_HOME = directory;
  delete process.env.TAVILY_API_KEY;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = saved;
    if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = savedCache;
    rmSync(directory, { recursive: true, force: true });
  }
}

function memoryStorage(): {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
} {
  const values = new Map<string, unknown>();
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
}

async function setup(ctx: Record<string, unknown>): Promise<Handlers> {
  let handlers: Handlers | undefined;
  const context = {
    rpc: {
      register: async (_definition: unknown, registered: Handlers) => {
        handlers = registered;
      },
    },
    storage: memoryStorage(),
    ...ctx,
  };
  await plugin.setup(context as unknown as FakeContext);
  assert.ok(handlers);
  return handlers;
}

function mockFetch(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): { fetch: typeof fetch; calls: () => number; authorization: () => string | null } {
  let calls = 0;
  let authorization: string | null = null;
  return {
    fetch: (async (_url: unknown, init?: RequestInit) => {
      calls++;
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify(body), { status, headers });
    }) as typeof fetch,
    calls: () => calls,
    authorization: () => authorization,
  };
}

test("server RPC resolves the active Tavily login and returns quota without the key", async () => {
  await withoutAmbientKey(async () => {
    const originalFetch = globalThis.fetch;
    const mocked = mockFetch({ key: { usage: 2, limit: 10 } });
    globalThis.fetch = mocked.fetch;

    try {
      const handlers = await setup({
        integration: {
          connection: {
            active: async (id: string) => {
              assert.equal(id, "tavily");
              return { type: "credential", id: "cred_1", label: "Tavily" };
            },
            resolve: async () => ({ type: "key", key: "saved-key" }),
          },
        },
      });
      const result = (await handlers.usage()) as { ok: boolean; message?: string };
      assert.equal(mocked.authorization(), "Bearer saved-key");
      assert.deepEqual(result, {
        ok: true,
        snapshot: {
          planName: "Tavily", used: 2, limit: 10, remaining: 8,
          percentRemaining: 80, updatedAt: (result as unknown as { snapshot: { updatedAt: number } }).snapshot.updatedAt,
        },
      });
      assert.equal(JSON.stringify(result).includes("saved-key"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("server RPC shares one request across locations and forced refreshes", async () => {
  await withoutAmbientKey(async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response(JSON.stringify({ key: { usage: 2, limit: 10 } }));
    }) as typeof fetch;
    try {
      const handlers: Array<(input?: { force?: boolean }) => Promise<unknown>> = [];
      for (let i = 0; i < 12; i++) {
        const rpc = await setup({
          integration: {
            connection: {
              active: async () => ({ type: "credential", id: "cred_shared", method: "key" }),
              resolve: async () => ({ type: "key", key: "shared-saved-key" }),
            },
          },
        });
        handlers.push(rpc.usage);
      }
      const results = await Promise.all(handlers.map((handler) => handler({ force: true })));
      assert.equal(requests, 1);
      for (const result of results) assert.deepEqual(result, results[0]);
      await handlers[0]({ force: true });
      assert.equal(requests, 1, "manual refresh must respect the shared minimum interval");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("server RPC does not query Tavily when no active connection exists", async () => {
  await withoutAmbientKey(async () => {
    const handlers = await setup({
      integration: {
        connection: {
          active: async () => undefined,
          resolve: async () => { throw new Error("should not resolve"); },
        },
      },
    });
    assert.deepEqual(await handlers.usage(), {
      ok: false,
      message: "no active Tavily connection (run opencode auth login tavily)",
    });
  });
});

test("server RPC reports a connection that needs re-authentication", async () => {
  await withoutAmbientKey(async () => {
    const handlers = await setup({
      integration: {
        connection: {
          active: async () => ({
            type: "credential",
            id: "cred_1",
            label: "Tavily",
            method: "key",
            status: { status: "needs_auth", message: "token expired" },
          }),
          resolve: async () => { throw new Error("should not resolve a connection needing auth"); },
        },
      },
    });
    assert.deepEqual(await handlers.usage(), {
      ok: false,
      message: "Tavily needs re-authentication: token expired",
    });
  });
});

test("server RPC includes the sign-in URL for a connection that needs auth", async () => {
  await withoutAmbientKey(async () => {
    const handlers = await setup({
      integration: {
        connection: {
          active: async () => ({
            type: "credential",
            id: "cred_1",
            label: "Tavily",
            method: "oauth",
            status: {
              status: "needs_auth",
              message: "token expired",
              url: "https://auth.example/tavily",
            },
          }),
          resolve: async () => { throw new Error("should not resolve"); },
        },
      },
    });
    assert.deepEqual(await handlers.usage(), {
      ok: false,
      message:
        "Tavily needs re-authentication: token expired (sign in at https://auth.example/tavily)",
    });
  });
});

test("server RPC explains an external credential source without resolving it", async () => {
  await withoutAmbientKey(async () => {
    const handlers = await setup({
      integration: {
        connection: {
          active: async () => ({ type: "credential", id: "cred_1", label: "Tavily", method: "external" }),
          resolve: async () => { throw new Error("should not resolve an external credential"); },
        },
      },
    });
    assert.deepEqual(await handlers.usage(), {
      ok: false,
      message:
        "Tavily is connected through an external credential source this plugin cannot read; set TAVILY_API_KEY or the apiKey plugin option",
    });
  });
});

test("server RPC distinguishes an OAuth credential from an external one", async () => {
  await withoutAmbientKey(async () => {
    const handlers = await setup({
      integration: {
        connection: {
          active: async () => ({ type: "credential", id: "cred_1", label: "Tavily", method: "oauth" }),
          resolve: async () => { throw new Error("should not resolve an OAuth credential"); },
        },
      },
    });
    const result = (await handlers.usage()) as { ok: boolean; message: string };
    assert.equal(result.ok, false);
    assert.match(result.message, /OAuth credential this plugin cannot use as an API key/);
  });
});

test("server RPC reports a credential that cannot be resolved", async () => {
  await withoutAmbientKey(async () => {
    const handlers = await setup({
      integration: {
        connection: {
          active: async () => ({ type: "credential", id: "cred_1", label: "Tavily", method: "key" }),
          resolve: async () => {
            throw new Error("keyring locked");
          },
        },
      },
    });
    assert.deepEqual(await handlers.usage(), {
      ok: false,
      message: "could not read the Tavily connection: keyring locked",
    });
  });
});

test("the apiKey option takes precedence over the active OpenCode connection", async () => {
  await withoutAmbientKey(async () => {
    const originalFetch = globalThis.fetch;
    const mocked = mockFetch({ key: { usage: 2, limit: 10 } });
    globalThis.fetch = mocked.fetch;
    try {
      const handlers = await setup({
        options: { apiKey: "option-key" },
        integration: {
          connection: {
            active: async () => ({ type: "credential", id: "cred_1", label: "Tavily", method: "key" }),
            resolve: async () => { throw new Error("should not resolve when apiKey is set"); },
          },
        },
      });
      const result = (await handlers.usage()) as { ok: boolean; message?: string };
      assert.equal(result.ok, true);
      assert.equal(mocked.authorization(), "Bearer option-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("TAVILY_API_KEY takes precedence over the apiKey option on the server", async () => {
  await withoutAmbientKey(async () => {
    const originalFetch = globalThis.fetch;
    const mocked = mockFetch({ key: { usage: 2, limit: 10 } });
    globalThis.fetch = mocked.fetch;
    process.env.TAVILY_API_KEY = "env-key";
    try {
      const handlers = await setup({ options: { apiKey: "option-key" } });
      const result = (await handlers.usage()) as { ok: boolean; message?: string };
      assert.equal(result.ok, true);
      assert.equal(mocked.authorization(), "Bearer env-key");
    } finally {
      delete process.env.TAVILY_API_KEY;
      globalThis.fetch = originalFetch;
    }
  });
});

test("server RPC expands {env:...} in the apiKey option", async () => {
  await withoutAmbientKey(async () => {
    const originalFetch = globalThis.fetch;
    const mocked = mockFetch({ key: { usage: 2, limit: 10 } });
    globalThis.fetch = mocked.fetch;
    process.env.TAVILY_OPTION_KEY = "expanded-key";
    try {
      const handlers = await setup({ options: { apiKey: "{env:TAVILY_OPTION_KEY}" } });
      const result = (await handlers.usage()) as { ok: boolean; message?: string };
      assert.equal(result.ok, true);
      assert.equal(mocked.authorization(), "Bearer expanded-key");
    } finally {
      delete process.env.TAVILY_OPTION_KEY;
      globalThis.fetch = originalFetch;
    }
  });
});

test("server RPC expands {file:...} in the apiKey option", async () => {
  await withoutAmbientKey(async () => {
    const originalFetch = globalThis.fetch;
    const mocked = mockFetch({ key: { usage: 2, limit: 10 } });
    globalThis.fetch = mocked.fetch;
    const directory = mkdtempSync(join(tmpdir(), "tavily-quota-"));
    const file = join(directory, "key");
    writeFileSync(file, "file-key\n");
    try {
      const handlers = await setup({ options: { apiKey: `{file:${file}}` } });
      const result = (await handlers.usage()) as { ok: boolean; message?: string };
      assert.equal(result.ok, true);
      assert.equal(mocked.authorization(), "Bearer file-key");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      globalThis.fetch = originalFetch;
    }
  });
});

test("server RPC caches quota and invalidate cannot bypass its minimum interval", async () => {
  await withoutAmbientKey(async () => {
    const originalFetch = globalThis.fetch;
    const mocked = mockFetch({ key: { usage: 2, limit: 10 } });
    globalThis.fetch = mocked.fetch;
    try {
      const storage = memoryStorage();
      const handlers = await setup({ options: { apiKey: "option-key" }, storage });
      const first = await handlers.usage();
      const cached = await handlers.usage();
      assert.deepEqual(cached, first);
      assert.equal(mocked.calls(), 1);

      // Force skips the fresh-cache TTL, not the 65-second minimum interval.
      const forced = (await handlers.usage({ force: true })) as {
        ok: boolean;
        snapshot?: { remaining: number };
      };
      assert.equal(forced.ok, true);
      assert.equal(forced.snapshot?.remaining, 8);
      assert.equal(mocked.calls(), 1);

      await handlers.invalidate();
      await handlers.usage();
      assert.equal(mocked.calls(), 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("server RPC persists a Retry-After cooldown across a restart", async () => {
  await withoutAmbientKey(async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "120" },
      });
    }) as typeof fetch;
    try {
      const storage = memoryStorage();
      const first = await setup({ options: { apiKey: "option-key" }, storage });
      const limited = (await first.usage()) as { ok: boolean; retryAt: number };
      assert.equal(limited.ok, false);
      assert.ok(limited.retryAt > 0);
      assert.equal(fetchCalls, 1);

      // A fresh server instance (restart) shares the persisted cooldown.
      const restarted = await setup({ options: { apiKey: "option-key" }, storage });
      const waited = (await restarted.usage()) as { ok: boolean; message: string };
      assert.equal(waited.ok, false);
      assert.match(waited.message, /rate limited/);
      assert.equal(fetchCalls, 1);

      // Manual refresh also waits out the cooldown.
      const forced = (await restarted.usage({ force: true })) as { ok: boolean };
      assert.equal(forced.ok, false);
      assert.equal(fetchCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
