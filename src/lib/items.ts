import { supabase } from './supabase'
import { decryptJson, encryptJson } from './encryption'

export type VisibilityTier = 'low' | 'medium' | 'high'

export type ItemType = 'login' | 'api_key' | 'note' | 'other'

export interface VaultItemRow {
  id: string
  user_id: string
  type: ItemType | string
  title: string
  folder: string | null
  tags: string[]
  visibility_tier: VisibilityTier
  encrypted_data: string
  iv: string
  url: string | null
  username_hint: string | null
  created_at: string
  updated_at: string
  last_accessed_at: string | null
}

/**
 * Decrypted secret payload. Free-form key/value so any item type can store
 * whatever fields it needs without a schema change.
 *
 * Convention by type:
 *   login   → { username, password, notes? }
 *   api_key → { key, project?, notes? }
 *   note    → { body }
 *   other   → arbitrary keys
 */
export type SecretFields = Record<string, string>

export interface DecryptedItem extends Omit<VaultItemRow, 'encrypted_data' | 'iv'> {
  fields: SecretFields
}

export async function listItems(): Promise<VaultItemRow[]> {
  const { data, error } = await supabase
    .from('vault_items')
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as VaultItemRow[]
}

export async function getItem(id: string): Promise<VaultItemRow | null> {
  const { data, error } = await supabase
    .from('vault_items')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data as VaultItemRow | null
}

export async function decryptItem(
  row: VaultItemRow,
  dek: Uint8Array,
): Promise<DecryptedItem> {
  const fields = await decryptJson<SecretFields>(row.encrypted_data, row.iv, dek)
  // strip ciphertext from the returned object
  const { encrypted_data: _ed, iv: _iv, ...rest } = row
  void _ed
  void _iv
  return { ...rest, fields }
}

export interface CreateItemInput {
  type: ItemType | string
  title: string
  folder?: string | null
  tags?: string[]
  visibility_tier: VisibilityTier
  url?: string | null
  username_hint?: string | null
  fields: SecretFields
}

export async function createItem(
  userId: string,
  input: CreateItemInput,
  dek: Uint8Array,
): Promise<VaultItemRow> {
  const { ciphertext, iv } = await encryptJson(input.fields, dek)
  const { data, error } = await supabase
    .from('vault_items')
    .insert({
      user_id: userId,
      type: input.type,
      title: input.title,
      folder: input.folder ?? null,
      tags: input.tags ?? [],
      visibility_tier: input.visibility_tier,
      encrypted_data: ciphertext,
      iv,
      url: input.url ?? null,
      username_hint: input.username_hint ?? null,
    })
    .select('*')
    .single()
  if (error) throw error
  return data as VaultItemRow
}

export async function deleteItem(id: string): Promise<void> {
  const { error } = await supabase.from('vault_items').delete().eq('id', id)
  if (error) throw error
}

export async function touchLastAccessed(id: string): Promise<void> {
  await supabase
    .from('vault_items')
    .update({ last_accessed_at: new Date().toISOString() })
    .eq('id', id)
}
