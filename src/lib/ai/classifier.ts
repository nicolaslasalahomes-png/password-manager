/**
 * Inbox importance classifier — uses Claude Haiku to decide whether an email
 * is worth the user spending time to read or reply to.
 *
 * Trade-offs:
 *   - Cost: ~$0.00005 per email at Haiku pricing → cents per month per user.
 *   - Latency: ~500ms per email. Classifications run async after the poller
 *     fetches a new email; the UI doesn't wait.
 *   - Privacy: email subject + sender + first ~400 chars of body are sent to
 *     Anthropic. The full body / encrypted vault contents are NOT.
 */

import { AnthropicError, callClaude } from './anthropic'

export interface ClassificationInput {
  subject: string
  from: string
  snippet: string
  bodyText?: string
}

export interface ClassificationResult {
  important: boolean
  reason: string
}

const SYSTEM_PROMPT = `You are an email triage assistant. Decide if a single email is worth the user's attention — something they should READ or potentially REPLY to.

Mark as IMPORTANT (true):
- Direct personal correspondence from a human, written specifically to the user
- Account security (verification codes, password resets, suspicious login alerts)
- Financial transactions that need action (failed payment, refund issued, bill due, fraud alert)
- Work / school / project items requiring a response
- Calendar invites and meeting changes
- Service outages or platform alerts that materially affect the user's account
- Direct replies to threads the user participated in

Mark as NOT IMPORTANT (false):
- Marketing, promotional, sales, "deals", upgrade offers, free-trial nudges
- Newsletters, digests, "weekly summary", "trending" content
- Automated system notifications from SaaS tools the user has signed up for (CRM alerts, property notifications, lead alerts, "X just happened in your account")
- Social media notifications (someone liked / commented / followed)
- Mailing list and forum posts
- Receipts and confirmations that don't require action ("your order shipped", "your subscription renewed")
- Tracking and shipping notifications
- Job alerts / job listings / recruiter mass-emails
- Generic platform updates ("we updated our terms", "what's new")

When in doubt, lean toward NOT IMPORTANT — the user wants a tight inbox.

Output STRICT JSON only, no prose, no markdown fence:
{"important": <true|false>, "reason": "<1 short sentence>"}`

export async function classifyEmail(
  input: ClassificationInput,
  apiKey: string,
): Promise<ClassificationResult> {
  const body = (input.bodyText ?? '').slice(0, 600)
  const userMessage = `Subject: ${input.subject || '(no subject)'}
From: ${input.from || '(unknown)'}
Preview: ${input.snippet || ''}

Body excerpt:
${body}`

  const text = await callClaude({
    apiKey,
    system: SYSTEM_PROMPT,
    maxTokens: 150,
    messages: [{ role: 'user', content: userMessage }],
  })

  return parseClassification(text)
}

/** Tolerant JSON extraction — strips code fences, finds the first {...} block. */
function parseClassification(raw: string): ClassificationResult {
  if (!raw) throw new AnthropicError('Empty response from Claude')
  let s = raw.trim()
  // Strip markdown code fences if the model added them despite instructions.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '')
  // Find the first balanced-ish JSON object.
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1) {
    throw new AnthropicError(`Could not parse classifier JSON from: ${s.slice(0, 200)}`)
  }
  const slice = s.slice(start, end + 1)
  try {
    const obj = JSON.parse(slice) as Partial<ClassificationResult>
    if (typeof obj.important !== 'boolean') {
      throw new AnthropicError(`Classifier response missing 'important': ${slice}`)
    }
    return { important: obj.important, reason: typeof obj.reason === 'string' ? obj.reason : '' }
  } catch (err) {
    throw new AnthropicError(
      `Could not parse classifier JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
