import { loadSettings } from './storage'

export const VIVALDI_STARTPAGE_URL = 'chrome://vivaldi-webui/startpage'
const VIVALDI_UI_EXT_ID = 'mpognobbkildjkofajifpdfhcoklimli'
const VIVALDI_DETECTED_KEY = 'vberry_detected_vivaldi'

let cachedIsVivaldi = false

async function persistVivaldiDetected(): Promise<void> {
  cachedIsVivaldi = true
  try {
    await chrome.storage?.local?.set({ [VIVALDI_DETECTED_KEY]: true })
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

function isVivaldiUrl(url?: string): boolean {
  if (!url) return false
  return (
    url.startsWith('chrome://vivaldi-webui/') ||
    url.startsWith('vivaldi://') ||
    url.includes(VIVALDI_UI_EXT_ID)
  )
}

function hasVivaldiProps(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false
  const rec = obj as Record<string, unknown>
  return 'vivExtData' in rec || 'extData' in rec
}

/**
 * Detect whether the extension is running in Vivaldi (macOS, Windows, and Linux).
 * Never caches `false` so late-appearing Vivaldi signals are still picked up,
 * and persists `true` once detected.
 */
export async function isVivaldi(): Promise<boolean> {
  try {
    const settings = await loadSettings()
    if (settings.browserMode === 'vivaldi') return true
    if (settings.browserMode === 'chrome') return false
  } catch {
    // Continue with auto-detection
  }

  if (cachedIsVivaldi) return true

  try {
    const stored = await chrome.storage?.local?.get(VIVALDI_DETECTED_KEY)
    if (stored?.[VIVALDI_DETECTED_KEY] === true) {
      cachedIsVivaldi = true
      return true
    }
  } catch {
    // Ignore
  }

  if (typeof navigator !== 'undefined') {
    if (/vivaldi/i.test(navigator.userAgent)) {
      await persistVivaldiDetected()
      return true
    }
    const brands = (navigator as unknown as { userAgentData?: { brands?: Array<{ brand: string }> } })
      .userAgentData?.brands
    if (Array.isArray(brands) && brands.some(b => /vivaldi/i.test(b.brand))) {
      await persistVivaldiDetected()
      return true
    }
  }

  try {
    const tabs = await chrome.tabs.query({})
    const detectedInTabs = tabs.some(
      t =>
        hasVivaldiProps(t) ||
        isVivaldiUrl(t.url) ||
        isVivaldiUrl(t.pendingUrl) ||
        isVivaldiUrl(t.favIconUrl)
    )
    if (detectedInTabs) {
      await persistVivaldiDetected()
      return true
    }
  } catch {
    // Ignore
  }

  try {
    const wins = await chrome.windows?.getAll?.()
    if (Array.isArray(wins) && wins.some(w => hasVivaldiProps(w))) {
      await persistVivaldiDetected()
      return true
    }
  } catch {
    // Ignore
  }

  return false
}

export function resetVivaldiDetectionCache(): void {
  cachedIsVivaldi = false
}

export async function getDefaultNewTabUrl(): Promise<string | undefined> {
  return (await isVivaldi()) ? VIVALDI_STARTPAGE_URL : undefined
}

/**
 * Create a new tab using the browser's proper start page
 * (`chrome://vivaldi-webui/startpage` on Vivaldi, native NTP on Chrome).
 * If Vivaldi was not yet detected (e.g. masked UA on Windows with no startpage open)
 * and `chrome.tabs.create` lands on `about:blank`, automatically redirects it to
 * Vivaldi's startpage and remembers Vivaldi mode.
 */
export async function createNewTab(props: {
  windowId?: number
  index?: number
  url?: string
  active?: boolean
  pinned?: boolean
  openerTabId?: number
}): Promise<chrome.tabs.Tab> {
  const explicitUrl = props.url
  const resolvedUrl = explicitUrl || (await getDefaultNewTabUrl())
  const createProps: Parameters<typeof chrome.tabs.create>[0] = {
    active: props.active ?? true,
  }
  if (props.windowId !== undefined && props.windowId >= 0) createProps.windowId = props.windowId

  let targetIndex = props.index
  if (targetIndex === undefined && !props.pinned && props.openerTabId === undefined) {
    try {
      const winTabs = await chrome.tabs.query(
        props.windowId !== undefined && props.windowId >= 0
          ? { windowId: props.windowId }
          : { currentWindow: true }
      )
      if (winTabs.length > 0) {
        targetIndex = winTabs.reduce(
          (max, t) => Math.max(max, (typeof t.index === 'number' ? t.index : -1) + 1),
          winTabs.length
        )
      }
    } catch {
      // Fall back to browser default index
    }
  }
  if (targetIndex !== undefined) createProps.index = targetIndex
  if (resolvedUrl) createProps.url = resolvedUrl
  if (props.pinned !== undefined) createProps.pinned = props.pinned
  if (props.openerTabId !== undefined) createProps.openerTabId = props.openerTabId

  const tab = await chrome.tabs.create(createProps)

  // Ensure Vivaldi/browsers with "New Tab Position: After Active Tab" still place VBerry tabs at the bottom
  if (
    targetIndex !== undefined &&
    props.index === undefined &&
    tab.id !== undefined &&
    typeof tab.index === 'number' &&
    tab.index < targetIndex
  ) {
    await chrome.tabs.move?.(tab.id, { index: -1 }).catch(() => {})
  }

  // Runtime Vivaldi fallback: Chrome always opens `chrome://newtab/`, whereas Vivaldi
  // opens `about:blank` (or an empty URL) when `chrome.tabs.create` is called without a URL.
  if (!explicitUrl && !resolvedUrl && tab.id !== undefined) {
    const landed = tab.pendingUrl || tab.url || ''
    if (!landed || landed === 'about:blank') {
      await persistVivaldiDetected()
      await chrome.tabs.update(tab.id, { url: VIVALDI_STARTPAGE_URL }).catch(() => {})
    }
  }

  return tab
}

/**
 * Resolve the active normal browser window ID (handles Vivaldi Web Panel contexts safely).
 */
export async function getTargetWindowId(): Promise<number> {
  try {
    const cur = await chrome.windows.getCurrent()
    if (cur.id !== undefined && cur.type === 'normal') return cur.id
  } catch {
    // Fallback below
  }
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] })
    const focused = wins.find(w => w.focused && w.id !== undefined)
    if (focused?.id !== undefined) return focused.id
    if (wins[0]?.id !== undefined) return wins[0].id
  } catch {
    // Fallback below
  }
  const cur = await chrome.windows.getCurrent().catch(() => undefined)
  return cur?.id ?? -1
}
