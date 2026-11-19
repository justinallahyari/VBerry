import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  executeImport,
  exportBackupJson,
  inspectImportJson,
  mapSideberyColor,
  normalizeSideberySnapshots,
  snapshotToMarkdown,
  type SideberyBackupRaw,
} from './sidebery-import'
import { STORAGE_KEYS } from './storage'

// Minimal in-memory chrome.storage.local mock for testing executeImport / exportBackupJson
function setupChromeStorageMock() {
  const store: Record<string, unknown> = {}
  ;(globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key?: string | string[]) => {
          if (!key) return { ...store }
          if (typeof key === 'string') return { [key]: store[key] }
          const out: Record<string, unknown> = {}
          for (const k of key) out[k] = store[k]
          return out
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items)
        }),
      },
    },
  }
  return store
}

describe('Sidebery v5 Import & Export', () => {
  let store: Record<string, unknown>

  beforeEach(() => {
    store = setupChromeStorageMock()
  })

  it('maps Sidebery colors to Chrome Tab Group colors', () => {
    expect(mapSideberyColor('turquoise')).toBe('cyan')
    expect(mapSideberyColor('toolbar')).toBe('grey')
    expect(mapSideberyColor('purple')).toBe('purple')
    expect(mapSideberyColor('orange')).toBe('orange')
    expect(mapSideberyColor(undefined)).toBe('grey')
  })

  it('decompresses delta-encoded Sidebery v5 snapshots accurately', () => {
    const rawSnapshots = [
      {
        id: 'snap-1',
        time: 1700000000000,
        sidebar: {
          nav: ['work', 'personal'],
          panels: {
            work: { id: 'work', type: 2, name: 'Work', color: 'turquoise' },
            personal: { id: 'personal', type: 2, name: 'Personal', color: 'pink' },
          },
        },
        tabs: [
          [
            [{ url: 'https://mail.example.com', title: 'Mail', pinned: true, panelId: 'work' }],
            [
              { url: 'https://github.com', title: 'GitHub', panelId: 'work', lvl: 0 },
              { url: 'https://github.com/pulls', title: 'PRs', panelId: 'work', lvl: 1 },
            ],
          ],
        ],
      },
      {
        id: 'snap-2',
        time: 1700003600000,
        sidebar: 0 as const, // Unchanged
        tabs: [
          [
            [0], // Pinned unchanged
            [
              0, // Tab 0 unchanged (GitHub)
              1, // Delta index 1 -> PRs from snap-1
              { url: 'https://news.ycombinator.com', title: 'HN', panelId: 'personal', lvl: 0 },
            ],
          ],
        ],
      },
    ]

    const normalized = normalizeSideberySnapshots(rawSnapshots)
    expect(normalized).toHaveLength(2)

    const second = normalized[1]
    expect(second.windows[0].pinned).toHaveLength(1)
    expect(second.windows[0].pinned[0].url).toBe('https://mail.example.com')

    expect(second.windows[0].groups).toHaveLength(2)
    expect(second.windows[0].groups[0]).toMatchObject({
      title: 'Work',
      color: 'cyan',
    })
    expect(second.windows[0].groups[0].tabs).toHaveLength(2)
    expect(second.windows[0].groups[0].tabs[1]).toMatchObject({
      url: 'https://github.com/pulls',
      level: 1,
    })
    expect(second.windows[0].groups[1]).toMatchObject({
      title: 'Personal',
      color: 'pink',
    })
  })

  it('imports a full Sidebery v5 backup and supports VBerry round-trip export', async () => {
    const sideberyBackup: SideberyBackupRaw = {
      ver: '5.6.1',
      settings: {
        colorScheme: 'dark',
        density: 'compact',
        tabsTree: true,
        snapInterval: 2,
        snapIntervalUnit: 'hr',
      },
      sidebar: {
        nav: ['p-dev', 'p-bkm'],
        panels: {
          'p-dev': {
            id: 'p-dev',
            type: 2,
            name: 'Dev',
            color: 'blue',
            moveRules: [{ id: 'r1', active: true, url: 'github\\.com' }],
          },
          'p-bkm': { id: 'p-bkm', type: 1, name: 'Bookmarks' },
        },
      },
      sidebarCSS: '.tab-row { font-size: 12px; }',
      snapshots: [
        {
          id: 's1',
          time: 1700000000000,
          sidebar: {
            nav: ['p-dev'],
            panels: { 'p-dev': { id: 'p-dev', type: 2, name: 'Dev', color: 'blue' } },
          },
          tabs: [[[{ url: 'https://vite.dev', title: 'Vite', panelId: 'p-dev', lvl: 0 }]]],
        },
      ],
    }

    const preview = inspectImportJson(JSON.stringify(sideberyBackup))
    expect(preview.format).toBe('sidebery-backup')
    expect(preview.panelsCount).toBe(1)
    expect(preview.snapshotsCount).toBe(1)
    expect(preview.hasSettings).toBe(true)
    expect(preview.hasCustomCss).toBe(true)

    const res = await executeImport(preview)
    expect(res).toEqual({
      panelsImported: 1,
      snapshotsImported: 1,
      settingsImported: true,
      customCssImported: true,
    })

    const savedSettings = store[STORAGE_KEYS.settings] as any
    expect(savedSettings.theme).toBe('dark')
    expect(savedSettings.density).toBe('compact')
    expect(savedSettings.autoSnapshotMinutes).toBe(120)
    expect(savedSettings.customCss).toContain('.tab-row')

    // Export and re-inspect as VBerry backup
    const exported = await exportBackupJson()
    const rePreview = inspectImportJson(exported.json)
    expect(rePreview.format).toBe('vberry-backup')
    expect(rePreview.panelsCount).toBe(1)
    expect(rePreview.snapshotsCount).toBe(1)

    // Markdown export
    const snaps = store[STORAGE_KEYS.snapshots] as any[]
    const md = snapshotToMarkdown(snaps[0])
    expect(md).toContain('### Dev (blue)')
    expect(md).toContain('[Vite](https://vite.dev)')
  })
})
