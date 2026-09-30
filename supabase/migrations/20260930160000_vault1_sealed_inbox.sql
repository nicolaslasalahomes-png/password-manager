-- VAULT-1 (30 Sep 2026): a sealed inbox for the lists Claude keeps for Nicolas (his Needs-you
-- list), read by the app and folded into the daily brief.
--
-- Zero-knowledge is kept: the server only ever holds
--   * vault_inbox_keys: the vault's inbox PUBLIC key, and its private key AES-GCM-encrypted
--     under the vault DEK (the server cannot use it);
--   * vault_inbox: one sealed, signed, padded envelope per source, replaced on every push.
-- Writes to vault_inbox come ONLY from the keyring-inbox-put edge function (service role),
-- which checks its own write secret and the writer's signature. The owner can read; nobody
-- else can do anything. anon gets nothing.

create table public.vault_inbox_keys (
  user_id uuid primary key references auth.users (id) on delete cascade,
  public_key_jwk jsonb not null check (public_key_jwk ->> 'kty' = 'EC' and public_key_jwk ->> 'crv' = 'P-256' and public_key_jwk ? 'x' and public_key_jwk ? 'y' and not public_key_jwk ? 'd'),
  encrypted_private_key text not null,
  iv text not null,
  created_at timestamptz not null default now()
);

create table public.vault_inbox (
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null check (source ~ '^[a-z_]{1,32}$'),
  envelope text not null check (length(envelope) <= 200000),
  updated_at timestamptz not null default now(),
  primary key (user_id, source)
);

alter table public.vault_inbox_keys enable row level security;
alter table public.vault_inbox enable row level security;

revoke all on public.vault_inbox_keys from public, anon, authenticated;
revoke all on public.vault_inbox from public, anon, authenticated;

-- The owner reads their key row and creates it once. No update and no delete from the app:
-- a replaced public key would redirect every future list, so that stays an admin act.
grant select, insert on public.vault_inbox_keys to authenticated;
create policy "inbox key: owner reads" on public.vault_inbox_keys
  for select to authenticated using (auth.uid() = user_id);
create policy "inbox key: owner creates" on public.vault_inbox_keys
  for insert to authenticated with check (auth.uid() = user_id);

-- The owner reads their envelopes. Writes only through the edge function (service role).
grant select on public.vault_inbox to authenticated;
create policy "inbox: owner reads" on public.vault_inbox
  for select to authenticated using (auth.uid() = user_id);
