/** @jsxImportSource @opentui/solid */

/**
 * Tavily quota sidebar — an OpenCode 2 TUI plugin.
 *
 * Renders the remaining Tavily API credits in the session sidebar
 * (`sidebar.content`) and exposes a `/tavily-quota` slash command /
 * "Refresh Tavily quota" palette command that re-fetches on demand.
 *
 * The server owns the quota cache and the rate-limit cooldown; this half only
 * decides when to ask for a snapshot. A local one-minute clock keeps the reset
 * countdown current without polling Tavily.
 *
 * Authenticate with `TAVILY_API_KEY`, the `apiKey` plugin option in `cli.json`,
 * or OpenCode's active Tavily integration. A saved key is used server-side.
 */

import type { RGBA } from "@opentui/core";
import { Plugin } from "@opencode/plugin/tui";
import type { ResolvedTheme } from "@opencode/theme/tui";
import { createSignal } from "solid-js";
import {
  formatPercent,
  formatQuotaLine,
  formatRemaining,
  formatResetLine,
} from "./usage";
import type { QuotaResponse } from "./quota-cache";
import { createQuotaRefresher, type ViewState } from "./refresh";
import { TavilyQuotaRpc } from "./rpc";

type Context = Plugin.Context;

export const PLUGIN_ID = "opencode-tavily-quota";

type ThemeColors = {
  text?: RGBA;
  textMuted?: RGBA;
};

/**
 * OpenCode 2.0.7 exposed `text.default` / `text.subdued`; later builds renamed
 * the leaves to `text.base` / `text.muted`. Read whichever the running build
 * provides so the plugin matches the built-in quota sections on both.
 */
type LegacyTextTokens = ResolvedTheme["text"] & {
  default?: RGBA;
  subdued?: RGBA;
};

function readThemeColors(theme: ResolvedTheme): ThemeColors {
  const text = theme.text as LegacyTextTokens;
  return {
    text: text.default ?? text.base,
    textMuted: text.subdued ?? text.muted,
  };
}

export function buildLines(state: ViewState, now: number = Date.now()): string[] {
  if (state.status === "loading") {
    return ["loading…"];
  }
  if (state.status === "error") {
    return [`⚠ ${state.message}`];
  }

  const snapshot = state.snapshot;
  // Reset countdown sits between the heading and the bar, matching the sidebar
  // order used by the built-in quota section. A transient failure is an extra
  // warning line so the last good snapshot stays visible.
  const lines = [formatResetLine(now), formatQuotaLine(snapshot)];
  if (state.warning) lines.push(`⚠ ${state.warning}`);
  return lines;
}

function TavilyQuotaSidebar(props: {
  context: Context;
  state: () => ViewState;
  clock: () => number;
}) {
  const colors = () => readThemeColors(props.context.theme);
  // Keep the quota line on one line; let an error/warning message wrap instead
  // of truncating it, since it can be longer than the sidebar.
  const wrapMode = () => {
    const state = props.state();
    return state.status !== "ready" || state.warning ? "word" : "none";
  };

  return (
    <box gap={0} flexDirection="column">
      <text fg={colors().text}>
        <b>Tavily</b>
      </text>
      {buildLines(props.state(), props.clock()).map((line) => (
        <text fg={colors().textMuted} wrapMode={wrapMode()}>
          {line}
        </text>
      ))}
    </box>
  );
}

function TavilyQuotaCommands(props: {
  context: Context;
  refresh: (force?: boolean) => Promise<ViewState>;
}) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: `${PLUGIN_ID}.refresh`,
        title: "Refresh Tavily quota",
        description: "Re-fetch remaining Tavily API credits and show a summary",
        group: "Tavily",
        palette: true,
        slash: { name: "tavily-quota" },
        run: async () => {
          const next = await props.refresh(true);
          const message =
            next.status === "ready"
              ? `${formatRemaining(next.snapshot)} · ${formatPercent(next.snapshot.percentRemaining)} · ${formatResetLine()}${next.warning ? ` · ${next.warning}` : ""}`
              : next.status === "error"
                ? next.message
                : "still loading…";
          const variant =
            next.status === "error" ? "error" : next.status === "ready" && next.warning ? "warning" : "info";
          // Tie the toast to the open session so the host can title it and offer
          // to open it if the session's family is not on screen.
          const route = props.context.ui.router.current();
          const sessionID = route.type === "session" ? route.sessionID : undefined;
          props.context.ui.toast.show({
            title: "Tavily quota",
            message,
            variant,
            sessionID,
          });
        },
      },
    ],
  }));

  return null;
}

export const TavilyQuotaTuiPlugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(context) {
    const [state, setState] = createSignal<ViewState>({ status: "loading" });
    // A local minute clock drives the reset countdown independently of quota
    // fetches, so it keeps ticking while the server is in a cooldown.
    const [clock, setClock] = createSignal(Date.now());

    const location = () => context.location ?? context.data.location.default();
    // Resolve the RPC client on every call: the server can restart or
    // reconnect while this TUI stays open.
    const rpc = () => context.client.rpc(TavilyQuotaRpc);

    const refresher = createQuotaRefresher({
      refreshMs: context.options.refreshMs,
      onState: (next) => setState(next),
      onClock: (now) => setClock(now),
      remote: async ({ force }) =>
        (await rpc().usage({ force }, { location: location() })) as QuotaResponse,
      invalidateRemote: async () => {
        await rpc().invalidate({}, { location: location() });
      },
    });

    const stopSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => <TavilyQuotaSidebar context={context} state={state} clock={clock} />,
    });

    // `keymap.layer` reads Solid context, so it must be mounted from a slot
    // component rather than called directly during plugin setup.
    const stopCommands = context.ui.slot({
      append: "app",
      render: () => <TavilyQuotaCommands context={context} refresh={refresher.refresh} />,
    });

    // Credential/integration changes can point at another Tavily account (or a
    // rotated key), so invalidate freshness and refetch without clearing the
    // credential's rate-limit budget. The exact event
    // names are from the OpenCode 2.2.x event declarations.
    const unsubscribes = [
      context.data.on("credential.switched", (event) => {
        if (event.data.integrationID !== "tavily") return;
        void refresher.invalidate();
      }),
      context.data.on("credential.updated", () => void refresher.invalidate()),
      context.data.on("integration.updated", () => void refresher.invalidate()),
    ];

    refresher.start();

    return () => {
      refresher.dispose();
      for (const unsubscribe of unsubscribes) unsubscribe();
      stopSidebar();
      stopCommands();
    };
  },
});

export default TavilyQuotaTuiPlugin;
