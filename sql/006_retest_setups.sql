-- Retest-zone strategy: setup ledger. Run once after 005 in the Neon/Supabase SQL editor. Safe to re-run.
-- SIMULATION ONLY. The old range_alerts table is kept as history; nothing new is written to it.

create table if not exists retest_setups (
  id bigserial primary key,
  symbol text not null,
  trigger_tf_min int not null,
  zone_tf_min int not null,
  dir text not null check (dir in ('long','short')),
  trigger_t bigint not null,          -- open time of the confirming candle
  close_t bigint not null,            -- when it closed = earliest moment the setup was knowable
  ref_price numeric not null,
  zone_low numeric not null,
  zone_high numeric not null,
  prior_bounces int not null,
  stop_price numeric not null,
  target_price numeric not null,
  stop_pct numeric not null,
  target_pct numeric not null,
  net_rr numeric not null,
  break_even_win_rate numeric not null,
  invalidation_price numeric not null,
  evidence text not null,
  costs jsonb not null,               -- the exact cost assumptions used, so the row can be audited later
  costs_confirmed boolean not null default false,
  detected_at timestamptz not null default now(),
  paper_state text not null default 'pending',
  paper_note text,
  trade_id bigint
);
-- one setup per symbol/direction/confirming candle: a repeat tick or a retried cron can never duplicate it
create unique index if not exists retest_setups_uniq on retest_setups (symbol, trigger_tf_min, dir, trigger_t);
create index if not exists retest_setups_recent on retest_setups (symbol, close_t desc);

alter table paper_trades drop constraint if exists paper_trades_alert_id_fkey;
alter table paper_trades add column if not exists setup_id bigint;
alter table paper_trades add column if not exists funding_usd numeric not null default 0;
alter table paper_trades add column if not exists exit_fill text;  -- 'market' or 'limit' (maker target)

alter table retest_setups enable row level security; -- no-op on plain Postgres policy-wise; locks the Supabase REST API out
