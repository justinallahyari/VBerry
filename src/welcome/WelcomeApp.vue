<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { isVivaldi } from '@/shared/env'
import { loadSettings } from '@/shared/storage'

const commands = ref<chrome.commands.Command[]>([])
const vivaldiDetected = ref(false)
const copiedUrl = ref(false)
const version = chrome.runtime?.getManifest?.().version ?? '6.5.0'
const sidePanelUrl = chrome.runtime?.getURL?.('sidepanel.html') ?? ''

const RECOMMENDED_ORDER = [
  '_execute_action',
  'toggle_side_panel',
  'new_tab_in_panel',
  'create_snapshot',
  'discard_inactive_tabs',
]

const COMMAND_DETAILS: Record<
  string,
  { title: string; priority?: 'essential' | 'optional'; note: string }
> = {
  _execute_action: {
    title: 'Activate Extension — Quick Search (Frameless Popup)',
    priority: 'essential',
    note: 'Opens the frameless Quick Search popup focused on Unified Search so you can jump to any tab, bookmark, or recent history item instantly.',
  },
  toggle_side_panel: {
    title: 'Toggle VBerry Side Panel',
    priority: 'essential',
    note: 'Opens or closes the persistent vertical tab tree sidebar. You can also right-click the VBerry toolbar button and choose "Open VBerry Side Panel".',
  },
  new_tab_in_panel: {
    title: 'Open New Tab in Active Group',
    priority: 'optional',
    note: 'Creates a new tab directly inside whichever Tab Group panel is currently open in the sidebar.',
  },
  create_snapshot: {
    title: 'Create Tab Snapshot',
    priority: 'optional',
    note: 'Captures a tree-preserving backup of all open windows, pinned tabs, and tab groups.',
  },
  discard_inactive_tabs: {
    title: 'Unload Inactive Tabs',
    priority: 'optional',
    note: 'Frees memory by discarding background tabs in the current window while keeping your tab tree intact.',
  },
}

const orderedCommands = computed(() => {
  const byName = new Map(commands.value.map(c => [c.name ?? '', c]))
  return RECOMMENDED_ORDER.map(name => {
    const cmd = byName.get(name)
    const meta = COMMAND_DETAILS[name]
    return {
      name,
      title: meta?.title ?? cmd?.description ?? name,
      priority: meta?.priority ?? 'optional',
      note: meta?.note ?? '',
      shortcut: cmd?.shortcut || '',
    }
  })
})

async function loadCommands() {
  try {
    commands.value = await chrome.commands.getAll()
  } catch {
    commands.value = []
  }
}

async function openShortcutsPage() {
  const url = vivaldiDetected.value
    ? 'vivaldi://extensions/shortcuts'
    : 'chrome://extensions/shortcuts'
  await chrome.tabs.create({ url, active: true }).catch(() => {})
}

function openSettings() {
  void chrome.runtime.openOptionsPage()
}

async function copyWebPanelUrl() {
  if (!sidePanelUrl) return
  await navigator.clipboard?.writeText(sidePanelUrl).catch(() => {})
  copiedUrl.value = true
  setTimeout(() => {
    copiedUrl.value = false
  }, 1800)
}

onMounted(async () => {
  const [settings, viv] = await Promise.all([loadSettings(), isVivaldi(), loadCommands()])
  vivaldiDetected.value = viv
  const root = document.documentElement
  if (settings.theme === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', settings.theme)
  window.addEventListener('focus', loadCommands)
})

onUnmounted(() => {
  window.removeEventListener('focus', loadCommands)
})
</script>

<template>
  <main class="page">
    <!-- Hero -->
    <header class="hero">
      <div class="hero-top">
        <img class="logo" src="/icons/icon-128.png" alt="VBerry" />
        <div>
          <div class="title-row">
            <h1>Welcome to VBerry</h1>
            <span class="ver-pill">v{{ version }}</span>
          </div>
          <p class="subtitle">
            Vertical tab trees, Tab Group panels, frameless Unified Quick Search, Bookmark Manager,
            and lossless Sidebery v5 import — built natively for Chrome &amp; Vivaldi.
          </p>
        </div>
      </div>

      <div class="hero-actions">
        <button type="button" class="btn-primary" @click="openShortcutsPage">
          Set Up Keyboard Shortcuts…
        </button>
        <button type="button" class="btn-secondary" @click="openSettings">
          Open Settings &amp; Sidebery Import
        </button>
      </div>
    </header>

    <!-- Recommended Shortcuts -->
    <section class="card highlight-card">
      <div class="card-head">
        <div>
          <h2>1. Set Your Essential Shortcuts</h2>
          <p class="hint">
            Chromium extensions can't auto-bind every global shortcut on install. Bind these two
            first in your browser's Shortcuts page — this list updates automatically when you
            return:
          </p>
        </div>
        <button type="button" class="btn-primary" @click="openShortcutsPage">
          Open Shortcuts Page…
        </button>
      </div>

      <div class="cmd-list">
        <div
          v-for="cmd in orderedCommands"
          :key="cmd.name"
          class="cmd-row"
          :class="{ essential: cmd.priority === 'essential' }"
        >
          <div class="cmd-info">
            <div class="cmd-title-line">
              <span class="cmd-title">{{ cmd.title }}</span>
              <span v-if="cmd.priority === 'essential'" class="badge-essential">Recommended</span>
            </div>
            <p class="cmd-note">{{ cmd.note }}</p>
          </div>
          <kbd class="kbd" :class="{ unset: !cmd.shortcut }">
            {{ cmd.shortcut || 'Not set' }}
          </kbd>
        </div>
      </div>

      <div class="popup-keys">
        <span class="keys-label">Inside the Quick Search popup:</span>
        <span><kbd>Tab</kbd> move between controls</span>
        <span><kbd>↑</kbd><kbd>↓</kbd> pick result</span>
        <span><kbd>Enter</kbd> open / select</span>
        <span><kbd>Esc</kbd> clear or close</span>
      </div>
    </section>

    <!-- Toolbar & Vivaldi Tip -->
    <section class="card">
      <h2>2. Pin VBerry to Your Toolbar</h2>
      <p class="hint">
        Click the puzzle icon in your browser's address bar and pin <strong>VBerry</strong>:
      </p>
      <ul class="bullet-list">
        <li>
          <strong>Left-click the VBerry icon</strong> (or press your
          <em>Activate Extension</em> shortcut) to open the frameless
          <strong>Quick Search Popup</strong>.
        </li>
        <li>
          <strong>Right-click the VBerry icon</strong> and select
          <strong>Open VBerry Side Panel</strong> (or press <code>Ctrl+E</code> /
          <code>MacCtrl+E</code>) to open the persistent sidebar.
        </li>
        <li>
          Type <code>=</code> followed by a space in the address bar to search open tabs and
          bookmarks straight from the omnibox.
        </li>
      </ul>

      <div v-if="vivaldiDetected && sidePanelUrl" class="vivaldi-box">
        <div class="vivaldi-head">
          <strong>Vivaldi Web Panel Setup</strong>
          <button type="button" class="btn-mini" @click="copyWebPanelUrl">
            {{ copiedUrl ? 'Copied!' : 'Copy Panel URL' }}
          </button>
        </div>
        <p class="hint">
          In Vivaldi, click <strong>+</strong> in your sidebar and add this URL as a Web Panel for
          a persistent vertical tab sidebar:
        </p>
        <code class="url-code">{{ sidePanelUrl }}</code>
      </div>
    </section>

    <!-- Feature Overview -->
    <section class="card">
      <h2>3. What VBerry Offers</h2>
      <div class="feature-grid">
        <div class="feat">
          <h3>Frameless Quick Search &amp; Unified Search</h3>
          <p>
            Search open Tabs, Bookmarks, and History in one ranked list (ordered Tabs → Bookmarks →
            History), with instant Recent Bookmarks MRU before you type, per-source toggles, and an
            adjustable History time range (default: 7 days).
          </p>
        </div>

        <div class="feat">
          <h3>Vertical Tab Trees &amp; Tab Group Panels</h3>
          <p>
            Auto-nests child tabs under their opener, supports drag-and-drop nesting, folding,
            multi-select, and 1:1 Chrome Tab Groups as panels (with automatic virtual group panels
            and Start Page support on Vivaldi).
          </p>
        </div>

        <div class="feat">
          <h3>Full Bookmark Manager</h3>
          <p>
            Browse, search, add, edit, drag-and-drop reorder/nest, sort A–Z, and open whole folders
            into Tab Groups — with Vivaldi's Trash bookmark folder excluded automatically
            everywhere.
          </p>
        </div>

        <div class="feat">
          <h3>Tree-Preserving Snapshots &amp; History</h3>
          <p>
            Save manual or scheduled auto-snapshots of your windows, tab trees, and groups; restore
            selectively or export to Markdown; browse recent History and Recently Closed sessions.
          </p>
        </div>

        <div class="feat">
          <h3>Lossless Sidebery v5 Import</h3>
          <p>
            Import original Firefox Sidebery JSON backups and delta-compressed snapshots in
            Settings — preserving panel colors, URL auto-group move rules, compatible settings, and
            custom CSS.
          </p>
        </div>

        <div class="feat">
          <h3>Deep Appearance &amp; Behavior Control</h3>
          <p>
            Customize theme, compact/comfortable density, font &amp; icon sizes, search behavior,
            tree-safe tab unloading, "Send to VBerry Group" page/link context menus, and Custom
            Sidebar CSS.
          </p>
        </div>
      </div>
    </section>

    <footer class="footer">
      <button type="button" class="btn-secondary" @click="openSettings">
        Customize VBerry in Settings
      </button>
    </footer>
  </main>
</template>

<style scoped>
.page {
  max-width: 820px;
  margin: 0 auto;
  padding: 28px 20px 56px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.hero {
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.hero-top {
  display: flex;
  align-items: center;
  gap: 16px;
}

.logo {
  width: 56px;
  height: 56px;
  border-radius: 12px;
  flex-shrink: 0;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.title-row h1 {
  margin: 0;
  font-size: 24px;
}

.ver-pill {
  padding: 2px 8px;
  border-radius: 99px;
  background: var(--bg-active);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}

.subtitle {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 13.5px;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.card {
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.highlight-card {
  border-color: var(--accent);
}

.card h2 {
  margin: 0;
  font-size: 16px;
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.hint {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 12.5px;
}

.cmd-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cmd-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
}

.cmd-row.essential {
  border-color: var(--accent);
}

.cmd-info {
  min-width: 0;
}

.cmd-title-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.cmd-title {
  font-weight: 600;
  font-size: 13px;
}

.badge-essential {
  padding: 1px 7px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 10.5px;
  font-weight: 600;
}

.cmd-note {
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: 12px;
}

.kbd {
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
}

.kbd.unset {
  color: var(--text-muted);
  border-style: dashed;
}

.popup-keys {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-muted);
}

.keys-label {
  font-weight: 600;
  color: var(--text);
}

.popup-keys kbd {
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-subtle);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  margin-right: 2px;
}

.bullet-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.bullet-list code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.vivaldi-box {
  margin-top: 4px;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.vivaldi-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.url-code {
  display: block;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  word-break: break-all;
  user-select: all;
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px;
}

.feat {
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
}

.feat h3 {
  margin: 0 0 6px;
  font-size: 13.5px;
}

.feat p {
  margin: 0;
  color: var(--text-muted);
  font-size: 12.2px;
  line-height: 1.45;
}

.btn-primary,
.btn-secondary,
.btn-mini {
  border-radius: 7px;
  cursor: pointer;
  font-weight: 500;
  white-space: nowrap;
}

.btn-primary {
  padding: 8px 14px;
  border: none;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 13px;
}

.btn-secondary {
  padding: 8px 14px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
}

.btn-secondary:hover,
.btn-mini:hover {
  background: var(--bg-hover);
}

.btn-mini {
  padding: 4px 9px;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  color: var(--text);
  font-size: 11.5px;
}

.footer {
  display: flex;
  justify-content: center;
}
</style>
