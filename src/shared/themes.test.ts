import { describe, expect, it } from 'vitest'
import {
  applyVisualTheme,
  computeAccentTokens,
  getEffectivePresetPalette,
  resolveEffectiveThemeId,
  resolveThemePalette,
  THEME_ORDER,
  THEME_PRESETS,
} from './themes'
import type { CustomTheme } from './types'

describe('Theme Engine', () => {
  it('resolves auto, vivaldi default, chrome default, and named themes cleanly', () => {
    expect(resolveEffectiveThemeId('auto', false)).toBe('light')
    expect(resolveEffectiveThemeId('auto', true)).toBe('dark')
    expect(resolveEffectiveThemeId('vivaldi', false)).toBe('vivaldi-light')
    expect(resolveEffectiveThemeId('vivaldi', true)).toBe('vivaldi-dark')
    expect(resolveEffectiveThemeId('chrome', false)).toBe('chrome-light')
    expect(resolveEffectiveThemeId('chrome', true)).toBe('chrome-dark')
    expect(resolveEffectiveThemeId('nordic', false)).toBe('nordic')
    expect(resolveEffectiveThemeId('paper', true)).toBe('paper')
    expect(resolveEffectiveThemeId('unknown', false)).toBe('light')
  })

  it('picks readable foreground contrast for dark vs bright theme accents', () => {
    const darkBtn = computeAccentTokens({
      ...THEME_PRESETS.light,
      defaultAccent: '#1e3a8a',
    })
    expect(darkBtn.accentText).toBe('#ffffff')

    const brightBtn = computeAccentTokens({
      ...THEME_PRESETS.dark,
      defaultAccent: '#fde047',
    })
    expect(brightBtn.accentText).toBe('#14161d')
  })

  it('applies surface and accent CSS variables across all 12 built-in presets onto root element', () => {
    const el = document.createElement('div')
    expect(THEME_ORDER).toHaveLength(12)
    for (const id of THEME_ORDER) {
      const p = applyVisualTheme({ theme: id }, el)
      expect(el.getAttribute('data-theme')).toBe(id)
      expect(el.getAttribute('data-color-scheme')).toBe(p.scheme)
      expect(el.style.getPropertyValue('--bg')).toBe(p.bg)
      expect(el.style.getPropertyValue('--accent')).toBe(p.defaultAccent)
    }
  })

  it('resolves user-created custom themes and preset color overrides with auto-derived hover/strong borders', () => {
    const custom: CustomTheme = {
      id: 'theme_catppuccin',
      name: 'Catppuccin Mocha',
      scheme: 'dark',
      bg: '#1e1e2e',
      surface: '#313244',
      bgSubtle: '#181825',
      border: '#45475a',
      text: '#cdd6f4',
      textMuted: '#a6adc8',
      defaultAccent: '#cba6f7',
    }

    const el = document.createElement('div')
    const resolved = applyVisualTheme({ theme: 'theme_catppuccin', customThemes: [custom] }, el)
    expect(resolved.isCustom).toBe(true)
    expect(resolved.name).toBe('Catppuccin Mocha')
    expect(el.getAttribute('data-color-scheme')).toBe('dark')
    expect(el.style.getPropertyValue('--bg')).toBe('#1e1e2e')
    expect(el.style.getPropertyValue('--accent')).toBe('#cba6f7')
    expect(el.style.getPropertyValue('--bg-hover')).not.toBe('')

    const modifiedVivaldi = resolveThemePalette(
      {
        theme: 'vivaldi',
        themeOverrides: { 'vivaldi-dark': { bg: '#191a20', defaultAccent: '#ff5c5c' } },
      },
      true
    )
    expect(modifiedVivaldi.isModifiedPreset).toBe(true)
    expect(modifiedVivaldi.bg).toBe('#191a20')
    expect(modifiedVivaldi.defaultAccent).toBe('#ff5c5c')
    expect(getEffectivePresetPalette('vivaldi-light', {}).isModifiedPreset).toBeUndefined()
  })
})
