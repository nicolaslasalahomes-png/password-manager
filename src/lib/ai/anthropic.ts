/**
 * Minimal Anthropic Messages API client.
 *
 * Used by the inbox importance classifier. We don't ship the official
 * @anthropic-ai/sdk to keep the bundle small — raw fetch is enough.
 *
 * The API key lives in the Tauri local plugin-store (see email.ts
 * getAnthropicApiKey). It NEVER leaves the user's machine except to
 * api.anthropic.com when we make a classification call.
 */

import { recordUsage } from './usage'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

export class AnthropicError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = 'AnthropicError'
  }
}

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface CallOptions {
  apiKey: string
  model?: string
  maxTokens?: number
  system: string
  messages: AnthropicMessage[]
  /** Disables Anthropic's CORS check; we run from a Tauri webview which presents as a browser. */
  dangerousDirectBrowserAccess?: boolean
}

/**
 * Call Claude. Returns the text content of the first content block.
 * Default model is the cheapest current Haiku for fast/cheap classification.
 */
export async function callClaude(opts: CallOptions): Promise<string> {
  if (!opts.apiKey) throw new AnthropicError('Anthropic API key not set')
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-api-key': opts.apiKey,
    'anthropic-version': API_VERSION,
  }
  if (opts.dangerousDirectBrowserAccess !== false) {
    // Tauri WebView CORS context — need this header for the API to accept.
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
  }

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: opts.model ?? 'claude-haiku-4-5',
      max_tokens: opts.maxTokens ?? 256,
      system: opts.system,
      messages: opts.messages,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new AnthropicError(
      `Anthropic API error (${resp.status}): ${text.slice(0, 300)}`,
      resp.status,
    )
  }
  const json = (await resp.json()) as {
    content?: Array<{ type: string; text?: string }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  // Record token usage for the local cost meter (fire-and-forget).
  if (json.usage) {
    void recordUsage(
      opts.model ?? 'claude-haiku-4-5',
      json.usage.input_tokens ?? 0,
      json.usage.output_tokens ?? 0,
    ).catch(() => {})
  }
  const first = json.content?.find((c) => c.type === 'text')
  return first?.text ?? ''
}
