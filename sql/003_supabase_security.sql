-- SUPABASE ONLY: run once after 001. Safe to re-run.
-- Supabase exposes public tables through its REST API using a public "anon" key. This app never uses that API
-- (it connects with DATABASE_URL), so lock it out: with row level security on and no policies, the API sees nothing.
-- The direct database connection used by this app is not affected.
alter table app_settings enable row level security;
alter table engine_state enable row level security;
alter table range_alerts enable row level security;
alter table paper_trades enable row level security;
alter table equity_snapshots enable row level security;
