/**
 * Appearance: three user choices (accent colour, background colour, light or
 * dark text) expanded into the two Tailwind scales the whole app is built on.
 *
 *   ink-950 … ink-50     surface → text. 950 is the page, 900 cards, 800
 *                        inputs/hover, 700 borders, 500–400 muted text,
 *                        100–50 main text.
 *   accent-950 … accent-50  same direction, in the accent hue. 600 is the
 *                        chosen accent (solid buttons), 950 a faint tint.
 *
 * Because the scales run "surface → text", dark text simply flips the
 * direction and every existing class keeps working in a light theme.
 * Text shades are pushed further toward the text end until they pass WCAG
 * contrast against the page and card colours, so no combination of picks
 * can produce unreadable text.
 *
 * Values are exposed as `--ink-500: r g b` so Tailwind's `/60` opacity
 * modifiers keep working (see tailwind.config.js).
 */

export type TextTone = 'light' | 'dark'

export interface Theme {
  accent: string // #rrggbb
  background: string // #rrggbb
  text: TextTone
}

export const NIGHT: Theme = { accent: '#0ea5e9', background: '#070a13', text: 'light' }
export const DAY: Theme = { accent: '#0284c7', background: '#f4f6f9', text: 'dark' }

export const PRESETS: Array<{ id: 'night' | 'day'; label: string; theme: Theme }> = [
  { id: 'night', label: 'Night', theme: NIGHT },
  { id: 'day', label: 'Day', theme: DAY },
]

const STORAGE_KEY = 'keyring.theme'
const STEPS = [950, 900, 800, 700, 600, 500, 400, 300, 200, 100, 50] as const
type Step = (typeof STEPS)[number]

/** How far each ink step sits between the surface (0) and the text end (1). */
const INK_T: Record<Step, number> = {
  950: 0, 900: 0.05, 800: 0.11, 700: 0.18, 600: 0.25, 500: 0.38,
  400: 0.53, 300: 0.73, 200: 0.86, 100: 0.94, 50: 0.98,
}
/**
 * Accent steps, anchored on the picked colour (600). 950–700 run from the
 * surface up to the accent (tints for backgrounds); 500–50 run from the
 * accent toward the text end (hover shade and accent-coloured text).
 */
const ACCENT_TO_SURFACE: Partial<Record<Step, number>> = { 950: 0.12, 900: 0.2, 800: 0.35, 700: 0.6 }
const ACCENT_TO_TEXT: Partial<Record<Step, number>> = {
  500: 0.12, 400: 0.25, 300: 0.45, 200: 0.65, 100: 0.8, 50: 0.9,
}

/** Minimum contrast of each text-ish step against page (950) and card (900). */
const MIN_CONTRAST: Partial<Record<Step, number>> = {
  500: 3, 400: 4.5, 300: 4.5, 200: 7, 100: 7, 50: 7,
}
const ACCENT_MIN_CONTRAST: Partial<Record<Step, number>> = {
  400: 4.5, 300: 4.5, 200: 4.5, 100: 7, 50: 7,
}

// ── Colour maths (sRGB ↔ OKLab ↔ OKLCH) ────────────────────────────────────

type RGB = [number, number, number] // 0..1, gamma-encoded
interface LCH { l: number; c: number; h: number }

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

export function parseHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function toHex([r, g, b]: RGB): string {
  const h = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

function rgbToOklch([r, g, b]: RGB): LCH {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { l: L, c: Math.hypot(A, B), h: Math.atan2(B, A) }
}

function oklchToRgbRaw({ l, c, h }: LCH): RGB {
  const A = c * Math.cos(h), B = c * Math.sin(h)
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    toGamma(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    toGamma(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    toGamma(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ]
}

/** OKLCH → sRGB, reducing chroma until the colour fits the sRGB gamut. */
function oklchToRgb(lch: LCH): RGB {
  const l = Math.min(1, Math.max(0, lch.l))
  let c = lch.c
  for (let i = 0; i < 30; i++) {
    const rgb = oklchToRgbRaw({ l, c, h: lch.h })
    if (rgb.every((v) => v >= -0.0005 && v <= 1.0005)) return rgb
    c *= 0.9
  }
  return oklchToRgbRaw({ l, c: 0, h: lch.h })
}

function luminance([r, g, b]: RGB): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ── Scale generation ───────────────────────────────────────────────────────

/** Keep the page colour far enough from the text end to leave room for text. */
function clampSurface(bg: LCH, text: TextTone): LCH {
  return text === 'light' ? { ...bg, l: Math.min(bg.l, 0.36) } : { ...bg, l: Math.max(bg.l, 0.9) }
}

/**
 * Move `lch` toward the text end until it reaches `min` contrast against every
 * colour in `against`. Deterministic: small fixed steps, bounded.
 */
function pushForContrast(lch: LCH, textL: number, against: RGB[], min: number): RGB {
  let cur = { ...lch }
  for (let i = 0; i < 60; i++) {
    const rgb = oklchToRgb(cur)
    if (against.every((bg) => contrast(rgb, bg) >= min)) return rgb
    cur = { ...cur, l: cur.l + (textL - cur.l) * 0.08 + (textL > cur.l ? 0.002 : -0.002) }
  }
  return oklchToRgb({ ...cur, l: textL, c: Math.min(cur.c, 0.02) })
}

export interface ThemeScales {
  ink: Record<Step, RGB>
  accent: Record<Step, RGB>
  onAccent: RGB
}

export function buildScales(theme: Theme): ThemeScales {
  const bgRgb = parseHex(theme.background) ?? parseHex(NIGHT.background)!
  const accRgb = parseHex(theme.accent) ?? parseHex(NIGHT.accent)!
  const surface = clampSurface(rgbToOklch(bgRgb), theme.text)
  const textL = theme.text === 'light' ? 0.985 : 0.18
  const textC = Math.min(surface.c, 0.012)

  const ink = {} as Record<Step, RGB>
  for (const step of STEPS) {
    const t = INK_T[step]
    const lch: LCH = {
      l: surface.l + (textL - surface.l) * t,
      c: surface.c + (textC - surface.c) * t,
      h: surface.h,
    }
    ink[step] = oklchToRgb(lch)
  }
  // Text shades must stay readable on the page and on cards.
  const surfaces = [ink[950], ink[900]]
  for (const step of STEPS) {
    const min = MIN_CONTRAST[step]
    if (!min) continue
    const t = INK_T[step]
    ink[step] = pushForContrast(
      { l: surface.l + (textL - surface.l) * t, c: surface.c + (textC - surface.c) * t, h: surface.h },
      textL,
      surfaces,
      min,
    )
  }

  const acc = rgbToOklch(accRgb)
  const accent = {} as Record<Step, RGB>
  for (const step of STEPS) {
    if (step === 600) {
      accent[step] = accRgb
      continue
    }
    const toSurface = ACCENT_TO_SURFACE[step]
    const lch: LCH =
      toSurface !== undefined
        ? { l: surface.l + (acc.l - surface.l) * toSurface, c: acc.c * (0.3 + 0.5 * toSurface), h: acc.h }
        : { l: acc.l + (textL - acc.l) * (ACCENT_TO_TEXT[step] ?? 0), c: acc.c, h: acc.h }
    const min = ACCENT_MIN_CONTRAST[step]
    accent[step] = min ? pushForContrast(lch, textL, surfaces, min) : oklchToRgb(lch)
  }

  const white: RGB = [1, 1, 1]
  const dark: RGB = oklchToRgb({ l: 0.18, c: Math.min(acc.c, 0.03), h: acc.h })
  const onAccent = contrast(white, accRgb) >= contrast(dark, accRgb) ? white : dark

  return { ink, accent, onAccent }
}

/**
 * Fixed status colours (errors, warnings, success). Tailwind's own values;
 * with dark text the light shades used for text and the dark shades used for
 * tints swap ends so they stay readable. 500/600 are solid fills and stay put.
 */
const STATUS: Record<string, Record<Step, string>> = {
  red: {50: '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5', 400: '#f87171', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b', 900: '#7f1d1d', 950: '#450a0a'},
  amber: {50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f', 950: '#451a03'},
  emerald: {50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22'},
}
const STATUS_ON_LIGHT: Record<Step, Step> = {
  50: 950, 100: 900, 200: 800, 300: 800, 400: 700, 500: 500, 600: 600,
  700: 300, 800: 200, 900: 100, 950: 50,
}

const channels = ([r, g, b]: RGB) =>
  `${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)}`

export function themeCssVars(theme: Theme): Record<string, string> {
  const { ink, accent, onAccent } = buildScales(theme)
  const vars: Record<string, string> = { '--on-accent': channels(onAccent) }
  for (const step of STEPS) {
    vars[`--ink-${step}`] = channels(ink[step])
    vars[`--accent-${step}`] = channels(accent[step])
    for (const [name, scale] of Object.entries(STATUS)) {
      const src = theme.text === 'dark' ? STATUS_ON_LIGHT[step] : step
      vars[`--${name}-${step}`] = channels(parseHex(scale[src])!)
    }
  }
  return vars
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  for (const [k, v] of Object.entries(themeCssVars(theme))) root.style.setProperty(k, v)
  root.style.colorScheme = theme.text === 'light' ? 'dark' : 'light'
  root.dataset.textTone = theme.text
}

function isTheme(v: unknown): v is Theme {
  const t = v as Theme
  return (
    !!t &&
    typeof t === 'object' &&
    !!parseHex(t.accent) &&
    !!parseHex(t.background) &&
    (t.text === 'light' || t.text === 'dark')
  )
}

export function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (isTheme(parsed)) return parsed
    }
  } catch {
    // Storage unavailable or corrupt: fall back to the default.
  }
  return NIGHT
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(theme))
  } catch {
    // Non-fatal: the theme still applies for this session.
  }
  applyTheme(theme)
}

/** Apply the saved theme now and follow changes made in other windows. */
export function initTheme(): void {
  applyTheme(loadTheme())
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) applyTheme(loadTheme())
  })
}

export function matchPreset(theme: Theme): 'night' | 'day' | null {
  const same = (a: Theme, b: Theme) =>
    a.accent.toLowerCase() === b.accent.toLowerCase() &&
    a.background.toLowerCase() === b.background.toLowerCase() &&
    a.text === b.text
  return PRESETS.find((p) => same(p.theme, theme))?.id ?? null
}

/** The page colour actually used, after clamping for readability. */
export function effectiveBackground(theme: Theme): string {
  return toHex(buildScales(theme).ink[950])
}
