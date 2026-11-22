import type { TabTreeMap } from './types'
import {
  loadTreeMeta,
  loadVirtualGroupMap,
  saveTreeMeta,
  saveVirtualGroupMap,
  STORAGE_KEYS,
} from './storage'
import { buildTabTree } from './tree'

interface PersistedTabRecord {
  url: string
  pinned?: boolean
  level: number
  folded?: boolean
  virtualGroupId?: string
}

interface PersistedWindowState {
  tabs: PersistedTabRecord[]
}

function normalizeUrl(url?: string): string {
  return (url || '').trim()
}

/**
 * Pure serializer: converts live windows + ephemeral tabId-based treeMeta & virtualGroups
 * into URL-ordered records that survive browser quit & reopen (when Chromium assigns new tab IDs).
 */
export function serializeWindowsState(
  windows: Array<{ tabs?: chrome.tabs.Tab[] }>,
  treeMeta: TabTreeMap,
  virtualGroups: Record<number, string>
): PersistedWindowState[] {
  const result: PersistedWindowState[] = []

  for (const win of windows) {
    const winTabs = (win.tabs ?? []).slice().sort((a, b) => a.index - b.index)
    if (!winTabs.length) continue

    const nodes = buildTabTree(winTabs, treeMeta)
    const nodeById = new Map(nodes.map(n => [n.id, n]))

    const records: PersistedTabRecord[] = []
    for (const tab of winTabs) {
      const url = normalizeUrl(tab.url || tab.pendingUrl)
      if (!url) continue
      const node = tab.id !== undefined ? nodeById.get(tab.id) : undefined
      const vid = tab.id !== undefined ? virtualGroups[tab.id] : undefined
      records.push({
        url,
        pinned: tab.pinned || undefined,
        level: tab.pinned ? 0 : (node?.level ?? 0),
        folded: node?.folded || undefined,
        virtualGroupId: !tab.pinned && vid ? vid : undefined,
      })
    }

    if (records.length) {
      result.push({ tabs: records })
    }
  }

  return result
}

/**
 * Pure matcher: maps newly-assigned tab IDs on browser restart back to their persisted
 * tree hierarchy (`level` -> `parentId`, `folded`) and `virtualGroupId` via ordered URL matching.
 */
export function matchAndRebuildSession(
  currentWindows: Array<{ tabs?: chrome.tabs.Tab[] }>,
  persistedWindows: PersistedWindowState[]
): { treeMeta: TabTreeMap; virtualGroups: Record<number, string> } {
  const treeMeta: TabTreeMap = {}
  const virtualGroups: Record<number, string> = {}
  const usedPersisted = new Set<number>()

  for (const win of currentWindows) {
    const winTabs = (win.tabs ?? []).slice().sort((a, b) => a.index - b.index)
    if (!winTabs.length) continue

    // Pick the persisted window with the highest ordered URL overlap
    let bestIdx = -1
    let bestScore = 0
    for (let pi = 0; pi < persistedWindows.length; pi++) {
      if (usedPersisted.has(pi)) continue
      const pTabs = persistedWindows[pi].tabs
      let cursor = 0
      let matches = 0
      for (const t of winTabs) {
        const u = normalizeUrl(t.url || t.pendingUrl)
        if (!u) continue
        for (let k = cursor; k < pTabs.length; k++) {
          if (pTabs[k].url === u) {
            matches++
            cursor = k + 1
            break
          }
        }
      }
      if (matches > bestScore) {
        bestScore = matches
        bestIdx = pi
      }
    }

    if (bestIdx === -1) continue
    usedPersisted.add(bestIdx)
    const pTabs = persistedWindows[bestIdx].tabs

    // Reconstruct tree parentId stack & virtual groups in tab order
    const levelStack: number[] = []
    let cursor = 0

    for (const tab of winTabs) {
      if (tab.id === undefined) continue
      if (tab.pinned) {
        levelStack.length = 0
        continue
      }
      const u = normalizeUrl(tab.url || tab.pendingUrl)
      let matched: PersistedTabRecord | undefined
      if (u) {
        for (let k = cursor; k < pTabs.length; k++) {
          if (!pTabs[k].pinned && pTabs[k].url === u) {
            matched = pTabs[k]
            cursor = k + 1
            break
          }
        }
      }

      if (!matched) {
        levelStack[0] = tab.id
        levelStack.length = 1
        continue
      }

      if (matched.virtualGroupId) {
        virtualGroups[tab.id] = matched.virtualGroupId
      }

      const effectiveLvl = Math.min(Math.max(0, matched.level || 0), levelStack.length)
      if (effectiveLvl > 0) {
        treeMeta[tab.id] = {
          parentId: levelStack[effectiveLvl - 1],
          folded: matched.folded || undefined,
        }
      } else if (matched.folded) {
        treeMeta[tab.id] = { folded: true }
      }
      levelStack[effectiveLvl] = tab.id
      levelStack.length = effectiveLvl + 1
    }
  }

  return { treeMeta, virtualGroups }
}

/**
 * Restore persisted tab tree & virtual group state once per browser session (after quit & reopen).
 */
export async function restorePersistedSessionIfNeeded(): Promise<boolean> {
  try {
    const sess = await chrome.storage.session.get([
      STORAGE_KEYS.sessionRestored,
      STORAGE_KEYS.treeMeta,
      STORAGE_KEYS.virtualGroups,
    ])
    if (sess[STORAGE_KEYS.sessionRestored]) return false

    const existingTree = (sess[STORAGE_KEYS.treeMeta] as TabTreeMap) ?? {}
    const existingVGroups = (sess[STORAGE_KEYS.virtualGroups] as Record<number, string>) ?? {}

    // If session already has live state (e.g. service worker woke up mid-session), mark restored
    if (Object.keys(existingTree).length > 0 || Object.keys(existingVGroups).length > 0) {
      await chrome.storage.session.set({ [STORAGE_KEYS.sessionRestored]: true })
      return false
    }

    const stored = await chrome.storage.local.get(STORAGE_KEYS.lastSession)
    const persisted = stored[STORAGE_KEYS.lastSession] as PersistedWindowState[] | undefined
    if (!Array.isArray(persisted) || persisted.length === 0) {
      await chrome.storage.session.set({ [STORAGE_KEYS.sessionRestored]: true })
      return false
    }

    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })
    const { treeMeta, virtualGroups } = matchAndRebuildSession(windows, persisted)

    if (Object.keys(treeMeta).length > 0) {
      await saveTreeMeta(treeMeta)
    }
    if (Object.keys(virtualGroups).length > 0) {
      await saveVirtualGroupMap(virtualGroups)
    }
    await chrome.storage.session.set({ [STORAGE_KEYS.sessionRestored]: true })
    return true
  } catch {
    return false
  }
}

/**
 * Persist current window tab trees & virtual groups to chrome.storage.local
 * so they survive quitting and reopening the browser.
 */
export async function persistCurrentSession(): Promise<void> {
  try {
    const [sess, treeMeta, virtualGroups, windows] = await Promise.all([
      chrome.storage.session.get(STORAGE_KEYS.sessionRestored),
      loadTreeMeta(),
      loadVirtualGroupMap(),
      chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    ])

    // Never overwrite persisted state on cold startup before restoration has run
    const hasLiveMeta =
      Object.keys(treeMeta).length > 0 || Object.keys(virtualGroups).length > 0
    if (!sess[STORAGE_KEYS.sessionRestored] && !hasLiveMeta) {
      return
    }

    const serialized = serializeWindowsState(windows, treeMeta, virtualGroups)
    if (serialized.length > 0) {
      await chrome.storage.local.set({ [STORAGE_KEYS.lastSession]: serialized })
    }
  } catch {
    // Ignore transient errors during window shutdown
  }
}
