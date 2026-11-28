<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { DEFAULT_SETTINGS } from '@/shared/types'
import { isVivaldi } from '@/shared/env'
import { loadSettings, normalizeSettings, STORAGE_KEYS } from '@/shared/storage'
import { applyVisualTheme } from '@/shared/themes'

const commands = ref<chrome.commands.Command[]>([])
const vivaldiDetected = ref(false)
const copiedUrl = ref(false)
const showMoreShortcuts = ref(false)
const sidePanelUrl = chrome.runtime?.getURL?.('sidepanel.html') ?? ''

// Interactive hero demo state
type DemoGroup = 'research' | 'review'
interface DemoTab {
  id: number
  group: DemoGroup
  title: string
  host: string
  level: number
  parentId?: number
}

const DEMO_TABS: DemoTab[] = [
  { id: 1, group: 'research', title: 'Vivaldi Side Panel architecture', host: 'vivaldi.com', level: 0 },
  { id: 2, group: 'research', title: 'Chromium MV3 user gesture spec', host: 'developer.chrome.com', level: 1, parentId: 1 },
  { id: 3, group: 'research', title: 'Keyboard focus lifecycle notes', host: 'github.com', level: 1, parentId: 1 },
  { id: 4, group: 'research', title: 'Typography & spatial hierarchy', host: 'practicaltypography.com', level: 0 },
  { id: 5, group: 'review', title: 'PR #142 — Preserve nested tab order', host: 'github.com', level: 0 },
  { id: 6, group: 'review', title: 'CI run #881 — 59 tests passing', host: 'github.com', level: 1, parentId: 5 },
]

const demoGroup = ref<DemoGroup>('research')
const demoActiveId = ref(1)
const demoFoldedIds = ref<Set<number>>(new Set())
const demoQuery = ref('')

const visibleDemoTabs = computed(() => {
  const q = demoQuery.value.trim().toLowerCase()
  const inGroup = DEMO_TABS.filter(t => (q ? true : t.group === demoGroup.value))
  if (q) {
    return inGroup
      .filter(t => t.title.toLowerCase().includes(q) || t.host.toLowerCase().includes(q))
      .map(t => ({ ...t, level: 0, hasChildren: false, childCount: 0, folded: false }))
  }
  return inGroup
    .filter(t => !(t.parentId && demoFoldedIds.value.has(t.parentId)))
    .map(t => {
      const childCount = inGroup.filter(c => c.parentId === t.id).length
      return {
        ...t,
        hasChildren: childCount > 0,
        childCount,
        folded: demoFoldedIds.value.has(t.id),
      }
    })
})

function toggleDemoFold(id: number) {
  const next = new Set(demoFoldedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  demoFoldedIds.value = next
}

function switchDemoGroup(group: DemoGroup) {
  demoGroup.value = group
  demoQuery.value = ''
  const first = DEMO_TABS.find(t => t.group === group)
  if (first) demoActiveId.value = first.id
}

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
    note: 'Jump to any open tab, saved bookmark, or visited page from anywhere.',
  },
  {
    name: 'toggle_side_panel',
    title: 'Toggle side panel',
    note: 'Show or hide your vertical tab tree without leaving the keyboard.',
  },
] as const

const OPTIONAL_COMMANDS = [
  {
    name: 'new_tab_in_panel',
    title: 'New tab in active group',
    note: 'Open a fresh tab directly inside the group you are viewing.',
  },
  {
    name: 'create_snapshot',
    title: 'Save tab snapshot',
    note: 'Capture open windows, groups, and nested branches in one keystroke.',
  },
  {
    name: 'discard_inactive_tabs',
    title: 'Unload inactive tabs',
    note: 'Put background tabs to sleep to free memory while keeping your tree intact.',
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

function openSettings(hash = '') {
  const base = chrome.runtime.getURL('options.html')
  if (hash) {
    void chrome.tabs.create({ url: `${base}${hash}`, active: true }).catch(() => {})
    return
  }
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

function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area === 'local' && changes[STORAGE_KEYS.settings]) {
    const next = normalizeSettings(changes[STORAGE_KEYS.settings].newValue)
    applyVisualTheme(next)
  }
}

onMounted(async () => {
  const [settings, viv] = await Promise.all([loadSettings(), isVivaldi(), loadCommands()])
  vivaldiDetected.value = viv
  applyVisualTheme(settings)
  window.addEventListener('focus', loadCommands)
  chrome.storage?.onChanged?.addListener(onStorageChanged)
})

onUnmounted(() => {
  window.removeEventListener('focus', loadCommands)
  chrome.storage?.onChanged?.removeListener(onStorageChanged)
})
</script>

<template>
  <main class="page">
    <!-- Split Hero: Product Statement + Live Interactive Sidebar -->
    <header class="hero">
      <div class="hero-copy">
        <div class="brand-lockup">
          <img class="logo" src="/icons/icon-128.png" alt="VBerry" />
          <span class="brand-word">VBerry</span>
        </div>

        <h1>Keep fifty tabs open without losing your train of thought.</h1>
        <p class="lead">
          Pages you open nest naturally underneath where they came from, workspaces stay separated
          by group, and Quick Search jumps to any tab, bookmark, or history entry in two
          keystrokes.
        </p>

        <div class="hero-actions">
          <button type="button" class="btn-primary" @click="openShortcutsPage">
            Set keyboard shortcuts
          </button>
          <button type="button" class="btn-secondary" @click="openSettings()">
            Open preferences
          </button>
          <button type="button" class="btn-link" @click="openSettings('#import')">
            Import Sidebery backup
          </button>
        </div>
      </div>

      <!-- Interactive Live Demo -->
      <div class="demo-wrap" aria-label="Interactive VBerry sidebar preview">
        <div class="demo-frame">
          <div class="demo-bar">
            <div class="demo-pills">
              <span class="demo-pill demo-ungrouped" style="--pill-color: var(--accent)">
                <span>Tabs</span>
                <span class="cnt">2</span>
              </span>
              <button
                type="button"
                class="demo-pill"
                :class="{ active: demoGroup === 'research' && !demoQuery }"
                style="--pill-color: var(--grp-purple)"
                @click="switchDemoGroup('research')"
              >
                <span>Research</span>
                <span class="cnt">4</span>
              </button>
              <button
                type="button"
                class="demo-pill"
                :class="{ active: demoGroup === 'review' && !demoQuery }"
                style="--pill-color: var(--grp-blue)"
                @click="switchDemoGroup('review')"
              >
                <span>Code review</span>
                <span class="cnt">2</span>
              </button>
            </div>
          </div>

          <div class="demo-search">
            <svg class="demo-search-icon" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5" />
              <path
                d="m10.5 10.5 3.2 3.2"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
            <input
              v-model="demoQuery"
              type="search"
              placeholder="Try filtering these tabs…"
              aria-label="Filter demo tabs"
            />
          </div>

          <div class="demo-tree">
            <div
              v-for="item in visibleDemoTabs"
              :key="item.id"
              class="demo-row"
              :class="{ active: demoActiveId === item.id }"
              :style="{ paddingLeft: `${8 + item.level * 16}px` }"
              @click="demoActiveId = item.id"
            >
              <span v-if="item.level > 0" class="demo-guide" />
              <button
                v-if="item.hasChildren"
                type="button"
                class="demo-fold"
                :title="item.folded ? 'Expand branch' : 'Fold branch'"
                @click.stop="toggleDemoFold(item.id)"
              >
                <svg :class="{ folded: item.folded }" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M4 6l4 4 4-4"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.9"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
              <span v-else class="demo-fav">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect
                    x="2.5"
                    y="2.5"
                    width="11"
                    height="11"
                    rx="2.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                  />
                  <path d="M2.5 6h11" fill="none" stroke="currentColor" stroke-width="1.3" />
                </svg>
              </span>

              <span class="demo-title">{{ item.title }}</span>
              <span v-if="item.folded" class="demo-badge" @click.stop="toggleDemoFold(item.id)">
                +{{ item.childCount }}
              </span>
              <span v-else class="demo-host">{{ item.host }}</span>
            </div>
            <div v-if="visibleDemoTabs.length === 0" class="demo-empty">
              No demo tabs match “{{ demoQuery }}”.
            </div>
          </div>
        </div>
        <p class="demo-caption">
          Interactive preview — click a branch arrow to fold children or switch groups above.
        </p>
      </div>
    </header>

    <!-- Two-Column Setup Workspace -->
    <div class="setup-grid">
      <!-- Column 1: Keyboard Shortcuts -->
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Default keyboard shortcuts</h2>
            <p class="hint">
              Ready out of the box — customize anytime in your browser's shortcuts page.
            </p>
          </div>
          <button type="button" class="btn-secondary btn-compact" @click="openShortcutsPage">
            Customize
          </button>
        </div>

        <div class="cmd-list">
          <div v-for="cmd in essentialCards" :key="cmd.name" class="cmd-row essential">
            <div class="cmd-info">
              <div class="cmd-title">{{ cmd.title }}</div>
              <p class="cmd-note">{{ cmd.note }}</p>
            </div>
            <kbd class="kbd" :class="{ unset: !cmd.shortcut }">
              {{ cmd.shortcut || 'Not set' }}
            </kbd>
          </div>
        </div>

        <button
          type="button"
          class="more-toggle"
          @click="showMoreShortcuts = !showMoreShortcuts"
        >
          {{ showMoreShortcuts ? 'Hide optional shortcuts' : 'Show 3 optional shortcuts' }}
        </button>

        <div v-if="showMoreShortcuts" class="cmd-list">
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

        <div class="keybar">
          <span class="keybar-title">Inside Quick Search</span>
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Backspace</kbd> close tab</span>
          <span><kbd>Tab</kbd> sections</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </section>

      <!-- Column 2: Browser Integration -->
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>{{ vivaldiDetected ? 'Set up for Vivaldi' : 'Pin VBerry to your toolbar' }}</h2>
            <p class="hint">
              {{
                vivaldiDetected
                  ? 'VBerry automatically uses Virtual Tab Groups and Vivaldi start pages.'
                  : 'Pin the VBerry icon in your extensions menu for one-click access.'
              }}
            </p>
          </div>
        </div>

        <div class="way-list">
          <div class="way-item">
            <div class="way-title">Left-click the toolbar icon</div>
            <p>Opens Quick Search immediately with the search box focused and ready.</p>
          </div>

          <div class="way-item">
            <div class="way-title">
              {{ vivaldiDetected ? 'Press Ctrl+E (or right-click the icon)' : 'Right-click the toolbar icon' }}
            </div>
            <p>
              {{
                vivaldiDetected
                  ? 'Opens or closes the docked VBerry side panel right inside Vivaldi.'
                  : 'Choose Open VBerry Side Panel to dock your vertical tab tree alongside pages.'
              }}
            </p>
          </div>

          <div v-if="!vivaldiDetected" class="way-item">
            <div class="way-title">Type <code>=</code> then Space in the address bar</div>
            <p>Search open tabs and bookmarks straight from Chrome's URL bar.</p>
          </div>
        </div>

        <div v-if="vivaldiDetected && sidePanelUrl" class="vivaldi-box">
          <div class="vivaldi-head">
            <span>Optional Web Panel address</span>
            <button type="button" class="btn-mini" @click="copyWebPanelUrl">
              {{ copiedUrl ? 'Copied' : 'Copy URL' }}
            </button>
          </div>
          <code class="url-code">{{ sidePanelUrl }}</code>
        </div>
      </section>
    </div>

    <!-- Dedicated Vivaldi Themes & CSS Hacks Section -->
    <section class="panel vivaldi-extras">
      <div class="panel-head">
        <div>
          <h2>Vivaldi themes &amp; CSS hacks</h2>
          <p class="hint">
            Pair VBerry with matching native Vivaldi themes and optional edge-to-edge UI mods from
            the VBerry repository.
          </p>
        </div>
        <button
          type="button"
          class="btn-secondary btn-compact"
          @click="openSettings('#sec-appearance')"
        >
          Choose VBerry theme
        </button>
      </div>

      <div class="extras-grid">
        <div class="extra-card">
          <div class="extra-head">
            <h3>Matching Vivaldi themes</h3>
            <a
              class="extra-link"
              href="https://github.com/justinallahyari/VBerry/tree/main/vivaldi%20themes"
              target="_blank"
              rel="noreferrer"
            >
              View <code>vivaldi themes/</code>
            </a>
          </div>
          <p class="extra-desc">
            Includes 12 ready-to-import Vivaldi <code>.zip</code> themes matched 1:1 to every VBerry
            palette (Vivaldi Light/Dark, Chrome Light/Dark, and all 8 studio themes) with matching
            canvas, rail, text, accent, and corner rounding.
          </p>
          <ol class="extra-steps">
            <li>
              Open <strong>Vivaldi Settings → Themes</strong> (<code>vivaldi://settings/themes/</code>)
              and click <strong>Open Theme…</strong>.
            </li>
            <li>Import any <code>.zip</code> from <code>vivaldi themes/</code>.</li>
            <li>
              Pick the matching theme in <strong>VBerry Preferences → Appearance &amp; tabs</strong>
              (or tweak colors in the Theme Studio).
            </li>
          </ol>
        </div>

        <div class="extra-card">
          <div class="extra-head">
            <h3>Optional Vivaldi CSS hacks</h3>
            <a
              class="extra-link"
              href="https://github.com/justinallahyari/VBerry/tree/main/vivaldi%20css%20hacks"
              target="_blank"
              rel="noreferrer"
            >
              View <code>vivaldi css hacks/</code>
            </a>
          </div>
          <p class="extra-desc">
            Optional Vivaldi Custom UI CSS files for a cleaner, edge-to-edge sidebar. Enable
            <strong>Allow for using CSS modifications</strong> in <code>vivaldi://experiments</code>,
            pick the folder in <strong>Settings → Appearance → Custom UI Modifications</strong>, and
            restart Vivaldi:
          </p>
          <ul class="hack-list">
            <li>
              <code>hide-panel-switch.css</code> — Hides Vivaldi's vertical panel icon strip so
              VBerry fills the full panel width and collapses cleanly to 0px when closed.
            </li>
            <li>
              <code>hide-webpanel-header.css</code> — Hides the Web Panel title/navigation header
              bar so VBerry uses the full sidebar height.
            </li>
            <li>
              <code>hide-window-borders.css</code> — Removes outer right and bottom window borders,
              narrows the sidebar-to-page gap to 3px, and keeps fullscreen flush edge-to-edge.
            </li>
          </ul>
        </div>
      </div>
    </section>

    <footer class="footer">
      <span>You can reopen this guide anytime from VBerry Preferences.</span>
    </footer>
  </main>
</template>

<style scoped>
.page {
  max-width: 960px;
  margin: 0 auto;
  padding: 40px 24px 64px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(300px, 0.92fr);
  gap: 32px;
  align-items: center;
  padding: 28px 30px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
}

.hero-copy {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.brand-lockup {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.logo {
  width: 36px;
  height: 36px;
  border-radius: 9px;
}

.brand-word {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 16px;
  letter-spacing: -0.02em;
}

.hero h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(24px, 3vw, 31px);
  font-weight: 700;
  line-height: 1.16;
  letter-spacing: -0.025em;
  max-width: 22ch;
}

.lead {
  margin: 0;
  color: var(--text-muted);
  font-size: 14.5px;
  line-height: 1.55;
  max-width: 52ch;
}

.hero-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
}

/* Interactive Demo Sidebar */
.demo-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.demo-frame {
  border-radius: 12px;
  border: 1px solid var(--border-strong);
  background: var(--bg);
  box-shadow: var(--shadow);
  overflow: hidden;
}

.demo-bar {
  padding: 7px 9px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border);
}

.demo-pills {
  display: flex;
  gap: 5px;
}

.demo-pill {
  --pill-color: var(--accent);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid color-mix(in srgb, var(--pill-color) 62%, var(--border));
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.demo-ungrouped {
  cursor: default;
}

.demo-pill.active {
  background: color-mix(in srgb, var(--pill-color) 15%, var(--surface));
  border-color: var(--pill-color);
  color: var(--text);
  box-shadow: inset 0 0 0 0.5px var(--pill-color), var(--shadow-sm);
}

.demo-pill.active .cnt {
  color: var(--text);
  opacity: 0.82;
}

.cnt {
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}

.demo-search {
  position: relative;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.demo-search-icon {
  position: absolute;
  left: 17px;
  top: 50%;
  transform: translateY(-50%);
  width: 13px;
  height: 13px;
  color: var(--text-muted);
  pointer-events: none;
}

.demo-search input {
  width: 100%;
  height: 29px;
  padding: 0 10px 0 28px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-subtle);
  font-size: 12px;
  outline: none;
}

.demo-search input:focus {
  border-color: var(--accent);
  background: var(--surface);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.demo-tree {
  padding: 6px;
  min-height: 162px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.demo-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 31px;
  padding-right: 8px;
  border-radius: 7px;
  cursor: pointer;
  user-select: none;
  font-size: 12.5px;
}

.demo-row:hover {
  background: var(--bg-hover);
}

.demo-row.active {
  background: var(--bg-active);
}

.demo-row.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 5px;
  bottom: 5px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
}

.demo-guide {
  position: absolute;
  left: 16px;
  top: -2px;
  bottom: -2px;
  width: 1px;
  background: var(--border-strong);
}

.demo-fold {
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 5px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.demo-fold svg {
  width: 12px;
  height: 12px;
  transition: transform 0.12s ease;
}

.demo-fold svg.folded {
  transform: rotate(-90deg);
}

.demo-fav {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  flex-shrink: 0;
}

.demo-fav svg {
  width: 14px;
  height: 14px;
}

.demo-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.demo-host {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.demo-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 99px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--accent);
}

.demo-empty {
  padding: 28px 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

.demo-caption {
  margin: 0;
  text-align: center;
  font-size: 11.5px;
  color: var(--text-muted);
}

/* Two-Column Setup Grid */
.setup-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  align-items: start;
}

.panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 22px;
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.panel h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.015em;
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
  gap: 12px;
  padding: 11px 13px;
  border-radius: 9px;
  background: var(--bg);
  border: 1px solid var(--border);
}

.cmd-row.essential {
  border-color: var(--border-strong);
}

.cmd-info {
  min-width: 0;
}

.cmd-title {
  font-weight: 600;
  font-size: 13px;
}

.cmd-note {
  margin: 2px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.4;
}

.kbd {
  padding: 4px 9px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: nowrap;
  flex-shrink: 0;
}

.kbd.unset {
  color: var(--text-muted);
  border-style: dashed;
  background: transparent;
}

.more-toggle {
  align-self: flex-start;
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 12.5px;
  font-weight: 500;
  padding: 0;
  cursor: pointer;
}

.more-toggle:hover {
  text-decoration: underline;
}

.keybar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 8px;
  background: var(--bg-subtle);
  font-size: 11.5px;
  color: var(--text-muted);
}

.keybar-title {
  font-weight: 600;
  color: var(--text);
}

.keybar kbd {
  padding: 1px 5px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 10.5px;
  margin-right: 2px;
}

.way-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.way-item {
  padding: 12px 14px;
  border-radius: 9px;
  background: var(--bg);
  border: 1px solid var(--border);
}

.way-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 3px;
}

.way-item p {
  margin: 0;
  font-size: 12.2px;
  color: var(--text-muted);
  line-height: 1.45;
}

.way-title code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.vivaldi-box {
  padding: 11px 13px;
  border-radius: 9px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.vivaldi-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 500;
}

.url-code {
  display: block;
  padding: 6px 9px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 11.5px;
  word-break: break-all;
  user-select: all;
}

.btn-primary,
.btn-secondary,
.btn-mini {
  border-radius: 8px;
  cursor: pointer;
  font-weight: 500;
  white-space: nowrap;
  transition: background-color 0.1s ease, border-color 0.1s ease;
}

.btn-primary {
  padding: 8.5px 16px;
  border: none;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 13px;
}

.btn-primary:hover {
  background: var(--accent-hover);
}

.btn-secondary {
  padding: 8px 15px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
}

.btn-secondary.btn-compact {
  padding: 6px 11px;
  font-size: 12px;
}

.btn-secondary:hover,
.btn-mini:hover {
  background: var(--bg-hover);
}

.btn-link {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 13px;
  font-weight: 500;
  padding: 4px 6px;
  cursor: pointer;
}

.btn-link:hover {
  text-decoration: underline;
}

.btn-mini {
  padding: 3px 9px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  font-size: 11.5px;
}

.vivaldi-extras {
  gap: 16px;
}

.extras-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  align-items: stretch;
}

.extra-card {
  padding: 15px 16px;
  border-radius: 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.extra-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.extra-head h3 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 650;
  color: var(--text);
}

.extra-link {
  font-size: 12px;
  font-weight: 500;
  color: var(--accent);
  text-decoration: none;
}

.extra-link:hover {
  text-decoration: underline;
}

.extra-desc {
  margin: 0;
  font-size: 12.2px;
  line-height: 1.5;
  color: var(--text-muted);
}

.extra-steps,
.hack-list {
  margin: 0;
  padding-left: 17px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.2px;
  line-height: 1.48;
  color: var(--text-muted);
}

.extra-card strong {
  color: var(--text);
  font-weight: 600;
}

.extra-card code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 11px;
}

.footer {
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

@media (max-width: 820px) {
  .hero,
  .setup-grid,
  .extras-grid {
    grid-template-columns: 1fr;
  }

  .hero {
    padding: 22px 20px;
  }
}
</style>
