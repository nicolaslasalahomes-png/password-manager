/**
 * 2FA detection beyond English. Nicolas, 13 Oct 2026: the La Sala Homes
 * Financial Console's "Código de Verificación" email (code 715525) arrived
 * but never popped, because the detector only knew English keywords.
 */
import { describe, it, expect } from 'vitest'
import { AUTO_POP_THRESHOLD, detectTwoFactor } from '../src/lib/google/twoFactor'

const laSala = {
  subject: 'Código de Verificación - La Sala Homes',
  from: 'La Sala Homes <noreply@lasalahomes.com>',
  snippet: 'La Sala Homes Financial Console Código de Verificación Usa el siguiente código para completar tu inicio de sesión:',
  labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
}

describe('Spanish verification emails', () => {
  it('pops the La Sala Homes console code (digits together)', () => {
    const m = detectTwoFactor({
      ...laSala,
      bodyText:
        'La Sala Homes\nFinancial Console\nCódigo de Verificación\nUsa el siguiente código para completar tu inicio de sesión:\n715525\nEste código expira en 10 minutos',
    })
    expect(m?.code).toBe('715525')
    expect(m!.confidence).toBeGreaterThanOrEqual(AUTO_POP_THRESHOLD)
  })

  it('pops it when the code is printed with spaces', () => {
    const m = detectTwoFactor({
      ...laSala,
      bodyText:
        'Código de Verificación\nUsa el siguiente código para completar tu inicio de sesión:\n7 1 5 5 2 5\nEste código expira en 10 minutos',
    })
    expect(m?.code).toBe('715525')
    expect(m!.confidence).toBeGreaterThanOrEqual(AUTO_POP_THRESHOLD)
  })

  it('does not pop a Spanish discount code', () => {
    const m = detectTwoFactor({
      subject: 'Tu código de descuento: 20% en tu próxima reserva',
      from: 'Ofertas <noreply@tienda.example>',
      snippet: 'Usa el código VERANO20 antes del 31/10',
      bodyText: 'Usa el código VERANO20 antes del 31/10. Pedido mínimo 100000 euros.',
      labelIds: ['INBOX'],
    })
    expect(m === null || m.confidence < AUTO_POP_THRESHOLD).toBe(true)
  })
})

describe('English still works', () => {
  it('Google style code', () => {
    const m = detectTwoFactor({
      subject: 'Your verification code',
      from: 'Google <no-reply@accounts.google.com>',
      snippet: '',
      bodyText: 'G-482913 is your Google verification code.',
    })
    expect(m?.code).toBe('482913')
  })

  it('a phone number in a non-2FA email is not a code', () => {
    const m = detectTwoFactor({
      subject: 'Your order has shipped',
      from: 'Shop <noreply@shop.example>',
      snippet: '',
      bodyText: 'Questions? Call 6 0 0 1 2 3 or reply to this email.',
    })
    expect(m).toBeNull()
  })
})
