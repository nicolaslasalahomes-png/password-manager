/**
 * 2FA / verification-code email detection.
 *
 * Pure function. Given subject / sender / snippet / body text, decide whether
 * this email looks like a 2FA / magic-link / verification email and, if so,
 * extract the code and/or link to surface in the popover.
 *
 * Heuristic design notes:
 * - Confidence-scored. A 2FA email usually has TWO of: known 2FA subject
 *   wording, known no-reply-style sender, a verification-code-shaped body.
 * - Threshold of 0.6 keeps the bar honest: a marketing email with the word
 *   "verify your account" doesn't trigger unless there's also a code-shaped
 *   number in the body or the sender looks like an auth sender.
 * - First-match-wins regex order for code extraction so contextual hits
 *   (e.g. "Your code is 123456") beat bare digit matches.
 */

export interface TwoFactorMatch {
  kind: 'code' | 'magic-link' | 'both'
  code?: string
  link?: string
  confidence: number
}

export interface DetectorInput {
  subject: string
  from: string
  snippet: string
  bodyText: string
  /** Raw HTML body — scanned for <a href> URLs (magic links live there, not in
   *  the stripped text). Optional; absent for legacy cache entries. */
  bodyHtml?: string
  /** Gmail labels on the message. We skip CATEGORY_PROMOTIONS hard. */
  labelIds?: string[]
}

export interface DetectorOptions {
  /** Lowercased sender addresses the user manually marked "always auth".
   *  These bypass the category/subject gates and get a confidence boost. */
  authSenders?: string[]
}

/** Threshold for "should we auto-popup this?". */
export const AUTO_POP_THRESHOLD = 0.6

// Subject / body keywords that strongly suggest a 2FA email.
const SUBJECT_KEYWORDS =
  /\b(verification|verify|security|sign[- ]?in|login|magic|confirm(?:ation)?|one[- ]?time|otp|2fa|two[- ]?factor|passcode|access\s+code|authenticate|authorization)\b/i

// STRONG auth-related local-part prefixes. `noreply@` / `no-reply@` are
// intentionally NOT here because every marketing email in existence uses them.
// Those are handled separately as a "weak hint" only.
const STRONG_SENDER_PREFIXES = [
  'security@',
  'accounts@',
  'verify@',
  'verification@',
  'auth@',
  'login@',
  'id@',
  'otp@',
]

// Generic prefixes that don't tell us much on their own — they're a weak hint
// that this is a transactional email but not enough to qualify as auth.
const WEAK_SENDER_PREFIXES = [
  'noreply@',
  'no-reply@',
  'noreply-',
  'no.reply@',
  'notifications@',
  'notify@',
  'support@',
]

// Hosts whose senders we trust as auth-shaped even without a known prefix.
const KNOWN_SERVICE_HOSTS = [
  'accounts.google.com',
  'google.com',
  'github.com',
  'apple.com',
  'icloud.com',
  'discord.com',
  'discordapp.com',
  'slack.com',
  'notion.so',
  'linear.app',
  'figma.com',
  'vercel.com',
  'supabase.com',
  'supabase.io',
  'cloudflare.com',
  'cloudflareaccess.com',
  'login.microsoftonline.com',
  'amazon.com',
  'amazonaws.com',
  'paypal.com',
  'stripe.com',
  'twitch.tv',
  'twitter.com',
  'x.com',
  'meta.com',
  'facebook.com',
  'instagram.com',
  'dropbox.com',
  'cursor.sh',
  'cursor.com',
  'anthropic.com',
  'openai.com',
  'chatgpt.com',
  'fly.io',
  'render.com',
  'netlify.com',
  // Dedicated auth/identity infra — these effectively only send transactional
  // verification mail, so trusting them as strong-auth senders is safe.
  // Consumer apps that ALSO market heavily (Revolut, PayPal, Epic, Steam…) are
  // deliberately NOT here — they'd reintroduce promo false-positives. They still
  // get detected via subject keyword + extracted code.
  'twilio.com',
  'okta.com',
  'auth0.com',
  'plaid.com',
  'duosecurity.com',
]

// Tracking / list-management domains to exclude from magic-link extraction.
const LINK_BLACKLIST_HOSTS = [
  'list-manage.com',
  'mailgun.org',
  'sendgrid.net',
  'mailchimp.com',
  'doubleclick.net',
  'click.linksynergy.com',
]

// Direct-code regexes (first match wins).
const CODE_PATTERNS: RegExp[] = [
  // "Your verification code is 123456" / "Code: 123456" / "Use 123456 to..."
  /(?:code|otp|pin|token|passcode)[^\d]{0,15}(\d{4,8})\b/i,
  // "123456 is your verification code" / "123456 to sign in"
  /\b(\d{6})\s*(?:is\s+your|to\s+(?:sign|log)\s*in|verification|confirm)\b/i,
  // "G-123456" (Google's format)
  /\bG-?(\d{6})\b/,
  // Bare 6-digit (used only if subject also matches)
  /\b(\d{6})\b/,
  // Alphanumeric token (used only if surrounding text matches)
  /(?:code|token|passcode)\s*[:\-]?\s*\b([A-Z0-9]{6,10})\b/i,
]

const MAGIC_LINK_PATTERN =
  /https?:\/\/[^\s"'<>)]+(?:verify|magic|signin|sign-in|login|log-in|confirm|callback|token|activate|authenticate)[^\s"'<>)]*/i

interface SenderClassification {
  strongAuth: boolean   // security@*, accounts@*, or known-service domain
  weakSender: boolean   // generic noreply@/notifications@ etc.
}

function classifySender(rawFrom: string): SenderClassification {
  const lower = rawFrom.toLowerCase()
  let strongPrefix = false
  for (const p of STRONG_SENDER_PREFIXES) {
    if (lower.includes(p)) {
      strongPrefix = true
      break
    }
  }
  let weakPrefix = false
  for (const p of WEAK_SENDER_PREFIXES) {
    if (lower.includes(p)) {
      weakPrefix = true
      break
    }
  }
  let knownService = false
  const m = /@([\w.-]+)$/.exec(lower)
  if (m) {
    const host = m[1]
    for (const known of KNOWN_SERVICE_HOSTS) {
      if (host === known || host.endsWith('.' + known)) {
        knownService = true
        break
      }
    }
  }
  return {
    strongAuth: strongPrefix || knownService,
    weakSender: weakPrefix || knownService,
  }
}

/**
 * A "code-shaped" alphanumeric token: 4–8 chars, all uppercase letters/digits,
 * containing AT LEAST ONE digit AND AT LEAST ONE letter (e.g. "2QAVX3",
 * "G4B7Z"). The mixed-class + uppercase requirement makes these extremely
 * unlikely to be ordinary English words, so they're safe to surface when the
 * email already looks like a verification email. Pure-digit codes are handled
 * by the digit patterns above; pure-letter words are rejected here.
 */
function isMixedCodeToken(tok: string): boolean {
  if (tok.length < 4 || tok.length > 8) return false
  if (tok !== tok.toUpperCase()) return false // must be uppercase (codes are)
  if (!/^[A-Z0-9]+$/.test(tok)) return false
  if (!/[0-9]/.test(tok)) return false // needs a digit
  if (!/[A-Z]/.test(tok)) return false // needs a letter
  return true
}

function extractCode(subject: string, bodyText: string): string | undefined {
  const text = `${subject}\n${bodyText}`
  const subjectHit = SUBJECT_KEYWORDS.test(subject)
  // Try the highly-specific patterns first; only use the last "bare digit" if
  // the subject itself indicates a 2FA email.
  for (let i = 0; i < CODE_PATTERNS.length; i++) {
    const pat = CODE_PATTERNS[i]
    // The bare-6-digit and alphanumeric-token patterns require subject-match
    // as a precondition (lower entropy → easier to misfire).
    if ((i === 3 || i === 4) && !subjectHit) continue
    const m = pat.exec(text)
    if (m) return m[1].toUpperCase()
  }

  // Fallback for alphanumeric codes that aren't directly adjacent to "code"
  // (e.g. Twilio's "Enter the following code to verify your email address:
  // 2QAVX3"). Only when the subject already looks like a verification email.
  if (subjectHit) {
    // First preference: a mixed token within ~40 chars after a code/verify cue.
    const cue = /(?:code|verification|verify|confirm|otp|passcode)[\s\S]{0,40}?\b([A-Za-z0-9]{4,8})\b/i.exec(text)
    if (cue && isMixedCodeToken(cue[1])) return cue[1]
    // Otherwise scan the first ~400 chars for the first distinctive mixed token.
    const head = text.slice(0, 400)
    const re = /\b([A-Za-z0-9]{4,8})\b/g
    let m: RegExpExecArray | null
    while ((m = re.exec(head))) {
      if (isMixedCodeToken(m[1])) return m[1]
    }
  }
  return undefined
}

/** Pull href URLs out of raw HTML (where button/link targets live). */
function extractHrefs(html: string): string {
  if (!html) return ''
  const urls: string[] = []
  const re = /href\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (/^https?:\/\//i.test(m[1])) urls.push(m[1])
  }
  return urls.join(' ')
}

function extractMagicLink(bodyText: string, senderDomain: string): string | undefined {
  // Find all candidates, prefer ones whose host matches the sender domain,
  // reject obvious tracking links.
  const matches: string[] = []
  const re = new RegExp(MAGIC_LINK_PATTERN, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(bodyText))) {
    const url = m[0].replace(/[.,;:!?)\]>]+$/, '') // strip trailing punctuation
    try {
      const u = new URL(url)
      const host = u.hostname.toLowerCase()
      if (LINK_BLACKLIST_HOSTS.some((bad) => host === bad || host.endsWith('.' + bad))) continue
      // Skip obvious unsubscribe URLs by path keyword.
      if (/\bunsubscribe\b/i.test(u.pathname)) continue
      matches.push(url)
    } catch {
      // Malformed URL; skip
    }
  }
  if (matches.length === 0) return undefined
  // Prefer a link whose host matches the sender domain.
  if (senderDomain) {
    const preferred = matches.find((url) => {
      try {
        const u = new URL(url)
        return u.hostname.endsWith(senderDomain)
      } catch {
        return false
      }
    })
    if (preferred) return preferred
  }
  return matches[0]
}

/**
 * Onboarding / marketing "verify your <thing> to start <action>" phrases.
 * These are account-setup nudges (e.g. Twilio "Verify your toll-free number to
 * start messaging"), NOT login 2FA. They carry a setup link but never a login
 * code. Used to reject link-only emails that smell like onboarding.
 */
const ONBOARDING_PHRASES =
  /\b(toll[- ]?free|to start (messaging|using|sending|texting)|get(ting)? started|verify your (business|domain|toll|number|phone|sender|brand|identity|listing)|complete your (registration|profile|setup|sign[- ]?up|onboarding)|finish (setting up|your registration|signing up)|set up your (account|profile|number)|activate your (account|trial|number)|welcome to|claim your|upgrade your|add (your )?payment|update your billing|confirm your subscription)\b/i

export function detectTwoFactor(
  input: DetectorInput,
  opts: DetectorOptions = {},
): TwoFactorMatch | null {
  const fromAddr = (() => {
    const m = /<([^>]+)>/.exec(input.from)
    return (m ? m[1] : input.from).trim().toLowerCase()
  })()

  // Keyring's OWN sign-in codes (sent from keyring@coralautos.com) are never
  // surfaced — you already used the code to get into Keyring, so popping it back
  // at you is pure noise. Hard exclusion: no popover, no shield, not in 2FA filter.
  if (fromAddr === 'keyring@coralautos.com') return null

  const senderForced = !!opts.authSenders?.includes(fromAddr)

  // HARD GATE 1: Gmail's own classification. Promotions/Social/Forums are never
  // 2FA — UNLESS the user explicitly marked this sender as "always auth".
  if (!senderForced && input.labelIds) {
    if (input.labelIds.includes('CATEGORY_PROMOTIONS')) return null
    if (input.labelIds.includes('CATEGORY_SOCIAL')) return null
    if (input.labelIds.includes('CATEGORY_FORUMS')) return null
  }

  const subjectHit = SUBJECT_KEYWORDS.test(input.subject)
  const sender = classifySender(input.from)

  // HARD GATE 2: require a subject keyword, a strongly-auth sender, OR a
  // user-forced auth sender. Generic noreply@anything alone is not enough.
  if (!subjectHit && !sender.strongAuth && !senderForced) return null

  const code = extractCode(input.subject, input.bodyText || input.snippet)
  const senderDomain = (() => {
    const m = /@([\w.-]+)$/.exec(input.from)
    return m ? m[1].toLowerCase() : ''
  })()
  // Scan stripped text AND any <a href> URLs from the HTML body — magic-link
  // buttons keep their URL in the href, which stripHtml discards.
  const linkSearchText = `${input.bodyText || input.snippet || ''} ${extractHrefs(input.bodyHtml ?? '')}`
  const link = extractMagicLink(linkSearchText, senderDomain)

  // HARD GATE 3: need something to actually show the user.
  if (!code && !link) return null

  // HARD GATE 4: reject onboarding / marketing setup emails. These carry a
  // setup link but never a real login code (e.g. Twilio "Verify your toll-free
  // number to start messaging"). Only applies to link-only emails — a real code
  // always wins — and is overridden when the user force-trusts the sender.
  if (
    !code &&
    !senderForced &&
    ONBOARDING_PHRASES.test(`${input.subject} ${input.bodyText || input.snippet || ''}`)
  ) {
    return null
  }

  let confidence = 0
  if (subjectHit) confidence += 0.4
  if (senderForced) confidence += 0.5 // user explicitly trusts this sender
  else if (sender.strongAuth) confidence += 0.3
  else if (sender.weakSender) confidence += 0.05
  if (code) confidence += 0.3
  if (link && (subjectHit || sender.strongAuth || senderForced)) confidence += 0.1
  confidence = Math.min(1, confidence)

  const kind: TwoFactorMatch['kind'] = code && link ? 'both' : code ? 'code' : 'magic-link'
  return { kind, code, link, confidence }
}

// ── "Open in the right Google account" helper ─────────────────────────────

/**
 * If the link is on a Google-owned domain, append/replace `authuser={email}`
 * so Google's account chooser pre-selects the right account. For non-Google
 * URLs we return the link unchanged — those are service magic links that
 * self-authenticate via the token in the URL.
 */
export function withGoogleAuthuser(url: string, accountEmail: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    const isGoogle =
      host === 'google.com' ||
      host.endsWith('.google.com') ||
      host === 'googleusercontent.com' ||
      host.endsWith('.googleusercontent.com')
    if (!isGoogle) return url
    u.searchParams.set('authuser', accountEmail)
    return u.toString()
  } catch {
    return url
  }
}
