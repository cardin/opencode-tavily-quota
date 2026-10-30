/**
 * Server entrypoint. Resolve the active Tavily credential and fetch quota
 * here; only the quota result crosses the RPC boundary to the TUI.
 *
 * The cache and the 429 cooldown live in server storage, so every TUI instance
 * and every restart shares them. Credential precedence matches the README:
 * `TAVILY_API_KEY`, then the `apiKey` plugin option, then the active OpenCode
 * Tavily connection.
 */

import { Plugin } from "@opencode/plugin";
import { TavilyQuotaRpc } from "./rpc";
import { createQuotaService, createSharedQuotaStorage, keyIdentity } from "./quota-cache";
import { fetchQuota, resolveApiKey } from "./usage";

export const PLUGIN_ID = "opencode-tavily-quota";

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const optionKey = typeof ctx.options?.apiKey === "string" ? ctx.options.apiKey : undefined;

    const service = createQuotaService({
      storage: createSharedQuotaStorage(ctx.storage),
      resolve: async () => {
        let localKey: string;
        try {
          localKey = resolveApiKey(process.env, optionKey);
        } catch (error) {
          // A `{file:...}` option can point at a missing or unreadable file.
          const reason = error instanceof Error ? error.message : String(error);
          return { ok: false, message: reason };
        }
        if (localKey) {
          return {
            ok: true,
            identity: keyIdentity(localKey),
            fetch: () => fetchQuota({ apiKey: localKey, env: {} }),
          };
        }

        let connection;
        try {
          connection = await ctx.integration.connection.active("tavily");
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { ok: false, message: `could not look up the Tavily connection: ${reason}` };
        }
        if (!connection) {
          return {
            ok: false,
            message: "no active Tavily connection (run opencode auth login tavily)",
          };
        }

        // The host flags a connection whose saved credential needs sign-in again;
        // report that instead of resolving it (or showing a generic error).
        if (connection.status?.status === "needs_auth") {
          const { message, url } = connection.status;
          return {
            ok: false,
            message: url
              ? `Tavily needs re-authentication: ${message} (sign in at ${url})`
              : `Tavily needs re-authentication: ${message}`,
          };
        }

        // An external credential source keeps its secret outside the store, so
        // there is no key for the plugin to read; point at the local options.
        if (connection.type === "credential" && connection.method === "external") {
          return {
            ok: false,
            message:
              "Tavily is connected through an external credential source this plugin cannot read; set TAVILY_API_KEY or the apiKey plugin option",
          };
        }
        // An OAuth grant is not a Tavily API key, even though it is readable.
        if (connection.type === "credential" && connection.method === "oauth") {
          return {
            ok: false,
            message:
              "Tavily is connected with an OAuth credential this plugin cannot use as an API key; set TAVILY_API_KEY or the apiKey plugin option",
          };
        }

        let key: string | undefined;
        if (connection.type === "env") {
          key = (process.env[connection.name] ?? "").trim();
          if (!key) {
            return {
              ok: false,
              message: `Tavily expects ${connection.name} in the server environment, but it is not set`,
            };
          }
        } else {
          let credential;
          try {
            credential = await ctx.integration.connection.resolve(connection);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return { ok: false, message: `could not read the Tavily connection: ${reason}` };
          }
          if (credential?.type === "key") {
            key = credential.key;
          } else if (credential?.type === "external") {
            return {
              ok: false,
              message:
                "Tavily is connected through an external credential source this plugin cannot read; set TAVILY_API_KEY or the apiKey plugin option",
            };
          } else if (credential?.type === "oauth") {
            return {
              ok: false,
              message:
                "Tavily is connected with an OAuth credential this plugin cannot use as an API key; set TAVILY_API_KEY or the apiKey plugin option",
            };
          }
        }

        if (!key) {
          return {
            ok: false,
            message: "no active Tavily connection (run opencode auth login tavily)",
          };
        }
        return {
          ok: true,
          identity: keyIdentity(key),
          fetch: () => fetchQuota({ apiKey: key, env: {} }),
        };
      },
    });

    await ctx.rpc.register(TavilyQuotaRpc, {
      usage: async (input) =>
        service.usage((input as { force?: boolean } | undefined)?.force === true),
      invalidate: async () => {
        await service.invalidate();
        return { ok: true };
      },
    });
  },
});
