import { Rpc } from "@opencode/plugin/rpc";

const snapshotSchema = {
  type: "object",
  properties: {
    planName: { type: "string" },
    used: { type: "number" },
    limit: { type: "number" },
    remaining: { type: "number" },
    percentRemaining: { type: "number" },
    updatedAt: { type: "number" },
  },
  required: ["planName", "used", "limit", "remaining", "percentRemaining", "updatedAt"],
  additionalProperties: false,
} as const;

/** The server fetches quota so the saved OpenCode credential never enters the TUI. */
export const TavilyQuotaRpc = Rpc.define({
  id: "opencode-tavily-quota",
  methods: {
    usage: {
      input: {
        type: "object",
        properties: {
          /** Manual refresh bypasses the fresh cache, but not a 429 cooldown. */
          force: { type: "boolean" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          message: { type: "string" },
          snapshot: snapshotSchema,
          /** Epoch milliseconds when the rate-limit cooldown expires. */
          retryAt: { type: "number" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    invalidate: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});
