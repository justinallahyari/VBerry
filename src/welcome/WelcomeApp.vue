<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { isVivaldi } from '@/shared/env'
import { loadSettings } from '@/shared/storage'

const commands = ref<chrome.commands.Command[]>([])
const vivaldiDetected = ref(false)
const copiedUrl = ref(false)
const showMoreShortcuts = ref(false)
const sidePanelUrl = chrome.runtime?.getURL?.('sidepanel.html') ?? ''

interface CommandCard {
  name: string
  title: string
  note: string
  shortcut: string
}

const ESSENTIAL_COMMANDS = [
  {
    name: '_execute_action',
    title: 'Open Quick Search',
    note: 'Pop open instant search from anywhere to jump to an open tab, bookmark, or recent page.',
  },
  {
    name: 'toggle_side_panel',
    title: 'Toggle Side Panel',
    note: 'Open or hide your vertical tab tree sidebar without taking your hands off the keyboard.',
  },
] as const

const OPTIONAL_COMMANDS = [
  {
    name: 'new_tab_in_panel',
    title: 'New Tab in Active Group',
    note: 'Open a new tab right inside the group you are currently viewing.',
  },
  {
    name: 'create_snapshot',
    title: 'Save Tab Snapshot',
    note: 'Save a copy of your open windows, tab trees, and groups in one keystroke.',
  },
  {
    name: 'discard_inactive_tabs',
    title: 'Unload Inactive Tabs',
    note: 'Free up memory by putting background tabs to sleep while keeping your tab tree intact.',
  },
] as const

function buildCommandCards(
  defs: ReadonlyArray<{ name: string; title: string; note: string }>
): CommandCard[] {
  const byName = new Map(commands.value.map(c => [c.name ?? '', c]))
  return defs.map(def => ({
    ...def,
    shortcut: byName.get(def.name)?.shortcut || '',
  }))
}

const essentialCards = computed(() => buildCommandCards(ESSENTIAL_COMMANDS))
const optionalCards = computed(() => buildCommandCards(OPTIONAL_COMMANDS))

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
          <h1>Welcome to VBerry</h1>
          <p class="subtitle">
            Keep your tabs organized in tidy vertical trees, jump to any tab or bookmark in a
            keystroke, and save your browsing sessions with one click.
          </p>
        </div>
      </div>

      <div class="hero-actions">
        <button type="button" class="btn-primary" @click="openShortcutsPage">
          Set Up Shortcuts…
        </button>
        <button type="button" class="btn-secondary" @click="openSettings">Open Settings</button>
      </div>
    </header>

    <!-- Step 1: Shortcuts -->
    <section class="card highlight-card">
      <div class="card-head">
        <div>
          <span class="step-tag">Step 1</span>
          <h2>Set Your Two Favorite Shortcuts</h2>
          <p class="hint">
            Pick the keys you want to use in your browser's shortcuts settings — this list updates
            automatically when you come back.
          </p>
        </div>
        <button type="button" class="btn-primary" @click="openShortcutsPage">
          Open Shortcuts…
        </button>
      </div>

      <div class="cmd-list">
        <div v-for="cmd in essentialCards" :key="cmd.name" class="cmd-row essential">
          <div class="cmd-info">
            <div class="cmd-title-line">
              <span class="cmd-title">{{ cmd.title }}</span>
              <span class="badge-essential">Recommended</span>
            </div>
            <p class="cmd-note">{{ cmd.note }}</p>
          </div>
          <kbd class="kbd" :class="{ unset: !cmd.shortcut }">
            {{ cmd.shortcut || 'Not set' }}
          </kbd>
        </div>
      </div>

      <div class="more-wrap">
        <button
          type="button"
          class="more-toggle"
          @click="showMoreShortcuts = !showMoreShortcuts"
        >
          {{ showMoreShortcuts ? 'Hide optional shortcuts' : 'Show 3 more optional shortcuts' }}
        </button>

        <div v-if="showMoreShortcuts" class="cmd-list optional-list">
          <div v-for="cmd in optionalCards" :key="cmd.name" class="cmd-row">
            <div class="cmd-info">
              <div class="cmd-title">{{ cmd.title }}</div>
              <p class="cmd-note">{{ cmd.note }}</p>
            </div>
            <kbd class="kbd" :class="{ unset: !cmd.shortcut }">
              {{ cmd.shortcut || 'Not set' }}
            </kbd>
          </div>
        </div>
      </div>

      <div class="popup-keys">
        <span class="keys-label">Inside Quick Search:</span>
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>Enter</kbd> open</span>
        <span><kbd>Tab</kbd> switch sections</span>
        <span><kbd>Esc</kbd> clear or close</span>
      </div>
    </section>

    <!-- Step 2: Pin to Toolbar -->
    <section class="card">
      <span class="step-tag">Step 2</span>
      <h2>Pin VBerry to Your Toolbar</h2>
      <p class="hint">
        Click the puzzle icon in your browser toolbar and pin <strong>VBerry</strong> for instant
        access:
      </p>

      <div class="quick-tips">
        <div class="quick-tip">
          <strong>Left-click the VBerry icon</strong>
          <p>Opens Quick Search so you can jump straight to any tab, bookmark, or recent page.</p>
        </div>
        <div class="quick-tip">
          <strong>Right-click the VBerry icon</strong>
          <p>Choose <em>Open VBerry Side Panel</em> to dock your vertical tab tree on the side.</p>
        </div>
        <div v-if="!vivaldiDetected" class="quick-tip">
          <strong>Type <code>=</code> + Space in the address bar</strong>
          <p>Search your open tabs and bookmarks right from your browser's URL bar.</p>
        </div>
      </div>

      <div v-if="vivaldiDetected && sidePanelUrl" class="vivaldi-box">
        <div class="vivaldi-head">
          <strong>Using Vivaldi? Dock VBerry in your sidebar</strong>
          <button type="button" class="btn-mini" @click="copyWebPanelUrl">
            {{ copiedUrl ? 'Copied!' : 'Copy Panel Link' }}
          </button>
        </div>
        <p class="hint">
          Click <strong>+</strong> in Vivaldi's sidebar and paste this link as a Web Panel to keep
          your vertical tabs open alongside your pages:
        </p>
        <code class="url-code">{{ sidePanelUrl }}</code>
      </div>
    </section>

    <!-- Step 3: Features -->
    <section class="card">
      <span class="step-tag">Explore</span>
      <h2>What You Can Do with VBerry</h2>

      <div class="feature-grid">
        <div class="feat">
          <div class="feat-head">
            <svg class="feat-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <line x1="20" y1="20" x2="16.2" y2="16.2" />
            </svg>
            <h3>Instant Quick Search</h3>
          </div>
          <p>
            Search your open tabs, bookmarks, and recent history in one fast list. Your most recent
            bookmarks are waiting the moment you open it.
          </p>
        </div>

        <div class="feat">
          <div class="feat-head">
            <svg class="feat-icon" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="3" y="4" width="18" height="4" rx="1.5" />
              <rect x="7" y="10.5" width="14" height="4" rx="1.5" />
              <rect x="11" y="17" width="10" height="4" rx="1.5" />
            </svg>
            <h3>Vertical Tab Trees &amp; Groups</h3>
          </div>
          <p>
            Links you open nest neatly under their source tab. Drag and drop to reorder, fold whole
            branches out of the way, and organize projects into color-coded groups.
          </p>
        </div>

        <div class="feat">
          <div class="feat-head">
            <svg class="feat-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1z" />
            </svg>
            <h3>Built-in Bookmark Manager</h3>
          </div>
          <p>
            Browse, search, edit, sort, and drag-and-drop your bookmarks right from the sidebar —
            or open an entire bookmark folder into a group with one click.
          </p>
        </div>

        <div class="feat">
          <div class="feat-head">
            <svg class="feat-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" />
              <polyline points="12 7.5 12 12 15.5 14" />
            </svg>
            <h3>Snapshots &amp; History</h3>
          </div>
          <p>
            Save snapshots of your open windows and tab trees manually or on a schedule, restore
            just the tabs you need, export to Markdown, or reopen recently closed tabs.
          </p>
        </div>

        <div class="feat">
          <div class="feat-head">
            <svg class="feat-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h16M7 12h10M10 18h4" />
            </svg>
            <h3>Automatic Tab Sorting</h3>
          </div>
          <p>
            Pin favorite groups in Settings and add simple website rules so matching links
            automatically open in the right group for you.
          </p>
        </div>

        <div class="feat">
          <div class="feat-head">
            <svg class="feat-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
            </svg>
            <h3>Tailored to Your Style</h3>
          </div>
          <p>
            Choose light or dark mode, compact or comfortable spacing, custom text and icon sizes,
            memory-saving tab unloading, and easy backup &amp; import.
          </p>
        </div>
      </div>
    </section>

    <footer class="footer">
      <button type="button" class="btn-secondary" @click="openSettings">
        Customize VBerry in Settings
      </button>
      <p class="footer-note">You can reopen this guide anytime from VBerry Settings.</p>
    </footer>
  </main>
</template>

<style scoped>
.page {
  max-width: 820px;
  margin: 0 auto;
  padding: 32px 20px 60px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.hero {
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 24px 26px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.hero-top {
  display: flex;
  align-items: center;
  gap: 18px;
}

.logo {
  width: 58px;
  height: 58px;
  border-radius: 14px;
  flex-shrink: 0;
}

.hero h1 {
  margin: 0;
  font-size: 25px;
  letter-spacing: -0.015em;
}

.subtitle {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.5;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.card {
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.highlight-card {
  border-color: var(--accent);
}

.step-tag {
  display: inline-block;
  align-self: flex-start;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--accent);
  margin-bottom: 2px;
}

.card h2 {
  margin: 0;
  font-size: 16.5px;
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.card-head > div {
  flex: 1;
  min-width: 240px;
}

.hint {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.45;
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
  padding: 11px 14px;
  border-radius: 9px;
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
  font-size: 13.5px;
}

.badge-essential {
  padding: 1px 8px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 10.5px;
  font-weight: 600;
}

.cmd-note {
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: 12.2px;
  line-height: 1.4;
}

.kbd {
  padding: 4px 10px;
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

.more-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.more-toggle {
  align-self: flex-start;
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 12.5px;
  font-weight: 500;
  padding: 2px 0;
  cursor: pointer;
}

.more-toggle:hover {
  text-decoration: underline;
}

.optional-list {
  margin-top: 2px;
}

.popup-keys {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 9px 12px;
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
  margin-right: 3px;
}

.quick-tips {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
}

.quick-tip {
  padding: 12px 14px;
  border-radius: 9px;
  background: var(--bg);
  border: 1px solid var(--border);
}

.quick-tip strong {
  display: block;
  font-size: 13px;
  margin-bottom: 4px;
}

.quick-tip p {
  margin: 0;
  font-size: 12.2px;
  color: var(--text-muted);
  line-height: 1.45;
}

.quick-tip code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
}

.vivaldi-box {
  margin-top: 2px;
  padding: 12px 14px;
  border-radius: 9px;
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
  padding: 14px 15px;
  border-radius: 9px;
  background: var(--bg);
  border: 1px solid var(--border);
}

.feat-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.feat-icon {
  width: 17px;
  height: 17px;
  flex-shrink: 0;
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.feat h3 {
  margin: 0;
  font-size: 13.5px;
}

.feat p {
  margin: 0;
  color: var(--text-muted);
  font-size: 12.3px;
  line-height: 1.5;
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
  padding: 8px 15px;
  border: none;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 13px;
}

.btn-primary:hover {
  filter: brightness(1.06);
}

.btn-secondary {
  padding: 8px 15px;
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
  padding: 4px 10px;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  color: var(--text);
  font-size: 11.5px;
}

.footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
}

.footer-note {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
