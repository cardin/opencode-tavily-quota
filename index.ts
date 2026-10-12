/**
 * Server entrypoint. Resolve the active Tavily integration credential and
 * fetch quota here; only the quota result crosses the RPC boundary to the TUI.
 */

import { Plugin } from "@opencode/plugin";
import { TavilyQuotaRpc } from "./rpc";
import { fetchQuota } from "./usage";

export const PLUGIN_ID = "opencode-tavily-quota";

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    await ctx.rpc.register(TavilyQuotaRpc, {
      usage: async () => {
        const connection = await ctx.integration.connection.active("tavily");
        if (!connection) {
          return { ok: false, message: "no active Tavily connection (run opencode auth login tavily)" };
        }
        // The host flags a connection whose saved credential needs sign-in again;
        // report that instead of resolving it (or showing a generic error).
        if (connection.status?.status === "needs_auth") {
          return { ok: false, message: `Tavily needs re-authentication: ${connection.status.message}` };
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
        const credential = await ctx.integration.connection.resolve(connection);
        const key = credential?.type === "key"
          ? credential.key
          : connection.type === "env"
            ? process.env[connection.name]
            : undefined;
        if (!key) {
          return { ok: false, message: "no active Tavily connection (run opencode auth login tavily)" };
        }
        return fetchQuota({ apiKey: key, env: {} });
      },
    });
  },
});
