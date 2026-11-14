-- Debounce for data-health alerts. Run once after 004. Safe to re-run.
alter table data_health add column if not exists bad_streak int not null default 0;
alter table data_health add column if not exists alerted boolean not null default false;
