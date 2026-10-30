import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import plugin from "./index.ts";

async function sandboxCache(t: TestContext): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "tavily-server-test-"));
  const original = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = directory;
  t.after(async () => {
    if (original === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = original;
    await rm(directory, { recursive: true, force: true });
  });
}

test("server RPC resolves the active Tavily login and returns quota without the key", async (t) => {
  await sandboxCache(t);
  const originalFetch = globalThis.fetch;
  let authHeader: string | null = null;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    authHeader = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ key: { usage: 2, limit: 10 } }), { status: 200 });
  }) as typeof fetch;

  try {
    let handler: (() => Promise<unknown>) | undefined;
    const ctx = {
      rpc: {
        register: async (_definition: unknown, handlers: { usage: () => Promise<unknown> }) => {
          handler = handlers.usage;
        },
      },
      integration: {
        connection: {
          active: async (id: string) => {
            assert.equal(id, "tavily");
            return { type: "credential", id: "cred_1", label: "Tavily" };
          },
          resolve: async () => ({ type: "key", key: "saved-key" }),
        },
      },
    };
    await plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0]);
    assert.ok(handler);
    const result = await handler();
    assert.equal(authHeader, "Bearer saved-key");
    assert.deepEqual(result, {
      ok: true,
      snapshot: {
        planName: "Tavily", used: 2, limit: 10, remaining: 8,
        percentRemaining: 80, updatedAt: (result as { snapshot: { updatedAt: number } }).snapshot.updatedAt,
      },
    });
    assert.equal(JSON.stringify(result).includes("saved-key"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("server RPC shares one request across locations and forced refreshes", async (t) => {
  await sandboxCache(t);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response(JSON.stringify({ key: { usage: 2, limit: 10 } }));
  }) as typeof fetch;
  try {
    const handlers: Array<(input?: { force?: boolean }) => Promise<unknown>> = [];
    for (let i = 0; i < 12; i++) {
      const ctx = {
        rpc: {
          register: async (_definition: unknown, rpc: { usage: typeof handlers[number] }) => {
            handlers.push(rpc.usage);
          },
        },
        integration: {
          connection: {
            active: async () => ({ type: "credential", id: "cred_shared", method: "key" }),
            resolve: async () => ({ type: "key", key: "shared-saved-key" }),
          },
        },
      };
      await plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0]);
    }
    const results = await Promise.all(handlers.map((handler) => handler({ force: true })));
    assert.equal(requests, 1);
    assert.ok(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0])));
    await handlers[0]({ force: true });
    assert.equal(requests, 1, "manual refresh must respect the shared minimum interval");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("server RPC does not query Tavily when no active connection exists", async () => {
  let handler: (() => Promise<unknown>) | undefined;
  const ctx = {
    rpc: {
      register: async (_definition: unknown, handlers: { usage: () => Promise<unknown> }) => {
        handler = handlers.usage;
      },
    },
    integration: {
      connection: {
        active: async () => undefined,
        resolve: async () => { throw new Error("should not resolve"); },
      },
    },
  };
  await plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0]);
  assert.ok(handler);
  assert.deepEqual(await handler(), {
    ok: false,
    message: "no active Tavily connection (run opencode auth login tavily)",
  });
});

test("server RPC reports a connection that needs re-authentication", async () => {
  let handler: (() => Promise<unknown>) | undefined;
  const ctx = {
    rpc: {
      register: async (_definition: unknown, handlers: { usage: () => Promise<unknown> }) => {
        handler = handlers.usage;
      },
    },
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
  };
  await plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0]);
  assert.ok(handler);
  assert.deepEqual(await handler(), {
    ok: false,
    message: "Tavily needs re-authentication: token expired",
  });
});

test("server RPC explains an external credential source without resolving it", async () => {
  let handler: (() => Promise<unknown>) | undefined;
  const ctx = {
    rpc: {
      register: async (_definition: unknown, handlers: { usage: () => Promise<unknown> }) => {
        handler = handlers.usage;
      },
    },
    integration: {
      connection: {
        active: async () => ({ type: "credential", id: "cred_1", label: "Tavily", method: "external" }),
        resolve: async () => { throw new Error("should not resolve an external credential"); },
      },
    },
  };
  await plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0]);
  assert.ok(handler);
  assert.deepEqual(await handler(), {
    ok: false,
    message:
      "Tavily is connected through an external credential source this plugin cannot read; set TAVILY_API_KEY or the apiKey plugin option",
  });
});
