-- SEC (30 Sep 2026, security by default): least privilege on the Keyring database.
--
-- Before: anon AND authenticated held ALL privileges (incl. TRUNCATE, TRIGGER, REFERENCES) on every
-- table, policies applied TO PUBLIC, and default privileges handed the same to every future object.
-- RLS was the only wall. After:
--   * anon: nothing on any table. Its one real pre-login caller, the daily keepalive on the Hetzner
--     server (it kept a GET on vault_items), gets public.keepalive() instead: select 1, no data.
--   * authenticated: only the verbs the web app, desktop app and extension use, per table.
--   * auth_2fa_codes: nobody but the service role (send-2fa-code / verify-2fa-code use it).
--   * policies scoped TO authenticated; functions not executable by PUBLIC/anon/authenticated;
--     default privileges for postgres-created objects give anon/authenticated nothing.
-- Callers checked: web + desktop + extension (supabase-js, signed in), the 2FA edge functions
-- (service role), keyring-inbox-put (service key), the Hetzner keepalive (anon). No pg_cron.

-- Tables: start from nothing.
revoke all on all tables in schema public from public, anon, authenticated;

grant select, insert, update, delete on public.vault_items         to authenticated;
grant select, insert, update         on public.vault_users         to authenticated;
grant select, insert                 on public.daily_briefings     to authenticated;
grant select, insert, update, delete on public.calendar_day_marks  to authenticated;
grant select, insert, update, delete on public.email_accounts      to authenticated;
grant select, insert, update, delete on public.email_message_cache to authenticated;
grant select                         on public.vault_inbox         to authenticated;
grant select, insert                 on public.vault_inbox_keys    to authenticated;
-- public.auth_2fa_codes: no grant. RLS on, no policy: service role only, by design.

-- Policies: owner-only as before, but for signed-in users only (they were TO PUBLIC).
alter policy "vault_items_own" on public.vault_items to authenticated;
alter policy "vault_users_own" on public.vault_users to authenticated;
alter policy "db owner select" on public.daily_briefings to authenticated;
alter policy "db owner insert" on public.daily_briefings to authenticated;
alter policy "db owner update" on public.daily_briefings to authenticated;
alter policy "db owner delete" on public.daily_briefings to authenticated;
alter policy "day_marks owner select" on public.calendar_day_marks to authenticated;
alter policy "day_marks owner insert" on public.calendar_day_marks to authenticated;
alter policy "day_marks owner update" on public.calendar_day_marks to authenticated;
alter policy "day_marks owner delete" on public.calendar_day_marks to authenticated;
alter policy "email_accounts owner select" on public.email_accounts to authenticated;
alter policy "email_accounts owner insert" on public.email_accounts to authenticated;
alter policy "email_accounts owner update" on public.email_accounts to authenticated;
alter policy "email_accounts owner delete" on public.email_accounts to authenticated;
alter policy "email_cache owner select" on public.email_message_cache to authenticated;
alter policy "email_cache owner insert" on public.email_message_cache to authenticated;
alter policy "email_cache owner update" on public.email_message_cache to authenticated;
alter policy "email_cache owner delete" on public.email_message_cache to authenticated;

-- Sequences (none today) and functions.
revoke all on all sequences in schema public from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
-- The updated_at trigger: EXECUTE is only checked when a trigger is created, so firing is unaffected.
alter function public.vault_items_touch_updated() set search_path = '';

-- The keepalive's replacement: one row of nothing, for anon only.
create or replace function public.keepalive()
  returns integer
  language sql
  stable
  security invoker
  set search_path = ''
as $$ select 1 $$;
revoke execute on function public.keepalive() from public, authenticated;
grant execute on function public.keepalive() to anon;

-- Future objects created by postgres give anon/authenticated nothing; grant per object instead.
alter default privileges for role postgres in schema public revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

-- Ledger (this project had none): record VAULT-1's migration and this one.
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);
revoke all on schema supabase_migrations from public, anon, authenticated;
insert into supabase_migrations.schema_migrations (version, name) values
  ('20260930160000', 'vault1_sealed_inbox'),
  ('20260930170000', 'sec_keyring_least_privilege')
on conflict (version) do nothing;
