# dsh-usage-stats

[English](README.md) | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds a **Usage** page to Settings, laying out what the local Session corpus knows about your own usage — cumulative and peak tokens, chat duration and streaks, a full year of Token activity, and each model's input / output / cache-hit rate and **cost**.

![Usage statistics icon](icon.svg)

```text
Settings → Usage
┌──────────────────────────────────────────────────────────────────┐
│ Token activity                     [Daily]  Weekly  Cumulative  Refresh │
│                                                                  │
│  ┌───────────┬───────────┬───────────┬───────────┬───────────┐   │
│  │  58.5M    │  54.7M    │  30.7 h   │   2 days  │   2 days  │   │
│  │Total token│Peak token │Longest chat│Cur. streak│Max. streak│   │
│  └───────────┴───────────┴───────────┴───────────┴───────────┘   │
│                                                                  │
│  ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢       │
│  ⋮ 53 weeks × 7 rows, one square per day, 6 shades, deeper = busier │
│  Oct     Nov     Dec     Jan     Feb   …                     Sep  │
│                                                                  │
│  Model detail                                    Today  [Total]   │
│  Model           Total tokens   Input   Output  Cache read  Hit  Total cost │
│  deepseek-flash      1.2亿      90.6万  53.7万     1.2亿   99.2%    65.5   │
│                                                                  │
│  scanned 5/5 sessions · updated 20:23                            │
└──────────────────────────────────────────────────────────────────┘
```

The labels follow the UI language; the mock above shows the Chinese UI.

## What it shows

| Area | Content |
|---|---|
| Five headline cells | **Total tokens**, **Peak tokens** (busiest day, with its date), **Longest chat**, **Current streak**, **Longest streak** |
| Token activity | A 53-week × 7-row calendar, one square per day, with **Daily / Weekly / Cumulative** aggregation, month labels, and **six shades** of one accent — the busier the day, the deeper the colour |
| Model detail | One row per model: total tokens, input, output, cache read, cache hit rate, and **cost** that the Today / Total control switches between |

The calendar always draws the **complete last 371 days (53 weeks)**, so a young install still shows a full grid of mostly-empty squares instead of a single column.

## Where the numbers come from

Every number comes from the durable session log. Each `assistant/message` event carries the provider's own `TokenUsage` sample and the route it was billed on, so the figures are **exact rather than estimated**:

```text
Total tokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
Input        = inputTokens          (prompt tokens that were NOT served from cache)
Output       = outputTokens
Cache read   = cacheReadTokens
Cache hit    = cacheReadTokens / (cacheReadTokens + inputTokens)
Cost         = Σ_tariff ( input × rate + output × rate
                        + cacheRead × rate + cacheWrite × rate ) / unit
```

A few conventions:

- **Buckets follow the local calendar day** (not UTC), one day is one index, so daylight-saving transitions cannot break a streak.
- **Every workspace counts**, subagent Sessions included — they are real spend.
- Each sample is also split by **tariff** (`peak` / `offPeak`) while folding, because a provider that discounts off-peak hours bills the same tokens differently. The fold knows no price: the Host passes a classifier in and turns the split into money, so the browser never sees a rate.

## Cost: `prices.json`

The rate table is [`prices.json`](prices.json), beside `lib/`. **The Host re-reads it on every scan**, so editing the file and pressing **Refresh** in the panel is the whole update loop — no reinstall, no page reload.

```json
{
  "unit": 1000000,
  "currency": "",
  "offPeakWindow": { "start": "00:30", "end": "08:30", "weekends": true, "utcOffsetMinutes": 480 },
  "models": [
    { "model": "deepseek-flash",
      "input": 2, "cacheRead": 0.5, "output": 8, "cacheWrite": 0,
      "offPeak": { "input": 1, "cacheRead": 0.25, "output": 4, "cacheWrite": 0 } }
  ]
}
```

| Field | Meaning |
|---|---|
| `unit` | Token denominator the rates are quoted per. Default one million. |
| `currency` | Prefix rendered before a cost. Empty by default, so a cost is a bare number; put `¥` or `$` here to show one. |
| `offPeakWindow` | The discounted hours, in the **provider's own clock**. `start` is inclusive, `end` exclusive, the window may cross midnight, `weekends` covers Saturday and Sunday whole, and `utcOffsetMinutes` says which clock to read (480 = UTC+8). `null` disables the split. |
| `models[]` | One rate row. `model` matches the event's model id; add `provider` to match `provider/model` exactly. `offPeak` is optional — without it that model bills every sample at its peak rates. |
| `config.prices` | The Loader config's own `prices` array is appended after the file, so a profile patch can override one row without editing the plugin. |

**Rates are matched, never guessed.** A model with no matching row renders `—`, so an unknown provider is visibly unknown rather than silently free.

> ⚠️ **The rates shipped in this repository are placeholders.** While building the plugin, `web_fetch` was blocked in my sandbox (every hostname resolved to a non-public IP) and DSH itself exposes no monetary metadata, so `deepseek-flash` = input 2 / cache-hit 0.5 / output 8 and `deepseek-v4-pro` = 4 / 1 / 16, with 50% and 25% off-peak rates, are estimates from published pricing. **Check them against your own bill.** Every change lives in the single `prices.json` file.

## Requirements

- DeepSeek Harness with `ui-settings-general` in the composition (Desktop and `dsh web` both qualify).
- Verified against DSH `0.2.0-rc.2` on macOS.

## Install

### Option A — straight from GitHub (no clone)

Ask the Harness agent to run:

```text
plugin_manager install_bundle  target: github:ShawnShang-1/dsh-usage-stats
```

That installs the latest commit. Re-run it to upgrade.

### Option B — clone, then install locally (the path I verified)

```bash
git clone https://github.com/ShawnShang-1/dsh-usage-stats.git ~/code/dsh-usage-stats
```

Then ask the Harness agent to run:

```text
plugin_manager install_bundle  target: /Users/you/code/dsh-usage-stats
```

or, with the `dsh` CLI on the `PATH`:

```bash
dsh plugin --profile "$DSH_PROFILE" add ~/code/dsh-usage-stats
```

Either way the package declares both halves — `dsh.bundle.patch` for the Host row and `dsh.client` for the browser bundle — so one install adds both. The install applies live through HMR; **if the Settings panel does not change, close and reopen it, or reload the page (`Cmd`/`Ctrl` + `R`).**

### Verify

Open **Settings → Usage** — it sits between Models and Built-in plugins — and the mock at the top of this file is what you should see.

To check the Host half without the UI: an unmounted prefix falls through to `405`, while a mounted route behind the browser trust fence answers `401`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:19387/dsh-usage-stats/overview
# 401
```

## Configuration

Edit the plugin's row in your profile `cordis.patch.yml`, or pass the values at install time:

| Field | Default | Meaning |
|---|---|---|
| `ttlMs` | `30000` | How long one scan is served before a background re-scan. `0` re-scans on every read. |
| `maxSessions` | `4000` | Upper bound on the corpus one scan folds. |
| `prices` | — | Extra or overriding rate rows; see above. |

```yaml
- id: usage-stats
  name: './lib/entry.js'
  config:
    ttlMs: 30000
    maxSessions: 4000
    prices:
      - model: some-other-model
        input: 1
        cacheRead: 0.2
        output: 4
```

## Uninstall

```text
plugin_manager remove_bundle dsh-usage-stats
```

The plugin directory, `prices.json` and your edits stay where they are; re-run the install to bring the rows back.

## How it works

| Half | File | Role |
|---|---|---|
| Host | `lib/entry.js` | The Loader row's stable module. Re-imports `lib/host.js` by file revision on every activation. |
| Host | `lib/host.js` | Scans `ctx.sessionQuery` (every session), folds each log with `lib/fold.js`, and answers over one `/dsh-usage-stats` prefix route on the composed webserver. |
| Host | `lib/fold.js` | Pure fold: events in, JSON aggregate out, split by tariff. No Cordis, no clock, no I/O. |
| Host | `lib/pricing.js` | Pure pricing: a rate document in, matching / off-peak classification / money out. |
| Browser | `lib/client.js` | Registers the Usage page into the `settings.section` slot, fetches the route, and renders the aggregate. |

The route admits through `ctx.connection.admit(req)`, so it inherits the same browser trust fence and persistent browser session every `/api`-family route uses, then answers plain JSON:

```text
POST /dsh-usage-stats/overview   the last scan (re-scanning in the background when stale)
POST /dsh-usage-stats/refresh    force a re-scan (the panel's Refresh control)
```

### Why the entry is a shim

The vendored Loader keeps Node's ESM cache, keyed by the exact resolved module URL. A row whose specifier never changes therefore keeps executing the module it first imported — editing plugin code in a running process changes nothing. `lib/entry.js` resolves that by digesting the file metadata of `host.js`, `fold.js` and `pricing.js` into one revision and importing `host.js` through it; `host.js` passes the same query on to the other two. The whole implementation is one cache generation.

```text
change lib/host.js, lib/fold.js or lib/pricing.js -> next plugin activation (or a plugin toggle) picks it up
change lib/client.js                              -> the Host serves a new bundle revision; the page follows the module graph
change prices.json                                -> press Refresh in the panel
change cordis.patch.yml or package.json           -> reinstall the bundle so the profile re-reads the patch layer
```

## Offline checks

The repository ships five checks that need neither a browser nor a running Host:

```bash
node scripts/check-fold.mjs        # folds ~/.dsh/sessions and prints the aggregate
node scripts/check-prices.mjs      # rate matching, the off-peak window, the money arithmetic
node scripts/check-host.mjs        # mounts the real host half and drives one request through it
node scripts/check-ui.mjs          # stubs React; asserts the page's element tree
```

The real-DOM check needs three dev-only packages (**not** plugin dependencies — remove them afterwards):

```bash
npm i --no-save --no-package-lock react@18.3.1 react-dom@18.3.1 jsdom@24
node scripts/check-dom.mjs
rm -rf node_modules package-lock.json
```

`check-host.mjs` is the end-to-end one: it applies `lib/host.js` against a stub Cordis context whose `sessionQuery` reads the durable corpus, captures the route the plugin registers, drives a real `POST /dsh-usage-stats/overview` through it, and recomputes every cost from the raw rates to compare. It also mounts a synthetic 03:00 session to prove an off-peak sample bills at the discounted rate.

`check-dom.mjs` renders the shipped `lib/client.js` into jsdom through real React and asserts the five headline cells, the 371 day squares, the table headers, that switching to Today changes both the header and the figures, and that the three aggregations shade the same cells differently.

## Known limitations

- **The shipped rates are placeholders** — see the warning above.
- Cost is computed from **token usage** only; it excludes any provider-side charge that is not per-token (per-request fees, per-image fees, and so on).
- The calendar is always the last 371 days. Older history still counts toward the totals and the model table, it just is not drawn.
- **Longest chat** is one Session's span (first to last event), so a Session left open overnight reports a large figure.
- Everything runs locally: the plugin only reads session logs, makes no model calls, and never touches the network.
