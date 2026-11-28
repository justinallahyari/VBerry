import type {
  AutoThemeId,
  CustomTheme,
  PresetThemeId,
  Settings,
  ThemeColors,
} from './types'

export type ConcreteThemeId = PresetThemeId

export interface ThemePalette extends ThemeColors {
  id: string
  name: string
  tagline: string
  bgHover: string
  borderStrong: string
  vivaldiSlug: string
  vivaldiUuid: string
  isCustom?: boolean
  isModifiedPreset?: boolean
}

export interface AutoThemeGroup {
  id: AutoThemeId
  name: string
  tag: string
  tagline: string
  lightId: PresetThemeId
  darkId: PresetThemeId
}

export interface ComputedAccentTokens {
  accent: string
  accentHover: string
  accentSoft: string
  accentText: string
  bgActive: string
  bgSelected: string
}

export const AUTO_THEME_GROUPS: AutoThemeGroup[] = [
  {
    id: 'auto',
    name: 'System',
    tag: 'Auto',
    tagline: 'Switches between Mineral Slate & Graphite Plum with OS mode',
    lightId: 'light',
    darkId: 'dark',
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi Default',
    tag: 'Light / Dark',
    tagline: 'Matches Vivaldi’s built-in Light and Dark browser themes automatically',
    lightId: 'vivaldi-light',
    darkId: 'vivaldi-dark',
  },
  {
    id: 'chrome',
    name: 'Chrome Default',
    tag: 'Light / Dark',
    tagline: 'Matches Google Chrome’s Material 3 Light and Dark UI automatically',
    lightId: 'chrome-light',
    darkId: 'chrome-dark',
  },
]

export const THEME_PRESETS: Record<PresetThemeId, ThemePalette> = {
  'vivaldi-light': {
    id: 'vivaldi-light',
    name: 'Vivaldi Light',
    tagline: 'Vivaldi default neutral grey & crimson accent',
    scheme: 'light',
    bg: '#f5f5f5',
    surface: '#ffffff',
    bgSubtle: '#ebebee',
    bgHover: '#e4e5e9',
    border: '#dcdde2',
    borderStrong: '#c2c5ce',
    text: '#222222',
    textMuted: '#60636b',
    defaultAccent: '#dc3232',
    vivaldiSlug: 'vberry-vivaldi-light',
    vivaldiUuid: '7b5c1409-6a42-4f3a-9c11-101a0b2c3d09',
  },
  'chrome-light': {
    id: 'chrome-light',
    name: 'Chrome Light',
    tagline: 'Google Chrome Material 3 cool slate & primary blue',
    scheme: 'light',
    bg: '#f3f6fc',
    surface: '#ffffff',
    bgSubtle: '#dee1e6',
    bgHover: '#e4e9f2',
    border: '#d3dbe5',
    borderStrong: '#b6c2d1',
    text: '#1f1f1f',
    textMuted: '#444746',
    defaultAccent: '#0b57d0',
    vivaldiSlug: 'vberry-chrome-light',
    vivaldiUuid: '7b5c1410-6a42-4f3a-9c11-101a0b2c3d10',
  },
  light: {
    id: 'light',
    name: 'Mineral Slate',
    tagline: 'Cool mineral daylight & damson',
    scheme: 'light',
    bg: '#f7f8fa',
    surface: '#ffffff',
    bgSubtle: '#eef0f5',
    bgHover: '#e4e7ef',
    border: '#dce0ea',
    borderStrong: '#c4cad8',
    text: '#171921',
    textMuted: '#5c6373',
    defaultAccent: '#9a2257',
    vivaldiSlug: 'vberry-mineral-slate',
    vivaldiUuid: '7b5c1401-6a42-4f3a-9c11-101a0b2c3d01',
  },
  paper: {
    id: 'paper',
    name: 'Warm Paper',
    tagline: 'Unbleached cotton & persimmon ink',
    scheme: 'light',
    bg: '#f6f2ea',
    surface: '#fdfbf7',
    bgSubtle: '#ece6da',
    bgHover: '#e2dacb',
    border: '#dcd3c2',
    borderStrong: '#c5baa5',
    text: '#201c17',
    textMuted: '#695f53',
    defaultAccent: '#b5422d',
    vivaldiSlug: 'vberry-warm-paper',
    vivaldiUuid: '7b5c1402-6a42-4f3a-9c11-101a0b2c3d02',
  },
  dawn: {
    id: 'dawn',
    name: 'Coastal Mist',
    tagline: 'Sea-glass slate & harbor teal',
    scheme: 'light',
    bg: '#f2f6f8',
    surface: '#ffffff',
    bgSubtle: '#e5eef2',
    bgHover: '#d8e5eb',
    border: '#cedce3',
    borderStrong: '#b5c8d2',
    text: '#132026',
    textMuted: '#536873',
    defaultAccent: '#0f7682',
    vivaldiSlug: 'vberry-coastal-mist',
    vivaldiUuid: '7b5c1403-6a42-4f3a-9c11-101a0b2c3d03',
  },
  'vivaldi-dark': {
    id: 'vivaldi-dark',
    name: 'Vivaldi Dark',
    tagline: 'Vivaldi default charcoal & periwinkle highlight',
    scheme: 'dark',
    bg: '#2e2f37',
    surface: '#383942',
    bgSubtle: '#1d1e21',
    bgHover: '#41434e',
    border: '#434552',
    borderStrong: '#585b6b',
    text: '#d3d9e3',
    textMuted: '#9aa2b1',
    defaultAccent: '#7aa0ff',
    vivaldiSlug: 'vberry-vivaldi-dark',
    vivaldiUuid: '7b5c1411-6a42-4f3a-9c11-101a0b2c3d11',
  },
  'chrome-dark': {
    id: 'chrome-dark',
    name: 'Chrome Dark',
    tagline: 'Google Chrome dark neutral & Material 3 sky blue',
    scheme: 'dark',
    bg: '#202124',
    surface: '#292a2d',
    bgSubtle: '#17181a',
    bgHover: '#35363a',
    border: '#3c4043',
    borderStrong: '#5f6368',
    text: '#e8eaed',
    textMuted: '#9aa0a6',
    defaultAccent: '#a8c7fa',
    vivaldiSlug: 'vberry-chrome-dark',
    vivaldiUuid: '7b5c1412-6a42-4f3a-9c11-101a0b2c3d12',
  },
  dark: {
    id: 'dark',
    name: 'Graphite Plum',
    tagline: 'Deep graphite & luminous roseberry',
    scheme: 'dark',
    bg: '#15171c',
    surface: '#1d2028',
    bgSubtle: '#101217',
    bgHover: '#232732',
    border: '#282c38',
    borderStrong: '#393f50',
    text: '#eceef4',
    textMuted: '#8e96a8',
    defaultAccent: '#e66c9f',
    vivaldiSlug: 'vberry-graphite-plum',
    vivaldiUuid: '7b5c1404-6a42-4f3a-9c11-101a0b2c3d04',
  },
  nordic: {
    id: 'nordic',
    name: 'Nordic Frost',
    tagline: 'Polar slate & fjord ice',
    scheme: 'dark',
    bg: '#1c212b',
    surface: '#242b38',
    bgSubtle: '#161a23',
    bgHover: '#2c3444',
    border: '#30394a',
    borderStrong: '#414d63',
    text: '#e6ecf5',
    textMuted: '#909db2',
    defaultAccent: '#6cb6d9',
    vivaldiSlug: 'vberry-nordic-frost',
    vivaldiUuid: '7b5c1405-6a42-4f3a-9c11-101a0b2c3d05',
  },
  pine: {
    id: 'pine',
    name: 'Evergreen Studio',
    tagline: 'Deep spruce charcoal & sage',
    scheme: 'dark',
    bg: '#131a17',
    surface: '#1a2420',
    bgSubtle: '#0e1411',
    bgHover: '#22302a',
    border: '#26352e',
    borderStrong: '#364b42',
    text: '#e7f0ec',
    textMuted: '#89a095',
    defaultAccent: '#56c288',
    vivaldiSlug: 'vberry-evergreen-studio',
    vivaldiUuid: '7b5c1406-6a42-4f3a-9c11-101a0b2c3d06',
  },
  tokyo: {
    id: 'tokyo',
    name: 'Midnight Indigo',
    tagline: 'Twilight navy & iris violet',
    scheme: 'dark',
    bg: '#161622',
    surface: '#1f2030',
    bgSubtle: '#11111b',
    bgHover: '#28293e',
    border: '#2c2e45',
    borderStrong: '#3e4160',
    text: '#e8e9f7',
    textMuted: '#8f92b5',
    defaultAccent: '#9d86ff',
    vivaldiSlug: 'vberry-midnight-indigo',
    vivaldiUuid: '7b5c1407-6a42-4f3a-9c11-101a0b2c3d07',
  },
  espresso: {
    id: 'espresso',
    name: 'Espresso & Brass',
    tagline: 'Roasted umber & burnished amber',
    scheme: 'dark',
    bg: '#1b1715',
    surface: '#251f1c',
    bgSubtle: '#14110f',
    bgHover: '#302824',
    border: '#362d28',
    borderStrong: '#4b3f38',
    text: '#f2eae4',
    textMuted: '#a59489',
    defaultAccent: '#e09f5a',
    vivaldiSlug: 'vberry-espresso-brass',
    vivaldiUuid: '7b5c1408-6a42-4f3a-9c11-101a0b2c3d08',
  },
}

export const THEME_ORDER: PresetThemeId[] = [
  'vivaldi-light',
  'chrome-light',
  'light',
  'paper',
  'dawn',
  'vivaldi-dark',
  'chrome-dark',
  'dark',
  'nordic',
  'pine',
  'tokyo',
  'espresso',
]

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

export function parseHexRgb(hex: string): [number, number, number] | null {
  const m = hex.trim().match(HEX_RE)
  if (!m) return null
  const raw = m[1]
  if (raw.length === 3) {
    return [
      parseInt(raw[0] + raw[0], 16),
      parseInt(raw[1] + raw[1], 16),
      parseInt(raw[2] + raw[2], 16),
    ]
  }
  return [
    parseInt(raw.slice(0, 2), 16),
    parseInt(raw.slice(2, 4), 16),
    parseInt(raw.slice(4, 6), 16),
  ]
}

function toHexByte(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0')
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`
}

export function normalizeHex(hex: string | undefined, fallback: string): string {
  if (!hex) return fallback
  const rgb = parseHexRgb(hex)
  return rgb ? rgbToHex(rgb[0], rgb[1], rgb[2]) : fallback
}

function mixRgb(
  base: [number, number, number],
  tint: [number, number, number],
  weight: number
): string {
  const w = Math.max(0, Math.min(1, weight))
  return rgbToHex(
    base[0] * (1 - w) + tint[0] * w,
    base[1] * (1 - w) + tint[1] * w,
    base[2] * (1 - w) + tint[2] * w
  )
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const chan = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
}

export function isAutoThemeId(theme?: string): theme is AutoThemeId {
  return theme === 'auto' || theme === 'vivaldi' || theme === 'chrome'
}

export function deriveThemePaletteFromColors(
  base: {
    id: string
    name: string
    tagline: string
    vivaldiSlug?: string
    vivaldiUuid?: string
    isCustom?: boolean
    isModifiedPreset?: boolean
  },
  colors: ThemeColors
): ThemePalette {
  const scheme = colors.scheme === 'dark' ? 'dark' : 'light'
  const fallback = scheme === 'dark' ? THEME_PRESETS.dark : THEME_PRESETS.light
  const bg = normalizeHex(colors.bg, fallback.bg)
  const surface = normalizeHex(colors.surface, fallback.surface)
  const bgSubtle = normalizeHex(colors.bgSubtle, fallback.bgSubtle)
  const border = normalizeHex(colors.border, fallback.border)
  const text = normalizeHex(colors.text, fallback.text)
  const textMuted = normalizeHex(colors.textMuted, fallback.textMuted)
  const defaultAccent = normalizeHex(colors.defaultAccent, fallback.defaultAccent)

  const bgRgb = parseHexRgb(bg) ?? [247, 248, 250]
  const surfaceRgb = parseHexRgb(surface) ?? bgRgb
  const borderRgb = parseHexRgb(border) ?? [220, 224, 234]
  const textRgb = parseHexRgb(text) ?? [23, 25, 33]

  const bgHover =
    scheme === 'dark' ? mixRgb(surfaceRgb, textRgb, 0.09) : mixRgb(bgRgb, textRgb, 0.07)
  const borderStrong = mixRgb(borderRgb, textRgb, scheme === 'dark' ? 0.2 : 0.16)

  return {
    id: base.id,
    name: base.name,
    tagline: base.tagline,
    scheme,
    bg,
    surface,
    bgSubtle,
    bgHover,
    border,
    borderStrong,
    text,
    textMuted,
    defaultAccent,
    vivaldiSlug: base.vivaldiSlug ?? '',
    vivaldiUuid: base.vivaldiUuid ?? '',
    isCustom: base.isCustom,
    isModifiedPreset: base.isModifiedPreset,
  }
}

export function getEffectivePresetPalette(
  id: PresetThemeId,
  themeOverrides?: Record<string, Partial<ThemeColors>>
): ThemePalette {
  const base = THEME_PRESETS[id]
  const ov = themeOverrides?.[id]
  if (!ov || typeof ov !== 'object' || Object.keys(ov).length === 0) {
    return base
  }
  return deriveThemePaletteFromColors(
    {
      id: base.id,
      name: base.name,
      tagline: base.tagline,
      vivaldiSlug: base.vivaldiSlug,
      vivaldiUuid: base.vivaldiUuid,
      isModifiedPreset: true,
    },
    {
      scheme: ov.scheme === 'dark' || ov.scheme === 'light' ? ov.scheme : base.scheme,
      bg: ov.bg ?? base.bg,
      surface: ov.surface ?? base.surface,
      bgSubtle: ov.bgSubtle ?? base.bgSubtle,
      border: ov.border ?? base.border,
      text: ov.text ?? base.text,
      textMuted: ov.textMuted ?? base.textMuted,
      defaultAccent: ov.defaultAccent ?? base.defaultAccent,
    }
  )
}

export function resolveEffectiveThemeId(
  theme: string | undefined,
  prefersDark: boolean
): PresetThemeId {
  if (!theme || theme === 'auto') {
    return prefersDark ? 'dark' : 'light'
  }
  if (theme === 'vivaldi') {
    return prefersDark ? 'vivaldi-dark' : 'vivaldi-light'
  }
  if (theme === 'chrome') {
    return prefersDark ? 'chrome-dark' : 'chrome-light'
  }
  if (theme in THEME_PRESETS) {
    return theme as PresetThemeId
  }
  return prefersDark ? 'dark' : 'light'
}

export interface VisualThemeSettings {
  theme: string
  customThemes?: CustomTheme[]
  themeOverrides?: Record<string, Partial<ThemeColors>>
}

export function resolveThemePalette(
  settings: VisualThemeSettings,
  prefersDark: boolean
): ThemePalette {
  const customList = Array.isArray(settings.customThemes) ? settings.customThemes : []
  const customHit = customList.find(c => c && c.id === settings.theme)
  if (customHit) {
    return deriveThemePaletteFromColors(
      {
        id: customHit.id,
        name: customHit.name || 'Custom theme',
        tagline: `Custom ${customHit.scheme === 'dark' ? 'dark' : 'light'} theme`,
        isCustom: true,
      },
      customHit
    )
  }
  const presetId = resolveEffectiveThemeId(settings.theme, prefersDark)
  return getEffectivePresetPalette(presetId, settings.themeOverrides)
}

export function computeAccentTokens(
  palette: Pick<ThemePalette, 'bg' | 'defaultAccent' | 'scheme'>
): ComputedAccentTokens {
  const hex = normalizeHex(palette.defaultAccent, '#9a2257')
  const accentRgb = parseHexRgb(hex) ?? [154, 34, 87]
  const bgRgb =
    parseHexRgb(palette.bg) ?? (palette.scheme === 'dark' ? [21, 23, 28] : [247, 248, 250])
  const isDark = palette.scheme === 'dark'

  const accentHover = isDark
    ? mixRgb(accentRgb, [255, 255, 255], 0.14)
    : mixRgb(accentRgb, [0, 0, 0], 0.14)

  const softAlpha = isDark ? 0.16 : 0.11
  const accentSoft = `rgba(${accentRgb[0]}, ${accentRgb[1]}, ${accentRgb[2]}, ${softAlpha})`

  const lum = relativeLuminance(accentRgb)
  const accentText = lum > 0.36 ? '#14161d' : '#ffffff'

  const bgActive = mixRgb(bgRgb, accentRgb, isDark ? 0.16 : 0.1)
  const bgSelected = mixRgb(bgRgb, accentRgb, isDark ? 0.21 : 0.14)

  return {
    accent: hex,
    accentHover,
    accentSoft,
    accentText,
    bgActive,
    bgSelected,
  }
}

let boundAutoListener: (() => void) | null = null
let lastAppliedSettings: VisualThemeSettings = {
  theme: 'auto',
}

function prefersDarkScheme(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}

/**
 * Apply theme surfaces, custom themes, preset overrides, dark/light color-scheme attributes,
 * and dynamic accent tokens to `root`.
 */
export function applyVisualTheme(
  settings: VisualThemeSettings & Partial<Pick<Settings, 'customThemes' | 'themeOverrides'>>,
  root: HTMLElement = document.documentElement
): ThemePalette {
  lastAppliedSettings = {
    theme: settings.theme,
    customThemes: settings.customThemes,
    themeOverrides: settings.themeOverrides,
  }

  if (
    !boundAutoListener &&
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
  ) {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    boundAutoListener = () => {
      if (isAutoThemeId(lastAppliedSettings.theme)) {
        applyVisualTheme(lastAppliedSettings)
      }
    }
    mql.addEventListener?.('change', boundAutoListener)
  }

  const palette = resolveThemePalette(settings, prefersDarkScheme())
  const tokens = computeAccentTokens(palette)

  if (settings.theme === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', palette.id)
  root.setAttribute('data-color-scheme', palette.scheme)

  root.style.setProperty('--bg', palette.bg)
  root.style.setProperty('--surface', palette.surface)
  root.style.setProperty('--bg-subtle', palette.bgSubtle)
  root.style.setProperty('--bg-hover', palette.bgHover)
  root.style.setProperty('--border', palette.border)
  root.style.setProperty('--border-strong', palette.borderStrong)
  root.style.setProperty('--text', palette.text)
  root.style.setProperty('--text-muted', palette.textMuted)

  root.style.setProperty('--accent', tokens.accent)
  root.style.setProperty('--accent-hover', tokens.accentHover)
  root.style.setProperty('--accent-soft', tokens.accentSoft)
  root.style.setProperty('--accent-text', tokens.accentText)
  root.style.setProperty('--bg-active', tokens.bgActive)
  root.style.setProperty('--bg-selected', tokens.bgSelected)

  return palette
}
