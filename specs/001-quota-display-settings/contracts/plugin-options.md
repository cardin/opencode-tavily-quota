# Contract: Plugin Options

**Feature**: `001-quota-display-settings`
**Consumers**: OpenCode users configuring display options in `cli.json`; the server plugin remains installed in `opencode.json(c)`.

## Options

The display options and `refreshMs` are optional TUI options in `cli.json`. `apiKey` remains a server option in `opencode.json(c)`.

```json
{
  "plugins": [
    {
      "package": "opencode-tavily-quota",
      "options": {
        "colors": {
          "enabled": true,
          "warningBelow": 50,
          "lowBelow": 20
        },
        "evenUse": false
      }
    }
  ]
}
```

| Option | Type | Default | Allowed values | Behavior |
| --- | --- | --- | --- | --- |
| `colors.enabled` | boolean | `true` | `true`, `false` | `false` renders the entire quota line in monochrome theme text. Non-boolean values use the default. |
| `colors.warningBelow` | number | `50` | Finite number `0..100` | Percentage remaining below which the line turns yellow. |
| `colors.lowBelow` | number | `20` | Finite number `0..100`, `<= warningBelow` | Percentage remaining below which the line turns red. |
| `evenUse` | boolean | `false` | `true`, `false` | `true` draws the `┃` even-use mark in the bar. Non-boolean values use the default. |

## Threshold Semantics

With the defaults:

- `percent >= 50` → green (`good`)
- `20 <= percent < 50` → yellow (`warning`)
- `percent < 20` → red (`low`)

The percentage used for classification is the numeric value of the displayed label. For example, a raw `19.96%` displays `20%` and is yellow.

Equal thresholds are valid. With `warningBelow == lowBelow`, the yellow band is empty and values below the shared threshold are red.

## Invalid Settings

- If a threshold is present but non-numeric, non-finite, outside `[0, 100]`, or `lowBelow > warningBelow`, both thresholds fall back to `50` and `20`.
- If a threshold is absent, the other keeps its default; the resulting pair is then validated.
- Invalid color or even-use toggles fall back to their defaults.
- Invalid display settings never prevent the plugin from rendering quota.
- Existing `apiKey` and `refreshMs` behavior is unchanged.

## Applying Changes

Display settings are read from the TUI plugin options in `cli.json`. OpenCode 2.2.5 does not forward the server entry's options to the automatically loaded TUI. After saving a change, run OpenCode's **Reload Configurations** command. The new settings apply without a full OpenCode restart. A full host reload can refresh quota through the existing refresh lifecycle; zero upstream requests across a full configuration reload is not guaranteed. Normal server cache and rate-limit protection remain unchanged. See [runtime-validation.md](../runtime-validation.md).

## Monochrome Mode

When `colors.enabled` is `false`:

- The bar fill, empty cells, percentage, countdown, and `┃` marker all use the theme's normal muted monochrome text color.
- The marker remains visible through its distinct glyph even though it shares the muted color.
- No green, yellow, or red is used anywhere in the quota line.
- The numeric percentage remains visible, so color is never the only status indicator.

## Scope

These options are display-only. They do not change quota fetching, caching, refresh timing, rate-limit handling, RPC, or the refresh toast.
