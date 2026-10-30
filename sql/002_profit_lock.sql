-- Profit lock columns. Run once in the Neon SQL editor if you already ran 001 before this update. Safe to re-run.
alter table paper_trades add column if not exists initial_stop_price numeric;
alter table paper_trades add column if not exists lock_trigger_price numeric;
alter table paper_trades add column if not exists lock_stop_price numeric;
alter table paper_trades add column if not exists stop_locked boolean not null default false;
alter table paper_trades add column if not exists locked_at timestamptz;
