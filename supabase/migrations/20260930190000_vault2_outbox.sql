-- VAULT-2 (30 Sep 2026): Nicolas's replies from the Needs-you card, sealed to the reader on his Mac.
--
-- The server holds: the sealed reply (only the reader's private key, Mac-only, can open it), his own
-- copy of the text encrypted under his vault DEK (so the card can show what he sent), and plaintext
-- list_no + item_id (not secret; they say which card item a reply is for). Private by default:
--   * authenticated: INSERT own rows (only the listed columns: never created_at or fetched_at) and
--     SELECT own rows. No UPDATE, no DELETE.
--   * anon: nothing.
--   * The reader reads through keyring-outbox-get (service key, its own secret) and marks rows fetched.

create table public.vault_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  list_no integer not null check (list_no >= 0),
  item_id text not null check (item_id ~ '^N[0-9]{1,4}[a-z]?$'),
  envelope text not null check (length(envelope) <= 20000),
  own_copy text not null check (length(own_copy) <= 20000),
  own_iv text not null,
  fetched_at timestamptz
);
create index vault_outbox_unfetched on public.vault_outbox (created_at) where fetched_at is null;
create index vault_outbox_user_item on public.vault_outbox (user_id, item_id, created_at desc);

alter table public.vault_outbox enable row level security;
revoke all on public.vault_outbox from public, anon, authenticated;

grant select on public.vault_outbox to authenticated;
grant insert (user_id, list_no, item_id, envelope, own_copy, own_iv) on public.vault_outbox to authenticated;

create policy "outbox: owner reads" on public.vault_outbox
  for select to authenticated using (auth.uid() = user_id);
create policy "outbox: owner sends" on public.vault_outbox
  for insert to authenticated with check (auth.uid() = user_id);

insert into supabase_migrations.schema_migrations (version, name)
values ('20260930190000', 'vault2_outbox')
on conflict (version) do nothing;
