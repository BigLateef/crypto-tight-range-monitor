# Crypto Tight Range Monitor (SIMULATION ONLY)

Next.js 14 + TypeScript + Neon Postgres. Watches public candle data for tight ranges, alerts on them, and runs a
**virtual** portfolio. It has no exchange keys, wallet, or order code: it only reads public prices.

## Two detection designs (Settings > Range discovery > Detection design)
- **Tight range + breakout** (default): the last N candles stay inside a narrow band and touch both edges.
- **Swing pattern + breakout** (scalping-style): price swings back and forth at least X% each way, a run of cycles that the engine counts itself (minimum 2), with the swing highs near the same level and the swing lows near the same level (zig-zag on candle closes). X is any percentage you choose. The swing highs/lows form the range.
- Either way the direction comes from the same rule below: a candle close beyond the range edge (up = long, down = short).

## Rules the code enforces
- A range alert alone never opens a position (it does not predict direction).
- Default entry: a candle must **close** outside the range (by a buffer, for N consecutive closes), in that direction.
- Entry fills at the live public price at tick time plus slippage. Skipped if it is later than `maxEntryDelaySec` after the
  confirming close, or if price is back inside the range.
- Exits use only 1-minute candles that already closed after entry (the entry minute is never scanned). If stop and target
  are both touched in one candle, the stop wins. A gap through a level fills at the candle open.
- Fees and slippage are applied to every simulated fill. Cash = start + realized P&L - cost and entry fee of open positions.
- Turning paper trading off stops new entries only. Alerts keep running, open simulated positions keep being managed.
- Optional profit lock: when a closed 1m candle reaches the trigger (e.g. +1.5%), the stop moves to a profit level (e.g. +0.5%) from the next candle on (order inside one candle is unknown, so it never acts in the same candle).
- Exit rules are snapshotted onto each position when it opens; later setting changes affect new positions only.

## Database: Neon or Supabase (auto-detected from DATABASE_URL)
- Neon: use the normal connection string (host contains neon.tech).
- Supabase: Project > Connect > **Transaction pooler** string (port 6543; the direct connection is IPv6-only and fails on Vercel). URL-encode special characters in the password. Run `sql/001_init.sql` then `sql/003_supabase_security.sql` in the SQL editor.
- Moving between databases without losing data: while still on the OLD database, Settings > Backup and move > Download backup. Pause the cron job, run the SQL on the NEW database, change DATABASE_URL, redeploy, then Settings > Restore from a backup file. Resume the cron job. Open positions keep running; the engine catches up on candles since each position's last check.

## Setup (all from a phone)
1. Neon: open the SQL editor, paste and run `sql/001_init.sql`. If you ran it before the profit-lock update, also run `sql/002_profit_lock.sql`.
2. Vercel: import the GitHub repo. Environment variables (see `.env.example`): `DATABASE_URL`, `APP_PASSWORD`,
   `SESSION_SECRET`, `CRON_SECRET`; optional `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
3. cron-job.org (Hobby Vercel cron is once/day, so use this): new job, URL `https://YOUR-APP.vercel.app/api/tick`,
   every 5 minutes at minutes 1,6,11,...,56 (custom schedule; one minute after each 5m candle closes), method GET, Advanced > Headers: `Authorization: Bearer <your CRON_SECRET>` (or, if headers are awkward, put `?cron_secret=<your CRON_SECRET>` on the URL). Test run should return JSON with `"ok":true`.
4. Open the app, sign in, check Settings, and watch the Portfolio page. Set "Cron interval" in Settings to match your schedule; it warns when the engine has missed two intervals. Exits and entries are evaluated once per tick, so they can lag by up to one interval.

## Forecast ledger and data gate (new)
- Run `sql/004_forecasts.sql` once (safe to re-run). It adds `forecasts` (append-only: UPDATE/DELETE are rejected by a trigger), `forecast_outcomes` and `data_health`.
- Every tick, per symbol and per horizon in Settings JSON key `forecastHorizonsMin` (default 60 and 240 minutes, must be multiples of the candle length), the engine logs one forecast for the newest closed candle: UP, DOWN or NO_SIGNAL. The current rule (`range_breakout_v1`) has **no calibrated probabilities** (they are stored as null) and **no measured edge**; step 5 of the plan adds a probability model that must beat baselines out of sample.
- Target: return% from the forecast's reference close to the close at issued time + horizon. UP/DOWN if the move exceeds the larger of round-trip cost (2 x (fee + slippage)) and `minMovePct`; otherwise SIDEWAYS. Outcomes use only candles that closed by the horizon end; a missing end candle becomes UNRESOLVABLE after 6 hours, never a guess.
- Data gate: stale, gapped, duplicated, malformed or jumpy candles block detection, breakout scans and forecasts for that symbol. Holes of up to 3 candles are treated as no-trade minutes (Coinbase omits empty candles) and filled flat; more than 25% quiet candles in the window, or a hole longer than 3, is a fault. Freshness limit is the larger of 2 candles + 1 min and 6 min. A Telegram message is sent only after 3 consecutive bad ticks, and a recovery message only if a problem message was sent (needs `sql/005_health_debounce.sql`).
- Not yet done: backtest/eval command, probability model, alert outbox with retries and cooldown, a Settings-page field for horizons.

## Evaluation: does the rule have an edge? (`npm run eval`)
```
npm run eval -- --symbols BTC-USD,ETH-USD,SOL-USD --days 60          # development walk-forward (holdout untouched)
npm run eval -- --csv-dir ./my-candles --symbols BTC-USD              # CSV files named SYMBOL.csv, columns t,o,h,l,c,v
npm run eval -- --final                                               # score the locked holdout (once)
```
Options: `--tf 5 --horizons 60,240 --fee 0.1 --slip 0.05 --delay 1 --min-trades 100 --folds 4 --holdout 0.2 --alpha 0.05`. Public candles are cached in `eval/cache`; reports go to `eval/out/latest.json`.
- **Signals** are generated causally with the same range/breakout code as the live engine, with fixed parameters (nothing is tuned on the data).
- **Target** is the live one: cost-aware UP / DOWN / SIDEWAYS at the horizon (threshold = max(round-trip cost, `--min-move`)).
- **Walk-forward**: expanding training blocks, chronological test blocks, training labels purged so none overlap a test block. Samples spanning a data gap are dropped.
- **Holdout lock**: the first run writes `eval/holdout.lock.json` (latest 20% of history, fixed from then on; commit it). Development numbers never use it. `--final` scores it once; a second scoring needs `--accept-reuse` and is logged.
- **Trades** pay fee + slippage on both sides, enter after `--delay` candles, never overlap. Baselines: momentum, always-long at the rule's timing, buy-and-hold, majority class, and train-frequency/uniform probabilities (Brier, log loss).
- **Verdict**: needs `--min-trades` pooled trades, a day-clustered bootstrap lower bound above 0 (Bonferroni across horizons), and a better mean than the momentum and same-timing baselines. Otherwise it prints NO EDGE DEMONSTRATED or INSUFFICIENT DATA.
- **Limitations**: the rule outputs no probabilities yet, so calibration is not reported for it; spot candles only (no spread data, no funding, no order-book depth); fixed slippage and fee; one provider; 60 days is a short window and regimes change; the rule tested is the tight-range mode (swing mode is not simulated); passing is evidence, not a guarantee. The unit tests use synthetic series only, so they prove the harness works, not that any market is beatable.

## Files
- `lib/range.ts`, `lib/paper.ts`, `lib/config.ts`: pure logic, tested with `npm test` (`node --experimental-strip-types`).
- `lib/engine.ts`: one tick (detect, confirm, exits, entries, snapshot). `app/api/tick` is the cron target.
- `lib/portfolio.ts`: dashboard data. `app/portfolio`, `app/alerts`, `app/settings`: mobile UI.

## Verification status (honest)
- Pure-logic tests pass in the sandbox. `npm install`, `next build`, the real Neon queries and live Coinbase/Binance calls have NOT run anywhere yet; expect to fix small issues on the first deploy.
- Largest drawdown comes from equity snapshots (every tick while positions are open, else every 15 min).
- Hobby functions cap at 10s; `/api/tick` makes parallel public-data calls with 3.5s timeouts. Keep the watchlist small.
- Provider candle endpoints (Coinbase Exchange, data-api.binance.vision) are public but unverified against live data here.

## Retest-zone strategy: replay backtest (research only)

Detects HTF (1h) support/resistance zones from observed pivots, counts completed bounces and breaks, and requires a closed 5m rejection candle before a setup exists. No chasing, stop beyond the zone, and a net R:R check after costs. It never places orders.

```
npm run eval -- --strategy retest --symbols BTC-USD,ETH-USD,SOL-USD --days 90 \
  --taker <your taker %> --maker <your maker %> --slip <%> --spread <%> --funding <% per trade, perps>
# final, once, on the locked holdout:
npm run eval -- --strategy retest --final --taker ... 
```

- **Fees default to PLACEHOLDERS (taker 0.1%).** They are not your real fees. Get your tier from your exchange's fee page and pass them in; the CLI warns if you don't.
- Arms of 0/1/2/3 prior bounces are compared; the primary arm (2) is declared in advance. Two bounces are a hypothesis being tested, not a guarantee.
- The verdict is one of INSUFFICIENT DATA / NO EDGE DEMONSTRATED / POSITIVE BUT NOT BETTER THAN A COIN-FLIP DIRECTION / PASSES ON THIS SAMPLE (needs 100+ primary trades).
- Tested only on synthetic data (random walks lose to costs, as they should). No real-market result exists yet; run the command with network access. Not financial advice.

## Live mode is now retest-zone (the range rule is gone)

The engine no longer looks for tight ranges or swing patterns. Every tick (1 minute) it, per symbol:
1. Fetches 5m and 1h candles and runs the data-quality gate on both. Bad or stale data means no setup and a debounced health alert, never a normal-looking signal.
2. Builds support/resistance zones from 1h (or 4h, resampled) swing pivots and counts completed bounces and breaks.
3. Looks only at the newest closed 5m candle for a confirmed rejection that passes the no-chase, stop-distance and net reward-to-risk checks after costs.
4. If it fires, writes one row to `retest_setups` (unique per symbol, direction and candle, plus a per-zone cooldown), sends one Telegram message, and logs a forecast. No setup is the normal outcome and sends nothing.
5. Paper entry (market order, taker) is re-checked against the live price: late entry, chasing, price through the stop, net R:R at the live price, daily loss limit, max positions. Size is set so a stop-out loses `riskPct` of equity including costs, capped by virtual cash.

**Deploy steps:** run `sql/006_retest_setups.sql` in your database (after 004 and 005), push, let Vercel deploy, set cron-job.org to every 1 minute, then open Settings: set the cron interval to 1, enter your real taker/maker fees and tick "I have entered my real fees", and set your own risk per trade and daily loss limit and tick "I chose these risk values". The shipped 1% and 3% are placeholders, not a recommendation: until risk is confirmed, alerts still send but no paper entry opens. Until fees are confirmed every alert says they are placeholders. Old saved range settings are ignored.

**Not simulated yet:** margin, leverage and liquidation (paper accounting is spot-style), and live funding rates (a flat per-8h rate you enter is charged by hold time). Live execution does not exist and will not be added without your explicit approval.

**Verification status:** unit tests, a typecheck, and the SQL (migrations plus the insert/update statements, run on a local Postgres) pass. The engine has not run against real exchange data, Neon, or the deployed app. The legacy `npm run eval` forecast harness still tests the old range rule and is kept only for comparison; use `--strategy retest` for this strategy.
