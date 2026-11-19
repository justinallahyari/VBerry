export const VIVALDI_STARTPAGE_URL = 'chrome://vivaldi-webui/startpage'

let cachedIsVivaldi: boolean | null = null

/**
 * Detect whether the extension is running in Vivaldi.
 * Checks User-Agent / Client Hints first, then inspects open tabs for Vivaldi's
 * `vivExtData` property or `vivaldi://` / `chrome://vivaldi-webui/` URLs.
 */
export async function isVivaldi(): Promise<boolean> {
  if (cachedIsVivaldi !== null) return cachedIsVivaldi

  if (typeof navigator !== 'undefined') {
    if (/vivaldi/i.test(navigator.userAgent)) {
      cachedIsVivaldi = true
      return true
    }
    const brands = (navigator as unknown as { userAgentData?: { brands?: Array<{ brand: string }> } })
      .userAgentData?.brands
    if (Array.isArray(brands) && brands.some(b => /vivaldi/i.test(b.brand))) {
      cachedIsVivaldi = true
      return true
    }
  }

  try {
    const tabs = await chrome.tabs.query({})
    const detected = tabs.some(t => {
      const url = t.url || t.pendingUrl || ''
      return (
        'vivExtData' in (t as unknown as Record<string, unknown>) ||
        url.startsWith('chrome://vivaldi-webui/') ||
        url.startsWith('vivaldi://')
      )
    })
    cachedIsVivaldi = detected
    return detected
  } catch {
    return false
  }
}

export function resetVivaldiDetectionCache(): void {
  cachedIsVivaldi = null
}

export async function getDefaultNewTabUrl(): Promise<string | undefined> {
  return (await isVivaldi()) ? VIVALDI_STARTPAGE_URL : undefined
}

/**
 * Create a new tab using the browser's proper start page
 * (`chrome://vivaldi-webui/startpage` on Vivaldi, native NTP on Chrome).
 */
export async function createNewTab(props: {
  windowId?: number
  index?: number
  url?: string
  active?: boolean
  pinned?: boolean
  openerTabId?: number
}): Promise<chrome.tabs.Tab> {
  const resolvedUrl = props.url || (await getDefaultNewTabUrl())
  const createProps: Parameters<typeof chrome.tabs.create>[0] = {
    active: props.active ?? true,
  }
  if (props.windowId !== undefined && props.windowId >= 0) createProps.windowId = props.windowId
  if (props.index !== undefined) createProps.index = props.index
  if (resolvedUrl) createProps.url = resolvedUrl
  if (props.pinned !== undefined) createProps.pinned = props.pinned
  if (props.openerTabId !== undefined) createProps.openerTabId = props.openerTabId
  return chrome.tabs.create(createProps)
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
