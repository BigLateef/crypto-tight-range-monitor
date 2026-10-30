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

## Files
- `lib/range.ts`, `lib/paper.ts`, `lib/config.ts`: pure logic, tested with `npm test` (`node --experimental-strip-types`).
- `lib/engine.ts`: one tick (detect, confirm, exits, entries, snapshot). `app/api/tick` is the cron target.
- `lib/portfolio.ts`: dashboard data. `app/portfolio`, `app/alerts`, `app/settings`: mobile UI.

## Verification status (honest)
- Pure-logic tests pass in the sandbox. `npm install`, `next build`, the real Neon queries and live Coinbase/Binance calls have NOT run anywhere yet; expect to fix small issues on the first deploy.
- Largest drawdown comes from equity snapshots (every tick while positions are open, else every 15 min).
- Hobby functions cap at 10s; `/api/tick` makes parallel public-data calls with 3.5s timeouts. Keep the watchlist small.
- Provider candle endpoints (Coinbase Exchange, data-api.binance.vision) are public but unverified against live data here.
