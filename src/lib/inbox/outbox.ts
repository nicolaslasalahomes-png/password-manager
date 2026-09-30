/**
 * VAULT-2: sending his replies, and showing what he has sent.
 *
 * Each row holds the sealed reply (only the reader on his Mac can open it) plus his own copy of the
 * text encrypted under the vault DEK, so the card can show "Sent 15:42: <his words>" on any of his
 * devices while the server still sees nothing. list_no and item_id are plaintext: not secret, and
 * needed to know which item a reply belongs to.
 */
import { supabase } from '../supabase'
import { decryptJson, encryptJson } from '../encryption'
import { READER_PUBLIC_JWK } from './readerKey'
import { sealReply } from './reply'

export interface SentReply {
  id: string
  list_no: number
  item_id: string
  created_at: string
  text: string
}

export async function sendReply(args: {
  userId: string
  dek: Uint8Array
  listNo: number
  itemId: string
  title: string
  text: string
}): Promise<SentReply> {
  const text = args.text.trim()
  const sent_at = new Date().toISOString()
  const envelope = await sealReply(
    { v: 1, list_no: args.listNo, item_id: args.itemId, title: args.title, text, sent_at },
    READER_PUBLIC_JWK,
  )
  const own = await encryptJson(text, args.dek)
  const { data, error } = await supabase
    .from('vault_outbox')
    .insert({
      user_id: args.userId,
      list_no: args.listNo,
      item_id: args.itemId,
      envelope: JSON.stringify(envelope),
      own_copy: own.ciphertext,
      own_iv: own.iv,
    })
    .select('id, list_no, item_id, created_at')
    .single()
  if (error) throw error
  const row = data as Omit<SentReply, 'text'>
  return { ...row, text }
}

/** His latest reply per item for these IDs (a later reply supersedes an earlier one). */
export async function latestReplies(dek: Uint8Array, itemIds: string[]): Promise<Record<string, SentReply>> {
  if (!itemIds.length) return {}
  const { data, error } = await supabase
    .from('vault_outbox')
    .select('id, list_no, item_id, created_at, own_copy, own_iv')
    .in('item_id', itemIds)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) throw error
  const out: Record<string, SentReply> = {}
  for (const r of (data ?? []) as Array<Omit<SentReply, 'text'> & { own_copy: string; own_iv: string }>) {
    if (out[r.item_id]) continue
    try {
      out[r.item_id] = { id: r.id, list_no: r.list_no, item_id: r.item_id, created_at: r.created_at, text: await decryptJson<string>(r.own_copy, r.own_iv, dek) }
    } catch {
      /* not decryptable on this vault: skip */
    }
  }
  return out
}
