/**
 * KEY-MAIL-1: Claude's mail client decodes what Gmail returns: nested MIME parts, attachments,
 * and HTML-only mail (the kind that showed blank in Keyring's reader on 26 Oct).
 */
import { describe, it, expect } from 'vitest'
import { walk, htmlToText, b64url } from '../scripts/keyring-mail.mjs'

const enc = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')

describe('keyring-mail', () => {
  it('finds text, html and attachments in a nested message', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: enc('Hi Niki, can you build this?') } },
            { mimeType: 'text/html', body: { data: enc('<p>Hi Niki</p>') } },
          ],
        },
        { mimeType: 'text/markdown', filename: 'CLAUDE-HANDOVER-pitch-letter-system.md', body: { attachmentId: 'ANG-1', size: 9000 } },
      ],
    }
    const out = walk(payload)
    expect(out.text).toEqual(['Hi Niki, can you build this?'])
    expect(out.html).toEqual(['<p>Hi Niki</p>'])
    expect(out.attachments.map((a: { filename: string }) => a.filename)).toEqual(['CLAUDE-HANDOVER-pitch-letter-system.md'])
  })

  it('turns HTML-only mail into readable text, links kept', () => {
    const html =
      '<html><head><style>p{color:#fff}</style></head><body><p>Hi&nbsp;Kevin,</p><div>Thanks &amp; regards<br>Justin</div>' +
      '<a href="https://example.com/plan">the plan</a> <script>alert(1)</script></body></html>'
    expect(htmlToText(html)).toBe('Hi Kevin,\nThanks & regards\nJustin\nthe plan (https://example.com/plan)')
  })

  it('decodes Gmail base64url', () => {
    expect(b64url(enc('ñandú ✓')).toString('utf8')).toBe('ñandú ✓')
  })
})
