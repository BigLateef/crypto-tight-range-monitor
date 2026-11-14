-- Forecast ledger + outcomes + data health. Run once in the Neon/Supabase SQL editor. Safe to re-run.
-- A forecast row is APPEND-ONLY: a trigger rejects UPDATE and DELETE, so a past prediction can never be edited
-- after the market moves. What actually happened is stored separately in forecast_outcomes.
-- Research/paper only: nothing here stores keys, wallets or orders.

create table if not exists forecasts (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  symbol text not null,
  timeframe_min int not null,
  horizon_min int not null,
  issued_t bigint not null,            -- ms: close time of the newest closed candle the forecast used
  model text not null,                 -- e.g. range_breakout_v1
  direction text not null check (direction in ('UP','DOWN','SIDEWAYS','NO_SIGNAL')),
  p_up numeric check (p_up between 0 and 1),
  p_down numeric check (p_down between 0 and 1),
  p_sideways numeric check (p_sideways between 0 and 1),
  ref_price numeric not null,          -- close of that candle: the price the outcome is measured from
  data_age_sec int not null,           -- freshness: seconds between that close and the moment of the forecast
  invalidation_price numeric,          -- objective level that voids the call, when one exists
  cost_pct numeric not null,           -- round-trip cost (fees + slippage) in force when issued
  features jsonb not null default '{}'::jsonb,
  evidence text not null default ''
);
create unique index if not exists forecasts_uniq on forecasts (symbol, timeframe_min, horizon_min, model, issued_t);
create index if not exists forecasts_due on forecasts (issued_t);

create or replace function forecasts_append_only() returns trigger as $$
begin
  raise exception 'forecasts is append-only (% not allowed)', tg_op;
end;
$$ language plpgsql;

drop trigger if exists forecasts_no_update on forecasts;
create trigger forecasts_no_update before update or delete on forecasts
  for each row execute function forecasts_append_only();

create table if not exists forecast_outcomes (
  forecast_id bigint primary key references forecasts(id),
  resolved_at timestamptz not null default now(),
  end_t bigint,                        -- ms: close time of the candle used as the horizon-end price
  end_price numeric,
  return_pct numeric,
  actual text not null check (actual in ('UP','DOWN','SIDEWAYS','UNRESOLVABLE')),
  threshold_pct numeric                -- the move size that separated UP/DOWN from SIDEWAYS
);

create table if not exists data_health (
  symbol text not null,
  timeframe_min int not null,
  ok boolean not null,
  reasons text not null default '',
  updated_at timestamptz not null default now(),
  primary key (symbol, timeframe_min)
);
