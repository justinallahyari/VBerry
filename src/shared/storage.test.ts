import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { loadSavedPanels, saveSavedPanels, STORAGE_KEYS } from './storage'
import type { SavedPanel } from './types'

describe('storage serialization safety', () => {
  it('unwraps Vue Proxy arrays into real plain arrays before chrome.storage.local.set', async () => {
    let written: unknown
    ;(globalThis as any).chrome = {
      storage: {
        local: {
          set: vi.fn(async (items: Record<string, unknown>) => {
            written = items[STORAGE_KEYS.savedPanels]
          }),
          get: vi.fn(async () => ({ [STORAGE_KEYS.savedPanels]: written })),
        },
      },
    }

    const reactivePanels = ref<SavedPanel[]>([
      { id: 'p1', title: 'Work', color: 'blue', moveRules: [] },
    ])
    await saveSavedPanels(reactivePanels.value)

    expect(Array.isArray(written)).toBe(true)
    expect(written).not.toBe(reactivePanels.value)
    expect(await loadSavedPanels()).toEqual([
      { id: 'p1', title: 'Work', color: 'blue', moveRules: [] },
    ])
  })

  it('recovers gracefully if chrome.storage previously stored a corrupted plain object', async () => {
    ;(globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({
            [STORAGE_KEYS.savedPanels]: {
              0: { id: 'p1', title: 'Work', color: 'blue', moveRules: [] },
            },
          })),
        },
      },
    }

    const panels = await loadSavedPanels()
    expect(Array.isArray(panels)).toBe(true)
    expect(panels).toHaveLength(1)
    expect(panels[0].title).toBe('Work')
  })
})
