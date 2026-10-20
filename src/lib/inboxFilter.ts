/**
 * Main-inbox rule: which cached emails stay out of the smart "Inbox" view.
 *
 * KEY-INBOX-1: marketing kept leaking in. A new row is cached with
 * is_important NULL and the AI verdict lands ~1s later, but the open Inbox
 * never saw it and fell back to Gmail's labels, which miss most marketing
 * (ChatGPT, CRM alerts land in Primary). So:
 *   - a fresh unclassified row is hidden while its verdict is pending;
 *   - the Inbox patches rows live from the `keyring:inbox-classified` event.
 * Only a row still unclassified after the grace window (AI off, no key, API
 * failure) falls back to the Gmail-label heuristic.
 */

/** Gmail categories we consider "noise": promotions, social, forums, spam. */
export const NOISE_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'SPAM'])

/** How long a new row may wait for its AI verdict before the heuristic decides. */
export const CLASSIFY_GRACE_MS = 2 * 60 * 1000

export interface MainInboxInput {
  isImportant: boolean | null
  createdAt: string
  labelIds: string[] | null
  is2fa: boolean
  isSpamSender: boolean
  aiEnabled: boolean
  now: number
}

export function hiddenFromMainInbox(i: MainInboxInput): boolean {
  if (i.is2fa) return false
  if (i.isSpamSender) return true
  if (i.aiEnabled) {
    if (i.isImportant !== null) return i.isImportant !== true
    const age = i.now - new Date(i.createdAt).getTime()
    if (age < CLASSIFY_GRACE_MS) return true
  }
  if (!i.labelIds) return false
  return i.labelIds.some((l) => NOISE_LABELS.has(l))
}

/** Window event fired after an AI verdict is saved (same window only). */
export const CLASSIFIED_EVENT = 'keyring:inbox-classified'

export interface ClassifiedDetail {
  id: string
  important: boolean
  reason: string | null
  classifiedAt: string
}
