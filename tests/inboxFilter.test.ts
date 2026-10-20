import { describe, expect, it } from 'vitest'
import { CLASSIFY_GRACE_MS, hiddenFromMainInbox, type MainInboxInput } from '../src/lib/inboxFilter'

const now = Date.parse('2026-10-20T12:00:00Z')
const base: MainInboxInput = {
  isImportant: null,
  createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
  labelIds: ['INBOX', 'CATEGORY_PERSONAL'],
  is2fa: false,
  isSpamSender: false,
  aiEnabled: true,
  now,
}

describe('hiddenFromMainInbox', () => {
  it('hides AI "not important" mail even when Gmail filed it in Primary', () => {
    expect(hiddenFromMainInbox({ ...base, isImportant: false })).toBe(true)
  })

  it('shows AI "important" mail even when Gmail called it Promotions', () => {
    expect(hiddenFromMainInbox({ ...base, isImportant: true, labelIds: ['CATEGORY_PROMOTIONS'] })).toBe(false)
  })

  it('hides a fresh unclassified row while its verdict is pending', () => {
    const createdAt = new Date(now - 5_000).toISOString()
    expect(hiddenFromMainInbox({ ...base, createdAt })).toBe(true)
  })

  it('falls back to Gmail labels once the grace window passes', () => {
    const createdAt = new Date(now - CLASSIFY_GRACE_MS - 1).toISOString()
    expect(hiddenFromMainInbox({ ...base, createdAt })).toBe(false)
    expect(hiddenFromMainInbox({ ...base, createdAt, labelIds: ['CATEGORY_PROMOTIONS'] })).toBe(true)
  })

  it('uses Gmail labels only when AI is off', () => {
    const createdAt = new Date(now - 5_000).toISOString()
    expect(hiddenFromMainInbox({ ...base, aiEnabled: false, isImportant: false, createdAt })).toBe(false)
    expect(hiddenFromMainInbox({ ...base, aiEnabled: false, labelIds: ['CATEGORY_SOCIAL'] })).toBe(true)
  })

  it('always shows 2FA mail and always hides spam senders', () => {
    expect(hiddenFromMainInbox({ ...base, isImportant: false, is2fa: true })).toBe(false)
    expect(hiddenFromMainInbox({ ...base, isImportant: true, isSpamSender: true })).toBe(true)
  })
})
