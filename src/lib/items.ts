import { supabase } from './supabase'
import { decryptJson, encryptJson } from './encryption'

export type VisibilityTier = 'low' | 'medium' | 'high'

export type ItemType = 'login' | 'api_key' | 'note' | 'other' | 'task'

export type Priority = 'low' | 'medium' | 'high'

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
  /** Set on tasks (notes-with-deadlines). Plaintext for cheap calendar/to-do queries. */
  due_at: string | null
  priority: Priority | null
  completed_at: string | null
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

/**
 * The two in-memory keys for an unlocked vault.
 *   - `dek`     encrypts low + medium tier items.
 *   - `highDek` encrypts high tier items only. `null` in a Touch ID (standard)
 *               session — high-tier items stay cryptographically locked until
 *               the master password is entered ("elevation").
 */
export interface VaultKeys {
  dek: Uint8Array
  highDek: Uint8Array | null
}

/**
 * Thrown when a high-tier item is encrypted/decrypted but `highDek` isn't in
 * memory (a Touch ID session before elevation). Callers catch this to trigger
 * the master-password elevation prompt.
 */
export class HighTierLockedError extends Error {
  constructor(message = 'High-tier items require your master password — unlock fully, not just with Touch ID.') {
    super(message)
    this.name = 'HighTierLockedError'
  }
}

/**
 * Which key protects an item of the given tier. Deterministic from the tier,
 * so we never store a per-row key id. Throws {@link HighTierLockedError} when a
 * high-tier item is requested but `highDek` isn't available.
 */
export function keyForTier(tier: VisibilityTier, keys: VaultKeys): Uint8Array {
  if (tier === 'high') {
    if (!keys.highDek) throw new HighTierLockedError()
    return keys.highDek
  }
  return keys.dek
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
  keys: VaultKeys,
): Promise<DecryptedItem> {
  // strip ciphertext from the returned object
  const { encrypted_data: _ed, iv: _iv, ...rest } = row
  void _ed
  void _iv

  if (row.visibility_tier === 'high') {
    // High-tier needs highDek. Under a Touch ID (standard) session it's null,
    // so the item stays cryptographically locked until elevation.
    if (!keys.highDek) throw new HighTierLockedError()
    try {
      const fields = await decryptJson<SecretFields>(row.encrypted_data, row.iv, keys.highDek)
      return { ...rest, fields }
    } catch {
      // Legacy high-tier item — encrypted with the single `dek` before the
      // two-key split. Decrypt with `dek`, then lazily re-encrypt under
      // `highDek` and persist. Idempotent; a failed write just retries on the
      // next access, so an interrupted migration self-heals.
      const fields = await decryptJson<SecretFields>(row.encrypted_data, row.iv, keys.dek)
      try {
        const { ciphertext, iv } = await encryptJson(fields, keys.highDek)
        await supabase
          .from('vault_items')
          .update({ encrypted_data: ciphertext, iv })
          .eq('id', row.id)
      } catch (migErr) {
        console.warn('[vault] lazy high-tier migration deferred (will retry):', migErr)
      }
      return { ...rest, fields }
    }
  }

  const fields = await decryptJson<SecretFields>(row.encrypted_data, row.iv, keys.dek)
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
  due_at?: string | null
  priority?: Priority | null
}

export async function createItem(
  userId: string,
  input: CreateItemInput,
  keys: VaultKeys,
): Promise<VaultItemRow> {
  const key = keyForTier(input.visibility_tier, keys)
  const { ciphertext, iv } = await encryptJson(input.fields, key)
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
      due_at: input.due_at ?? null,
      priority: input.priority ?? null,
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

export interface UpdateItemInput {
  type?: ItemType | string
  title?: string
  folder?: string | null
  tags?: string[]
  visibility_tier?: VisibilityTier
  url?: string | null
  username_hint?: string | null
  /** Pass to replace the encrypted payload entirely. Re-encrypted with a fresh IV. */
  fields?: SecretFields
  due_at?: string | null
  priority?: Priority | null
  completed_at?: string | null
}

/**
 * Update one or more attributes of an item. Pass `fields` to replace the
 * full decrypted payload (re-encrypted with a fresh IV before write). Pass
 * any of the plaintext columns to update them directly. Other columns are
 * left as-is.
 */
export async function updateItem(
  id: string,
  patch: UpdateItemInput,
  keys: VaultKeys,
): Promise<VaultItemRow> {
  // Build the update payload only with the columns the caller actually
  // wants to change — Supabase will leave unspecified columns untouched.
  const update: Record<string, unknown> = {}
  if (patch.type !== undefined) update.type = patch.type
  if (patch.title !== undefined) update.title = patch.title
  if (patch.folder !== undefined) update.folder = patch.folder
  if (patch.tags !== undefined) update.tags = patch.tags
  if (patch.visibility_tier !== undefined) update.visibility_tier = patch.visibility_tier
  if (patch.url !== undefined) update.url = patch.url
  if (patch.username_hint !== undefined) update.username_hint = patch.username_hint
  if (patch.due_at !== undefined) update.due_at = patch.due_at
  if (patch.priority !== undefined) update.priority = patch.priority
  if (patch.completed_at !== undefined) update.completed_at = patch.completed_at

  if (patch.fields !== undefined) {
    // The fields are re-encrypted under the key for the item's *effective*
    // tier. If the patch changes the tier, use the new one; otherwise look up
    // the stored tier so we never wrap high-tier data with the low/medium key.
    let effectiveTier = patch.visibility_tier
    if (effectiveTier === undefined) {
      const { data: current, error: fetchErr } = await supabase
        .from('vault_items')
        .select('visibility_tier')
        .eq('id', id)
        .single()
      if (fetchErr) throw fetchErr
      effectiveTier = (current as { visibility_tier: VisibilityTier }).visibility_tier
    }
    const key = keyForTier(effectiveTier, keys)
    const { ciphertext, iv } = await encryptJson(patch.fields, key)
    update.encrypted_data = ciphertext
    update.iv = iv
  }

  const { data, error } = await supabase
    .from('vault_items')
    .update(update)
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw error
  return data as VaultItemRow
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
