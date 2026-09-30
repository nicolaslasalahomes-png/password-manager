-- KEY-PERF-1 (2026-09-30): small encrypted header next to each cached email so
-- the inbox list never has to select encrypted_payload (~48 KB avg; 1,000 of
-- them per inbox open timed out and took the nano database down).
-- Nullable, no default: metadata-only, instant. Rows written before this are
-- backfilled by the client (it holds the DEK); zero-knowledge is unchanged.
-- Applied to wwylhsetxpopxmtupfhn at 2026-09-30 13:32 UTC via the Management API.
begin;
set local lock_timeout = '5s';
alter table public.email_message_cache
  add column if not exists encrypted_header text,
  add column if not exists iv_header text;
commit;
