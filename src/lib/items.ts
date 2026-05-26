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

/** Distinct folder names used by the current user's items. */
export async function listFolders(): Promise<string[]> {
  const { data, error } = await supabase
    .from('vault_items')
    .select('folder')
    .not('folder', 'is', null)
  if (error) throw error
  const set = new Set<string>()
  for (const row of (data ?? []) as { folder: string | null }[]) {
    if (row.folder) set.add(row.folder)
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b))
}

export interface BulkImportItem {
  type: ItemType | string
  title: string
  folder?: string | null
  tags?: string[]
  visibility_tier?: VisibilityTier
  url?: string | null
  username_hint?: string | null
  fields: SecretFields
}

export interface BulkImportFile {
  version: 1
  items: BulkImportItem[]
}

export function validateImport(
  raw: unknown,
): { ok: true; file: BulkImportFile } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Root must be a JSON object' }
  const r = raw as Record<string, unknown>
  if (r.version !== 1) return { ok: false, error: `Unsupported version: ${String(r.version)}. Expected 1.` }
  if (!Array.isArray(r.items)) return { ok: false, error: '`items` must be an array' }
  const items: BulkImportItem[] = []
  for (let i = 0; i < r.items.length; i++) {
    const it = r.items[i] as Record<string, unknown>
    if (!it || typeof it !== 'object') return { ok: false, error: `items[${i}] is not an object` }
    if (typeof it.title !== 'string' || !it.title.trim()) return { ok: false, error: `items[${i}].title is required` }
    if (typeof it.type !== 'string') return { ok: false, error: `items[${i}].type is required` }
    if (!it.fields || typeof it.fields !== 'object') return { ok: false, error: `items[${i}].fields must be an object` }
    const tier = (it.visibility_tier ?? 'medium') as VisibilityTier
    if (!['low', 'medium', 'high'].includes(tier)) {
      return { ok: false, error: `items[${i}].visibility_tier must be low|medium|high` }
    }
    const fields: SecretFields = {}
    for (const [k, v] of Object.entries(it.fields as Record<string, unknown>)) {
      if (typeof v !== 'string') return { ok: false, error: `items[${i}].fields["${k}"] must be a string` }
      fields[k] = v
    }
    items.push({
      type: it.type,
      title: it.title.trim(),
      folder: typeof it.folder === 'string' && it.folder.trim() ? it.folder.trim() : null,
      tags: Array.isArray(it.tags) ? it.tags.filter((t): t is string => typeof t === 'string') : [],
      visibility_tier: tier,
      url: typeof it.url === 'string' && it.url.trim() ? it.url.trim() : null,
      username_hint: typeof it.username_hint === 'string' ? it.username_hint : null,
      fields,
    })
  }
  return { ok: true, file: { version: 1, items } }
}
