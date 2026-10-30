-- Crypto Tight Range Monitor: range alerts + paper portfolio. Run once in the Neon SQL editor. Safe to re-run.
-- SIMULATION ONLY: nothing in this schema stores exchange keys, wallets or real orders.

create table if not exists app_settings (
  id int primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into app_settings (id) values (1) on conflict do nothing;

create table if not exists engine_state (
  id int primary key default 1 check (id = 1),
  lease_until timestamptz not null default 'epoch',
  last_tick_at timestamptz,
  last_tick_ok boolean,
  last_tick_note text
);
insert into engine_state (id) values (1) on conflict do nothing;

create table if not exists range_alerts (
  id bigserial primary key,
  symbol text not null,
  timeframe_min int not null,
  range_high numeric not null,
  range_low numeric not null,
  width_pct numeric not null,
  touches_high int not null,
  touches_low int not null,
  window_candles int not null,
  window_start_t bigint not null,
  window_end_t bigint not null,
  detected_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active','broken','expired')),
  breakout_direction text check (breakout_direction in ('up','down')),
  breakout_confirm_t bigint,
  breakout_close numeric,
  broken_at timestamptz,
  paper_state text not null default 'none',
  paper_note text,
  trade_id bigint
);
create unique index if not exists range_alerts_uniq on range_alerts (symbol, timeframe_min, window_end_t);
create index if not exists range_alerts_status on range_alerts (status, paper_state);

create table if not exists paper_trades (
  id bigserial primary key,
  alert_id bigint references range_alerts(id) on delete set null,
  symbol text not null,
  direction text not null check (direction in ('long','short')),
  status text not null default 'open' check (status in ('open','closed')),
  units numeric not null,
  notional numeric not null,
  ref_entry_price numeric not null,
  entry_price numeric not null,
  entry_slippage_usd numeric not null,
  entry_fee numeric not null,
  stop_price numeric,
  initial_stop_price numeric,
  target_price numeric,
  lock_trigger_price numeric,
  lock_stop_price numeric,
  stop_locked boolean not null default false,
  locked_at timestamptz,
  max_hold_minutes int not null default 0,
  opened_at timestamptz not null default now(),
  checked_through bigint not null,
  last_price numeric,
  last_price_at timestamptz,
  ref_exit_price numeric,
  exit_price numeric,
  exit_slippage_usd numeric,
  exit_fee numeric,
  closed_at timestamptz,
  exit_reason text,
  gross_pnl numeric,
  realized_pnl numeric
);
create index if not exists paper_trades_status on paper_trades (status, closed_at);

create table if not exists equity_snapshots (
  ts timestamptz primary key default now(),
  equity numeric not null
);
