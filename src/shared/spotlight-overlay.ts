import type { PanelShortcuts, SpotlightGroup, SpotlightItem, SpotlightView } from './types'

export interface SpotlightOverlayConfig {
  windowId: number
  view: SpotlightView
  theme: 'auto' | 'light' | 'dark'
  density: 'compact' | 'comfortable'
  fontSize: number
  iconSize: number
  uiIconSize: number
  tabControlIconSize: number
  showTabCounts: boolean
  showBookmarksPanel: boolean
  showHistoryPanel: boolean
  autoHighlight: boolean
  clearOnPanelSwitch: boolean
  panelShortcuts: PanelShortcuts
  requireFocus?: boolean
}

/**
 * Self-contained function injected into the active tab via chrome.scripting.executeScript.
 * MUST NOT reference any outer-scope runtime values or imports so Chromium can serialize it cleanly.
 * Returns `true` when the overlay is mounted and focused, or `false` if the browser refused to
 * move keyboard focus to the page (so the caller can fall back to the Floating Popup).
 */
export async function mountSpotlightOverlay(config: SpotlightOverlayConfig): Promise<boolean> {
  const HOST_ID = 'vberry-spotlight-host'
  const existing = document.getElementById(HOST_ID)
  if (existing) {
    existing.dispatchEvent(new CustomEvent('vberry-spotlight-update', { detail: config }))
    await new Promise<void>(r => requestAnimationFrame(() => r()))
    return !config.requireFocus || document.hasFocus()
  }

  const prevActive = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const isDark =
    config.theme === 'dark' ||
    (config.theme === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  const tabBaseH = config.density === 'compact' ? 26 : 32
  const tabPadIcon = config.density === 'compact' ? 8 : 12
  const tabPadFont = config.density === 'compact' ? 10 : 14

  let currentView: SpotlightView = config.view
  let activeGroupKey: string | undefined = undefined
  const expandedFolders = new Set<string>(['1', '2'])
  let groups: SpotlightGroup[] = []
  let items: SpotlightItem[] = []
  let cursor = -1
  let querySeq = 0
  let closed = false

  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;pointer-events:auto;margin:0;padding:0;border:0;'
  const shadow = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = `
    :host {
      color-scheme: ${isDark ? 'dark' : 'light'};
      --bg: ${isDark ? '#202124' : '#ffffff'};
      --bg-subtle: ${isDark ? '#292a2d' : '#f1f3f4'};
      --bg-hover: ${isDark ? '#35363a' : '#e8eaed'};
      --bg-active: ${isDark ? '#394457' : '#d2e3fc'};
      --bg-selected: ${isDark ? '#2d3748' : '#e8f0fe'};
      --border: ${isDark ? '#3c4043' : '#dadce0'};
      --text: ${isDark ? '#e8eaed' : '#202124'};
      --text-muted: ${isDark ? '#9aa0a6' : '#5f6368'};
      --accent: ${isDark ? '#8ab4f8' : '#1a73e8'};
      --accent-text: ${isDark ? '#202124' : '#ffffff'};
      --grp-grey: ${isDark ? '#dadce0' : '#5f6368'};
      --grp-blue: ${isDark ? '#8ab4f8' : '#1a73e8'};
      --grp-red: ${isDark ? '#f28b82' : '#d93025'};
      --grp-yellow: ${isDark ? '#fdd663' : '#e37400'};
      --grp-green: ${isDark ? '#81c995' : '#188038'};
      --grp-pink: ${isDark ? '#ff8bcb' : '#d01884'};
      --grp-purple: ${isDark ? '#c58af9' : '#9334e6'};
      --grp-cyan: ${isDark ? '#78d9ec' : '#007b83'};
      --grp-orange: ${isDark ? '#fcad70' : '#fa7b17'};
      --font-size: ${config.fontSize}px;
      --icon-size: ${config.iconSize}px;
      --ui-icon-size: ${config.uiIconSize}px;
      --tab-ctrl-icon-size: ${config.tabControlIconSize}px;
      --tab-h: max(${tabBaseH}px, calc(var(--icon-size) + ${tabPadIcon}px), calc(var(--font-size) + ${tabPadFont}px));
      --font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      all: initial;
      font-family: var(--font);
      font-size: var(--font-size);
      line-height: 1.4;
      color: var(--text);
      -webkit-font-smoothing: antialiased;
    }
    * { box-sizing: border-box; }
    button, input { font: inherit; color: inherit; }
    .backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.36);
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 10vh;
    }
    .shell {
      width: min(520px, 92vw);
      height: min(540px, 78vh);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: ${isDark ? '0 14px 44px rgba(0, 0, 0, 0.6)' : '0 14px 44px rgba(0, 0, 0, 0.24)'};
    }
    .panel-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
      padding: 6px 8px 4px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-subtle);
    }
    .panel-strip {
      display: flex;
      align-items: center;
      gap: 4px;
      overflow-x: auto;
      flex: 1;
      scrollbar-width: none;
    }
    .panel-strip::-webkit-scrollbar { display: none; }
    .utility-strip {
      display: flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
      padding-left: 4px;
      border-left: 1px solid var(--border);
    }
    .panel-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 26px;
      padding: 0 8px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: var(--text);
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      font-size: 12px;
    }
    .panel-pill:hover { background: var(--bg-hover); }
    .panel-pill.active {
      background: var(--bg);
      border-color: var(--border);
      font-weight: 600;
    }
    .pill-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .pill-label {
      max-width: 96px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .pill-count {
      font-size: 10.5px;
      color: var(--text-muted);
    }
    .icon-btn {
      width: calc(var(--ui-icon-size) + 7px);
      height: calc(var(--ui-icon-size) + 7px);
      padding: 0;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .icon-btn svg {
      width: var(--ui-icon-size);
      height: var(--ui-icon-size);
    }
    .icon-btn:hover,
    .icon-btn.active {
      background: var(--bg-hover);
      color: var(--text);
    }
    .search-bar {
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
    }
    .search-input {
      width: 100%;
      height: 28px;
      padding: 0 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-subtle);
      color: var(--text);
      outline: none;
      font-size: 12.5px;
    }
    .search-input:focus {
      border-color: var(--accent);
      background: var(--bg);
    }
    .search-input::placeholder { color: var(--text-muted); }
    .list {
      flex: 1;
      overflow-y: auto;
      padding: 4px 6px 8px;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .list::-webkit-scrollbar { width: 6px; height: 6px; }
    .list::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 3px;
    }
    .row {
      position: relative;
      display: flex;
      align-items: center;
      gap: 6px;
      height: var(--tab-h);
      padding: 0 6px;
      border-radius: 6px;
      cursor: pointer;
      user-select: none;
      flex-shrink: 0;
    }
    .row:hover { background: var(--bg-hover); }
    .row.active {
      background: var(--bg-active);
      font-weight: 500;
    }
    .row.discarded { opacity: 0.58; }
    .row.search-focus {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
      background: var(--bg-selected);
    }
    .row.active.search-focus { background: var(--bg-active); }
    .tree-guide {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 1px;
      background: var(--border);
      pointer-events: none;
    }
    .tab-icon-slot {
      position: relative;
      width: max(24px, var(--icon-size), calc(var(--tab-ctrl-icon-size) + 12px));
      height: max(24px, var(--icon-size), calc(var(--tab-ctrl-icon-size) + 12px));
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .fold-btn {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      padding: 0;
      border: 1px solid var(--border);
      background: var(--bg-subtle);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border-radius: 4px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.1s;
    }
    .row:hover .tab-icon-slot.has-children .fold-btn {
      opacity: 1;
      pointer-events: auto;
    }
    .row:hover .tab-icon-slot.has-children .favicon,
    .row:hover .tab-icon-slot.has-children .favicon-fallback {
      opacity: 0;
    }
    .chevron {
      width: var(--tab-ctrl-icon-size);
      height: var(--tab-ctrl-icon-size);
      transition: transform 0.12s;
    }
    .chevron.folded { transform: rotate(-90deg); }
    .favicon {
      width: var(--icon-size);
      height: var(--icon-size);
      border-radius: 3px;
      flex-shrink: 0;
      object-fit: contain;
      transition: opacity 0.1s;
    }
    .favicon-fallback {
      width: var(--icon-size);
      height: var(--icon-size);
      font-size: calc(var(--icon-size) * 0.5);
      color: var(--text-muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: opacity 0.1s;
    }
    .folder-icon {
      font-size: 12px;
      color: var(--text-muted);
      flex-shrink: 0;
    }
    .tab-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text);
    }
    .branch-badge {
      font-size: 11px;
      padding: 0 5px;
      border-radius: 99px;
      background: var(--bg-subtle);
      color: var(--text-muted);
      flex-shrink: 0;
    }
    .group-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
      font-size: 11px;
      padding: 0 6px;
      height: 18px;
      border-radius: 99px;
      background: var(--bg-subtle);
      color: var(--text-muted);
      max-width: 110px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .empty {
      padding: 32px 16px;
      text-align: center;
      color: var(--text-muted);
      font-size: 12.5px;
    }
  `

  const SVG_NS = 'http://www.w3.org/2000/svg'
  function makeSvg(
    children: Array<[string, Record<string, string>]>,
    className?: string
  ): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('aria-hidden', 'true')
    if (className) svg.setAttribute('class', className)
    for (const [tag, attrs] of children) {
      const el = document.createElementNS(SVG_NS, tag)
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
      svg.appendChild(el)
    }
    return svg
  }

  const backdrop = document.createElement('div')
  backdrop.className = 'backdrop'

  const shell = document.createElement('div')
  shell.className = 'shell'

  const panelBar = document.createElement('header')
  panelBar.className = 'panel-bar'

  const panelStrip = document.createElement('div')
  panelStrip.className = 'panel-strip'

  const utilityStrip = document.createElement('div')
  utilityStrip.className = 'utility-strip'

  let bookmarksBtn: HTMLButtonElement | null = null
  if (config.showBookmarksPanel) {
    bookmarksBtn = document.createElement('button')
    bookmarksBtn.type = 'button'
    bookmarksBtn.className = 'icon-btn'
    bookmarksBtn.title = 'Bookmarks'
    bookmarksBtn.appendChild(
      makeSvg([
        [
          'path',
          {
            d: 'M8 1.5 9.95 5.45l4.35.63-3.15 3.07.74 4.35L8 11.45 4.11 13.5l.74-4.35L1.7 6.08l4.35-.63Z',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': '1.5',
            'stroke-linejoin': 'round',
          },
        ],
      ])
    )
    bookmarksBtn.addEventListener('click', () => switchView('bookmarks'))
    utilityStrip.appendChild(bookmarksBtn)
  }

  let historyBtn: HTMLButtonElement | null = null
  if (config.showHistoryPanel) {
    historyBtn = document.createElement('button')
    historyBtn.type = 'button'
    historyBtn.className = 'icon-btn'
    historyBtn.title = 'History & Recently Closed'
    historyBtn.appendChild(
      makeSvg([
        [
          'circle',
          {
            cx: '8',
            cy: '8',
            r: '6.25',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': '1.6',
          },
        ],
        [
          'path',
          {
            d: 'M8 4.2v4l2.8 1.8',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': '1.6',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          },
        ],
      ])
    )
    historyBtn.addEventListener('click', () => switchView('history'))
    utilityStrip.appendChild(historyBtn)
  }

  panelBar.append(panelStrip, utilityStrip)

  const searchBar = document.createElement('div')
  searchBar.className = 'search-bar'
  const input = document.createElement('input')
  input.type = 'search'
  input.className = 'search-input'
  input.autocomplete = 'off'
  input.spellcheck = false
  searchBar.appendChild(input)

  const listEl = document.createElement('div')
  listEl.className = 'list'

  shell.append(panelBar, searchBar, listEl)
  backdrop.appendChild(shell)
  shadow.append(style, backdrop)

  function updatePlaceholder() {
    if (currentView === 'bookmarks') input.placeholder = 'Search bookmarks…'
    else if (currentView === 'history') input.placeholder = 'Search history…'
    else input.placeholder = 'Search tabs…'
  }

  function renderPanelBar() {
    panelStrip.textContent = ''
    const displayGroups: SpotlightGroup[] = groups.length
      ? groups
      : [{ key: 'ungrouped', title: 'Tabs', count: 0 }]

    for (const grp of displayGroups) {
      const pill = document.createElement('button')
      pill.type = 'button'
      pill.className = 'panel-pill'
      if (currentView === 'tabs' && activeGroupKey === grp.key) {
        pill.classList.add('active')
      }
      if (grp.color) {
        const dot = document.createElement('span')
        dot.className = 'pill-dot'
        dot.style.background = `var(--grp-${grp.color})`
        pill.appendChild(dot)
      }
      const label = document.createElement('span')
      label.className = 'pill-label'
      label.textContent = grp.title
      pill.appendChild(label)
      if (config.showTabCounts && grp.count > 0) {
        const cnt = document.createElement('span')
        cnt.className = 'pill-count'
        cnt.textContent = String(grp.count)
        pill.appendChild(cnt)
      }
      pill.addEventListener('click', () => {
        activeGroupKey = grp.key
        switchView('tabs')
      })
      panelStrip.appendChild(pill)
    }

    bookmarksBtn?.classList.toggle('active', currentView === 'bookmarks')
    historyBtn?.classList.toggle('active', currentView === 'history')
    updatePlaceholder()
  }

  function formatShortcutEvent(e: KeyboardEvent): string | null {
    const mods: string[] = []
    if (e.ctrlKey) mods.push('Ctrl')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')
    if (e.metaKey) mods.push('Meta')
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null
    let key = ''
    if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5)
    else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
    else if (/^F([1-9]|1[0-2])$/.test(e.code)) key = e.code
    else if (e.key === ' ') key = 'Space'
    else if (e.key.length === 1) key = e.key.toUpperCase()
    else key = e.key
    return [...mods, key].join('+')
  }

  function matchesShortcutString(e: KeyboardEvent, shortcut: string): boolean {
    const target = shortcut.trim()
    if (!target) return false
    const actual = formatShortcutEvent(e)
    return actual !== null && actual.toLowerCase() === target.toLowerCase()
  }

  function cleanup(restoreFocus: boolean) {
    if (closed) return
    closed = true
    window.removeEventListener('keydown', onWindowKeyDown, true)
    host.remove()
    if (restoreFocus && prevActive?.isConnected) {
      prevActive.focus()
    }
  }

  function scrollCursorIntoView() {
    if (cursor < 0) return
    const el = listEl.children[cursor]
    if (el instanceof HTMLElement) {
      el.scrollIntoView?.({ block: 'nearest' })
    }
  }

  function syncHighlight() {
    const rows = listEl.querySelectorAll('.row')
    rows.forEach((el, idx) => {
      el.classList.toggle('search-focus', idx === cursor)
    })
    scrollCursorIntoView()
  }

  function appendIcon(parent: HTMLElement, favIconUrl?: string) {
    if (favIconUrl && /^(https?:|data:|chrome-extension:)/i.test(favIconUrl)) {
      const img = document.createElement('img')
      img.className = 'favicon'
      img.src = favIconUrl
      img.alt = ''
      img.addEventListener('error', () => {
        img.style.visibility = 'hidden'
      })
      parent.appendChild(img)
    } else {
      const dot = document.createElement('span')
      dot.className = 'favicon-fallback'
      dot.textContent = '•'
      parent.appendChild(dot)
    }
  }

  function renderList() {
    listEl.textContent = ''
    const isSearching = input.value.trim().length > 0
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = isSearching
        ? currentView === 'bookmarks'
          ? 'No matching bookmarks.'
          : currentView === 'history'
            ? 'No matching history.'
            : 'No matching tabs.'
        : currentView === 'bookmarks'
          ? 'No bookmarks.'
          : currentView === 'history'
            ? 'No recent history.'
            : 'No tabs in this panel.'
      listEl.appendChild(empty)
      return
    }

    items.forEach((item, idx) => {
      const row = document.createElement('div')
      row.className = 'row'
      if (item.active) row.classList.add('active')
      if (item.discarded) row.classList.add('discarded')
      if (idx === cursor) row.classList.add('search-focus')
      row.title = item.url ? `${item.title}\n${item.url}` : item.title

      const level = item.level ?? 0
      if (currentView === 'tabs' && !isSearching) {
        row.style.paddingLeft = `${6 + level * 16}px`
        for (let d = 0; d < level; d++) {
          const guide = document.createElement('span')
          guide.className = 'tree-guide'
          guide.style.left = `${13 + d * 16}px`
          row.appendChild(guide)
        }

        const slot = document.createElement('span')
        slot.className = item.hasChildren ? 'tab-icon-slot has-children' : 'tab-icon-slot'
        appendIcon(slot, item.favIconUrl)

        if (item.hasChildren && item.tabId !== undefined) {
          const foldBtn = document.createElement('button')
          foldBtn.type = 'button'
          foldBtn.className = 'fold-btn'
          foldBtn.title = item.folded ? 'Expand branch' : 'Collapse branch'
          foldBtn.appendChild(
            makeSvg(
              [
                [
                  'path',
                  {
                    d: 'M4 6l4 4 4-4',
                    fill: 'none',
                    stroke: 'currentColor',
                    'stroke-width': '1.8',
                    'stroke-linecap': 'round',
                    'stroke-linejoin': 'round',
                  },
                ],
              ],
              item.folded ? 'chevron folded' : 'chevron'
            )
          )
          const tabId = item.tabId
          foldBtn.addEventListener('mousedown', e => e.stopPropagation())
          foldBtn.addEventListener('click', e => {
            e.stopPropagation()
            void chrome.runtime
              .sendMessage({ type: 'vberry:spotlight-toggle-fold', tabId })
              .then(() => runQuery(false))
              .catch(() => {})
          })
          slot.appendChild(foldBtn)
        }
        row.appendChild(slot)
      } else if (currentView === 'bookmarks' && !isSearching) {
        row.style.paddingLeft = `${8 + level * 14}px`
        if (item.kind === 'folder') {
          const folderIcon = document.createElement('span')
          folderIcon.className = 'folder-icon'
          folderIcon.textContent = item.expanded ? '▾ 📁' : '▸ 📁'
          row.appendChild(folderIcon)
        } else {
          appendIcon(row, item.favIconUrl)
        }
      } else {
        appendIcon(row, item.favIconUrl)
      }

      const title = document.createElement('span')
      title.className = 'tab-title'
      title.textContent = item.title || item.url || '(Untitled)'
      row.appendChild(title)

      if (item.folded && item.childCount && item.childCount > 0) {
        const badge = document.createElement('span')
        badge.className = 'branch-badge'
        badge.textContent = `+${item.childCount}`
        row.appendChild(badge)
      }

      if (isSearching && item.groupTitle) {
        const chip = document.createElement('span')
        chip.className = 'group-chip'
        if (item.groupColor) {
          const dot = document.createElement('span')
          dot.className = 'pill-dot'
          dot.style.background = `var(--grp-${item.groupColor})`
          chip.appendChild(dot)
        }
        chip.appendChild(document.createTextNode(item.groupTitle))
        row.appendChild(chip)
      }

      row.addEventListener('mouseenter', () => {
        cursor = idx
        syncHighlight()
      })
      if (item.kind === 'tab') {
        row.addEventListener('mousedown', e => {
          if (e.button === 0) activateItem(item)
        })
      } else {
        row.addEventListener('click', () => activateItem(item))
      }
      listEl.appendChild(row)
    })
    scrollCursorIntoView()
  }

  function activateItem(item: SpotlightItem) {
    if (item.kind === 'folder' && item.folderId) {
      if (expandedFolders.has(item.folderId)) expandedFolders.delete(item.folderId)
      else expandedFolders.add(item.folderId)
      void runQuery(false)
      return
    }
    cleanup(false)
    chrome.runtime
      .sendMessage({
        type: 'vberry:spotlight-activate',
        kind: item.kind,
        tabId: item.tabId,
        url: item.url,
        windowId: config.windowId,
      })
      .catch(() => {})
  }

  async function runQuery(resetCursor = true) {
    const seq = ++querySeq
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'vberry:spotlight-query',
        query: input.value,
        view: currentView,
        windowId: config.windowId,
        groupKey: activeGroupKey,
        expandedFolderIds: [...expandedFolders],
      })) as { items?: SpotlightItem[]; groups?: SpotlightGroup[]; activeGroupKey?: string } | undefined
      if (closed || seq !== querySeq) return
      if (Array.isArray(res?.groups)) {
        groups = res.groups
        if (!activeGroupKey || !groups.some(g => g.key === activeGroupKey)) {
          activeGroupKey = res.activeGroupKey || groups[0]?.key || 'ungrouped'
        }
        renderPanelBar()
      }
      items = Array.isArray(res?.items) ? res.items : []
      if (resetCursor) {
        cursor =
          items.length > 0 && config.autoHighlight && input.value.trim().length > 0 ? 0 : -1
      } else if (cursor >= items.length) {
        cursor = items.length - 1
      }
      renderList()
    } catch {
      if (closed || seq !== querySeq) return
      items = []
      cursor = -1
      renderList()
    }
  }

  function switchView(nextView: SpotlightView) {
    currentView = nextView
    if (config.clearOnPanelSwitch) input.value = ''
    renderPanelBar()
    input.focus()
    void runQuery(true)
  }

  function onWindowKeyDown(e: KeyboardEvent) {
    if (closed) return
    e.stopImmediatePropagation()

    if (e.key === 'Escape') {
      e.preventDefault()
      if (input.value) {
        input.value = ''
        void runQuery(true)
      } else {
        cleanup(true)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (items.length) {
        cursor = cursor < 0 ? 0 : (cursor + 1) % items.length
        syncHighlight()
      }
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (items.length) {
        cursor = cursor < 0 ? items.length - 1 : (cursor - 1 + items.length) % items.length
        syncHighlight()
      }
      return
    }
    if (e.key === 'Enter') {
      if (items.length && (cursor >= 0 || input.value.trim())) {
        e.preventDefault()
        const idx = cursor >= 0 ? Math.min(cursor, items.length - 1) : 0
        activateItem(items[idx])
      }
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const order: SpotlightView[] = ['tabs']
      if (config.showBookmarksPanel) order.push('bookmarks')
      if (config.showHistoryPanel) order.push('history')
      const idx = order.indexOf(currentView)
      const next = order[(idx + (e.shiftKey ? -1 : 1) + order.length) % order.length]
      switchView(next)
      return
    }
    if (matchesShortcutString(e, config.panelShortcuts.tabs)) {
      e.preventDefault()
      switchView('tabs')
    } else if (matchesShortcutString(e, config.panelShortcuts.bookmarks)) {
      e.preventDefault()
      switchView('bookmarks')
    } else if (matchesShortcutString(e, config.panelShortcuts.history)) {
      e.preventDefault()
      switchView('history')
    }
  }

  backdrop.addEventListener('mousedown', e => {
    if (e.target === backdrop) cleanup(true)
  })
  input.addEventListener('input', () => {
    void runQuery(true)
  })
  host.addEventListener('vberry-spotlight-update', ev => {
    const detail = (ev as CustomEvent<SpotlightOverlayConfig>).detail
    if (detail?.view && detail.view !== currentView) {
      switchView(detail.view)
    } else {
      window.focus()
      input.focus()
      input.select()
    }
  })

  window.addEventListener('keydown', onWindowKeyDown, true)
  document.documentElement.appendChild(host)
  renderPanelBar()
  window.focus()
  input.focus()
  void runQuery(true)

  await new Promise<void>(r => requestAnimationFrame(() => r()))
  if (!closed) {
    window.focus()
    input.focus()
    if (config.requireFocus && !document.hasFocus()) {
      cleanup(false)
      return false
    }
  }
  return true
}
