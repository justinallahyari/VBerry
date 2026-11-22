<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import {
  CHROME_GROUP_COLORS,
  DEFAULT_SETTINGS,
  type ChromeGroupColor,
  type SavedPanel,
  type Settings,
} from '@/shared/types'
import {
  downloadTextFile,
  loadSavedPanels,
  loadSettings,
  loadSnapshots,
  saveSavedPanels,
  saveSettings,
  saveSnapshots,
  uid,
} from '@/shared/storage'
import { isVivaldi } from '@/shared/env'
import {
  executeImport,
  exportBackupJson,
  inspectImportJson,
  type ImportPreview,
  type ImportResult,
} from '@/shared/sidebery-import'

const settings = ref<Settings>({ ...DEFAULT_SETTINGS })
const savedPanels = ref<SavedPanel[]>([])
const commands = ref<chrome.commands.Command[]>([])
const vivaldiDetected = ref(false)
const statusMsg = ref('')

const HISTORY_RANGE_OPTIONS: Array<{ days: number; label: string }> = [
  { days: 1, label: 'Past 24 hours' },
  { days: 3, label: 'Past 3 days' },
  { days: 7, label: 'Past 7 days' },
  { days: 30, label: 'Past month' },
  { days: 90, label: 'Past 3 months' },
  { days: 365, label: 'Past year' },
  { days: 0, label: 'All time' },
]

const COMMAND_LABELS: Record<string, string> = {
  _execute_action: 'Open Quick Search',
  toggle_side_panel: 'Toggle VBerry Side Panel',
  new_tab_in_panel: 'New Tab in Active Group',
  create_snapshot: 'Save Tab Snapshot',
  discard_inactive_tabs: 'Unload Inactive Tabs',
}

const FORMAT_LABELS: Record<ImportPreview['format'], string> = {
  'vberry-backup': 'VBerry Backup',
  'sidebery-backup': 'Sidebery Backup',
  'sidebery-snapshot': 'Sidebery Snapshot',
}

// Import state
const importPreview = ref<ImportPreview | null>(null)
const importError = ref('')
const importResult = ref<ImportResult | null>(null)
const importOpts = ref({
  importPanels: true,
  importSnapshots: true,
  importSettings: true,
  importCustomCss: true,
})

// New saved group form
const newPanelTitle = ref('')
const newPanelColor = ref<ChromeGroupColor>('blue')
const newRulePatterns = ref<Record<string, string>>({})

async function loadCommands() {
  try {
    commands.value = await chrome.commands.getAll()
  } catch {
    commands.value = []
  }
}

async function openShortcutsPage() {
  const url = (await isVivaldi())
    ? 'vivaldi://extensions/shortcuts'
    : 'chrome://extensions/shortcuts'
  await chrome.tabs.create({ url, active: true }).catch(() => {})
}

function openWelcomeGuide() {
  void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html'), active: true }).catch(() => {})
}

function commandLabel(cmd: chrome.commands.Command): string {
  if (cmd.name && COMMAND_LABELS[cmd.name]) return COMMAND_LABELS[cmd.name]
  return cmd.description || cmd.name || ''
}

function colorLabel(color: ChromeGroupColor): string {
  return color.charAt(0).toUpperCase() + color.slice(1)
}

async function load() {
  const [s, p, viv] = await Promise.all([loadSettings(), loadSavedPanels(), isVivaldi(), loadCommands()])
  settings.value = s
  savedPanels.value = p
  vivaldiDetected.value = viv
  applyTheme(s)
}

function applyTheme(s: Settings) {
  const root = document.documentElement
  if (s.theme === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', s.theme)
}

async function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  settings.value[key] = value
  await saveSettings({ [key]: value })
  if (key === 'maxSnapshots' && typeof value === 'number' && value > 0) {
    const snaps = await loadSnapshots()
    if (snaps.length > value) {
      await saveSnapshots(snaps.slice(0, value))
    }
  }
  if (key === 'browserMode') {
    vivaldiDetected.value = await isVivaldi()
  }
  applyTheme(settings.value)
  flashStatus('Saved')
}

function flashStatus(msg: string) {
  statusMsg.value = msg
  setTimeout(() => {
    if (statusMsg.value === msg) statusMsg.value = ''
  }, 2000)
}

async function addSavedPanel() {
  const title = newPanelTitle.value.trim()
  if (!title) return
  savedPanels.value.push({
    id: uid('panel'),
    title,
    color: newPanelColor.value,
    moveRules: [],
  })
  await saveSavedPanels(savedPanels.value)
  newPanelTitle.value = ''
  flashStatus('Group added')
}

async function removeSavedPanel(id: string) {
  savedPanels.value = savedPanels.value.filter(p => p.id !== id)
  await saveSavedPanels(savedPanels.value)
  flashStatus('Group removed')
}

async function updatePanelColor(panel: SavedPanel, color: ChromeGroupColor) {
  panel.color = color
  await saveSavedPanels(savedPanels.value)
  flashStatus('Saved')
}

async function addMoveRule(panel: SavedPanel) {
  const pattern = (newRulePatterns.value[panel.id] ?? '').trim()
  if (!pattern) return
  panel.moveRules.push({
    id: uid('rule'),
    active: true,
    pattern,
  })
  newRulePatterns.value[panel.id] = ''
  await saveSavedPanels(savedPanels.value)
  flashStatus('Rule added')
}

async function removeMoveRule(panel: SavedPanel, ruleId: string) {
  panel.moveRules = panel.moveRules.filter(r => r.id !== ruleId)
  await saveSavedPanels(savedPanels.value)
  flashStatus('Rule removed')
}

async function onFileSelected(e: Event) {
  importError.value = ''
  importResult.value = null
  importPreview.value = null

  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  try {
    const text = await file.text()
    importPreview.value = inspectImportJson(text)
  } catch (err) {
    importError.value = err instanceof Error ? err.message : 'Could not read that backup file.'
  }
}

async function runImport() {
  if (!importPreview.value) return
  importError.value = ''
  try {
    importResult.value = await executeImport(importPreview.value, importOpts.value)
    importPreview.value = null
    await load()
    flashStatus('Import complete')
  } catch (err) {
    importError.value = err instanceof Error ? err.message : 'Import failed.'
  }
}

async function exportData() {
  const { filename, json } = await exportBackupJson()
  downloadTextFile(filename, json, 'application/json')
  flashStatus('Backup exported')
}

onMounted(() => {
  void load()
  window.addEventListener('focus', loadCommands)
})

onUnmounted(() => {
  window.removeEventListener('focus', loadCommands)
})
</script>

<template>
  <main class="page">
    <header class="header">
      <div class="brand">
        <img class="logo" src="/icons/icon-128.png" alt="VBerry" />
        <div>
          <h1>VBerry Settings</h1>
          <p class="subtitle">Customize your vertical tabs, groups, and Quick Search.</p>
        </div>
      </div>
      <div class="header-right">
        <span v-if="statusMsg" class="status-pill">{{ statusMsg }}</span>
        <button type="button" class="btn-secondary" @click="openWelcomeGuide">
          Welcome Guide
        </button>
      </div>
    </header>

    <!-- Keyboard Shortcuts -->
    <section class="card">
      <div class="card-head">
        <div>
          <h2>Keyboard Shortcuts</h2>
          <p class="hint">
            Customize your global shortcuts in your browser's Shortcuts page — this list updates
            automatically when you return.
          </p>
        </div>
        <button type="button" class="btn-primary" @click="openShortcutsPage">
          Set Shortcuts…
        </button>
      </div>

      <div class="shortcut-list">
        <div v-for="cmd in commands" :key="cmd.name" class="setting-row">
          <div class="label">{{ commandLabel(cmd) }}</div>
          <kbd class="kbd" :class="{ unset: !cmd.shortcut }">{{ cmd.shortcut || 'Not set' }}</kbd>
        </div>
      </div>

      <p class="tip-line">
        <template v-if="vivaldiDetected">
          Tip: Left-click the VBerry toolbar icon for Quick Search, or right-click it for the Side
          Panel.
        </template>
        <template v-else>
          Tip: Left-click the VBerry toolbar icon for Quick Search, right-click it for the Side
          Panel, or type <code>=</code> + Space in the address bar to search tabs and bookmarks.
        </template>
      </p>
    </section>

    <!-- Quick Search & Unified Search -->
    <section class="card">
      <h2>Quick Search</h2>
      <p class="hint">Choose what appears when you search tabs, bookmarks, and history.</p>

      <label class="setting-row check-row">
        <div>
          <div class="label">Unified Search</div>
          <div class="desc">
            Search open tabs, bookmarks, and recent history together in one ranked list.
          </div>
        </div>
        <input
          type="checkbox"
          :checked="settings.unifiedSearch"
          @change="updateSetting('unifiedSearch', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <template v-if="settings.unifiedSearch">
        <div class="nested-group">
          <div class="nested-label">Search inside</div>
          <div class="chip-grid">
            <label class="chip-toggle">
              <input
                type="checkbox"
                :checked="settings.unifiedSearchTabs"
                @change="updateSetting('unifiedSearchTabs', ($event.target as HTMLInputElement).checked)"
              />
              <span>Open Tabs</span>
            </label>
            <label class="chip-toggle">
              <input
                type="checkbox"
                :checked="settings.unifiedSearchBookmarks"
                @change="updateSetting('unifiedSearchBookmarks', ($event.target as HTMLInputElement).checked)"
              />
              <span>Bookmarks</span>
            </label>
            <label class="chip-toggle">
              <input
                type="checkbox"
                :checked="settings.unifiedSearchHistory"
                @change="updateSetting('unifiedSearchHistory', ($event.target as HTMLInputElement).checked)"
              />
              <span>History</span>
            </label>
          </div>
        </div>

        <div class="nested-group">
          <div class="nested-label">Show before you start typing</div>
          <div class="chip-grid">
            <label class="chip-toggle">
              <input
                type="checkbox"
                :checked="settings.unifiedEmptyShowTabs"
                @change="updateSetting('unifiedEmptyShowTabs', ($event.target as HTMLInputElement).checked)"
              />
              <span>Recent Tabs</span>
            </label>
            <label class="chip-toggle">
              <input
                type="checkbox"
                :checked="settings.unifiedEmptyShowBookmarks"
                @change="updateSetting('unifiedEmptyShowBookmarks', ($event.target as HTMLInputElement).checked)"
              />
              <span>Recent Bookmarks</span>
            </label>
            <label class="chip-toggle">
              <input
                type="checkbox"
                :checked="settings.unifiedEmptyShowHistory"
                @change="updateSetting('unifiedEmptyShowHistory', ($event.target as HTMLInputElement).checked)"
              />
              <span>Recent History</span>
            </label>
          </div>
        </div>

        <label class="setting-row check-row">
          <div>
            <div class="label">Keep Unified Search in Quick Search popup only</div>
            <div class="desc">Hide the Search tab from the sidebar while keeping it in Quick Search.</div>
          </div>
          <input
            type="checkbox"
            :checked="settings.hideUnifiedSearchInSidePanel"
            @change="
              updateSetting(
                'hideUnifiedSearchInSidePanel',
                ($event.target as HTMLInputElement).checked
              )
            "
          />
        </label>
      </template>

      <label class="setting-row check-row">
        <div>
          <div class="label">Highlight top match as you type</div>
          <div class="desc">Press Enter right away to open the top result, or use ↑ / ↓ to choose.</div>
        </div>
        <input
          type="checkbox"
          :checked="settings.autoHighlightSearchMatch"
          @change="updateSetting('autoHighlightSearchMatch', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <label class="setting-row check-row">
        <div>
          <div class="label">Search tabs across all groups</div>
          <div class="desc">Turn off to filter only the group you're currently viewing.</div>
        </div>
        <input
          type="checkbox"
          :checked="settings.searchAllGroups"
          @change="updateSetting('searchAllGroups', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <label class="setting-row check-row">
        <div>
          <div class="label">Focus search when switching panels in Quick Search</div>
          <div class="desc">Keep the cursor in the search box as you switch between tabs, bookmarks, and history.</div>
        </div>
        <input
          type="checkbox"
          :checked="settings.focusSearchOnPanelSwitch"
          @change="updateSetting('focusSearchOnPanelSwitch', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <label class="setting-row check-row">
        <div>
          <div class="label">Clear search after opening a result</div>
          <div class="desc">Start with a clean search box after jumping to a match.</div>
        </div>
        <input
          type="checkbox"
          :checked="settings.clearSearchOnSelect"
          @change="updateSetting('clearSearchOnSelect', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <label class="setting-row check-row">
        <div>
          <div class="label">Clear search when switching panels</div>
          <div class="desc">Turn off to keep your search query when switching between Search, Tabs, Bookmarks, and History.</div>
        </div>
        <input
          type="checkbox"
          :checked="settings.clearSearchOnPanelSwitch"
          @change="updateSetting('clearSearchOnPanelSwitch', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <div class="setting-row">
        <div>
          <div class="label">History time range</div>
          <div class="desc">
            How far back to look in History and Quick Search.
            <span v-if="settings.historyDays === 0" class="warn-inline">
              Searching all history may feel slower if you have years of browsing history.
            </span>
          </div>
        </div>
        <select
          :value="settings.historyDays"
          @change="updateSetting('historyDays', Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="opt in HISTORY_RANGE_OPTIONS" :key="opt.days" :value="opt.days">
            {{ opt.label }}
          </option>
        </select>
      </div>
    </section>

    <!-- Appearance & Tabs -->
    <section class="card">
      <h2>Appearance &amp; Tabs</h2>
      <p class="hint">Adjust how VBerry looks and organizes your open tabs.</p>

      <div class="setting-row">
        <div>
          <div class="label">Theme</div>
          <div class="desc">Match your system appearance or pick Light or Dark.</div>
        </div>
        <select
          :value="settings.theme"
          @change="updateSetting('theme', ($event.target as HTMLSelectElement).value as Settings['theme'])"
        >
          <option value="auto">Auto (System)</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>

      <div class="setting-row">
        <div>
          <div class="label">Row density</div>
          <div class="desc">Compact fits more tabs on screen at once.</div>
        </div>
        <select
          :value="settings.density"
          @change="updateSetting('density', ($event.target as HTMLSelectElement).value as Settings['density'])"
        >
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </div>

      <div class="setting-row">
        <div>
          <div class="label">Text size</div>
          <div class="desc">Sidebar and Quick Search font size.</div>
        </div>
        <div class="range-wrap">
          <input
            type="range"
            min="10"
            max="20"
            step="1"
            :value="settings.fontSize"
            @input="updateSetting('fontSize', Number(($event.target as HTMLInputElement).value))"
          />
          <span class="range-val">{{ settings.fontSize }}px</span>
        </div>
      </div>

      <div class="setting-row">
        <div>
          <div class="label">Tab icon size</div>
          <div class="desc">Size of site icons on regular and pinned tabs.</div>
        </div>
        <div class="range-wrap">
          <input
            type="range"
            min="12"
            max="28"
            step="1"
            :value="settings.iconSize"
            @input="updateSetting('iconSize', Number(($event.target as HTMLInputElement).value))"
          />
          <span class="range-val">{{ settings.iconSize }}px</span>
        </div>
      </div>

      <div class="setting-row">
        <div>
          <div class="label">Toolbar icon size</div>
          <div class="desc">Size of icons in the top navigation bar.</div>
        </div>
        <div class="range-wrap">
          <input
            type="range"
            min="14"
            max="26"
            step="1"
            :value="settings.uiIconSize"
            @input="updateSetting('uiIconSize', Number(($event.target as HTMLInputElement).value))"
          />
          <span class="range-val">{{ settings.uiIconSize }}px</span>
        </div>
      </div>

      <div class="setting-row">
        <div>
          <div class="label">Close &amp; expand icon size</div>
          <div class="desc">Size of the close (×) and tree arrow icons on each tab.</div>
        </div>
        <div class="range-wrap">
          <input
            type="range"
            min="8"
            max="20"
            step="1"
            :value="settings.tabControlIconSize"
            @input="updateSetting('tabControlIconSize', Number(($event.target as HTMLInputElement).value))"
          />
          <span class="range-val">{{ settings.tabControlIconSize }}px</span>
        </div>
      </div>

      <label class="setting-row check-row">
        <div>
          <div class="label">Nest new tabs under the tab that opened them</div>
          <div class="desc">Links opened from a page automatically indent underneath it.</div>
        </div>
        <input
          type="checkbox"
          :checked="settings.autoNestChildTabs"
          @change="updateSetting('autoNestChildTabs', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <label class="setting-row check-row">
        <div>
          <div class="label">Show tab counts on group tabs</div>
          <div class="desc">Display the number of open tabs next to each group name.</div>
        </div>
        <input
          type="checkbox"
          :checked="settings.showTabCounts"
          @change="updateSetting('showTabCounts', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <label class="setting-row check-row">
        <div>
          <div class="label">Collapse other tab groups when switching</div>
          <div class="desc">Keep your browser's top tab bar tidy by collapsing inactive groups.</div>
        </div>
        <input
          type="checkbox"
          :checked="settings.autoCollapseInactiveGroups"
          @change="updateSetting('autoCollapseInactiveGroups', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <label class="setting-row check-row">
        <div>
          <div class="label">Ask before closing all tabs in a group</div>
          <div class="desc">Show a quick confirmation before closing an entire group at once.</div>
        </div>
        <input
          type="checkbox"
          :checked="settings.confirmCloseGroup"
          @change="updateSetting('confirmCloseGroup', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <div class="setting-row">
        <div>
          <div class="label">Browser compatibility</div>
          <div class="desc">Automatically adapts new tabs and tab groups for Chrome or Vivaldi.</div>
        </div>
        <select
          :value="settings.browserMode"
          @change="updateSetting('browserMode', ($event.target as HTMLSelectElement).value as Settings['browserMode'])"
        >
          <option value="auto">Auto-detect</option>
          <option value="chrome">Chrome</option>
          <option value="vivaldi">Vivaldi</option>
        </select>
      </div>
    </section>

    <!-- Snapshots -->
    <section class="card">
      <h2>Tab Snapshots</h2>
      <p class="hint">
        Save copies of your open windows, tab trees, and groups so you can restore them anytime.
      </p>

      <div class="setting-row">
        <div>
          <div class="label">Auto-save interval (minutes)</div>
          <div class="desc">Automatically save a snapshot on a schedule. Set to 0 to turn off.</div>
        </div>
        <input
          type="number"
          min="0"
          step="15"
          class="num-input"
          :value="settings.autoSnapshotMinutes"
          @change="updateSetting('autoSnapshotMinutes', Math.max(0, Number(($event.target as HTMLInputElement).value) || 0))"
        />
      </div>

      <div class="setting-row">
        <div>
          <div class="label">Snapshots to keep</div>
          <div class="desc">Older snapshots are automatically cleaned up once you reach this limit.</div>
        </div>
        <input
          type="number"
          min="1"
          max="500"
          step="1"
          class="num-input"
          :value="settings.maxSnapshots"
          @change="updateSetting('maxSnapshots', Math.max(1, Math.min(500, Math.round(Number(($event.target as HTMLInputElement).value) || 30))))"
        />
      </div>
    </section>

    <!-- Saved Groups & Auto-Group Rules -->
    <section class="card">
      <h2>Saved Groups &amp; Auto-Sorting</h2>
      <p class="hint">
        Pin favorite groups so they always stay ready in your sidebar, and add website rules to
        automatically route matching links into them.
      </p>

      <form class="add-panel-form" @submit.prevent="addSavedPanel">
        <input
          v-model="newPanelTitle"
          placeholder="Group name (e.g. Work, Shopping, Reading)"
          class="text-input"
        />
        <select v-model="newPanelColor" aria-label="Group color">
          <option v-for="c in CHROME_GROUP_COLORS" :key="c" :value="c">{{ colorLabel(c) }}</option>
        </select>
        <button type="submit" class="btn-primary">Add Group</button>
      </form>

      <div v-if="savedPanels.length === 0" class="muted">
        No saved groups yet — add one above to keep it pinned or set up auto-sorting rules.
      </div>

      <div v-for="panel in savedPanels" :key="panel.id" class="panel-card">
        <div class="panel-card-head">
          <span class="dot" :style="{ background: `var(--grp-${panel.color})` }" />
          <strong>{{ panel.title }}</strong>
          <select
            :value="panel.color"
            aria-label="Group color"
            @change="updatePanelColor(panel, ($event.target as HTMLSelectElement).value as ChromeGroupColor)"
          >
            <option v-for="c in CHROME_GROUP_COLORS" :key="c" :value="c">{{ colorLabel(c) }}</option>
          </select>
          <button type="button" class="btn-danger-ghost" @click="removeSavedPanel(panel.id)">
            Remove
          </button>
        </div>

        <div class="rules-list">
          <div v-if="panel.moveRules.length" class="rule-chips">
            <div v-for="r in panel.moveRules" :key="r.id" class="rule-chip">
              <code>{{ r.pattern }}</code>
              <button type="button" title="Remove rule" @click="removeMoveRule(panel, r.id)">×</button>
            </div>
          </div>
          <form class="add-rule-form" @submit.prevent="addMoveRule(panel)">
            <input
              v-model="newRulePatterns[panel.id]"
              class="rule-input"
              placeholder="Website or URL pattern (e.g. github.com)"
            />
            <button type="submit" class="btn-secondary">+ Add Rule</button>
          </form>
        </div>
      </div>
    </section>

    <!-- Backup & Import -->
    <section class="card">
      <h2>Backup &amp; Import</h2>
      <p class="hint">
        Save a backup of your VBerry settings, saved groups, and snapshots — or import an existing
        backup from VBerry or Sidebery.
      </p>

      <div class="row-actions">
        <label class="file-btn">
          Import Backup File…
          <input type="file" accept=".json,application/json" hidden @change="onFileSelected" />
        </label>
        <button type="button" class="btn-secondary" @click="exportData">Export Backup</button>
      </div>

      <div v-if="importError" class="alert error">{{ importError }}</div>

      <div v-if="importPreview" class="preview-box">
        <div class="preview-head">
          Ready to import: <strong>{{ FORMAT_LABELS[importPreview.format] }}</strong>
        </div>
        <label v-if="importPreview.panelsCount > 0" class="check">
          <input v-model="importOpts.importPanels" type="checkbox" />
          {{ importPreview.panelsCount }} saved group(s) with colors &amp; auto-sorting rules
        </label>
        <label v-if="importPreview.snapshotsCount > 0" class="check">
          <input v-model="importOpts.importSnapshots" type="checkbox" />
          {{ importPreview.snapshotsCount }} tab snapshot(s)
        </label>
        <label v-if="importPreview.hasSettings" class="check">
          <input v-model="importOpts.importSettings" type="checkbox" />
          Theme, density, and tab preferences
        </label>
        <label v-if="importPreview.hasCustomCss" class="check">
          <input v-model="importOpts.importCustomCss" type="checkbox" />
          Custom sidebar CSS
        </label>
        <div class="preview-actions">
          <button type="button" class="btn-primary" @click="runImport">Import Selected</button>
          <button type="button" class="btn-secondary" @click="importPreview = null">Cancel</button>
        </div>
      </div>

      <div v-if="importResult" class="alert success">
        Imported {{ importResult.panelsImported }} group(s) and
        {{ importResult.snapshotsImported }} snapshot(s)
        <span v-if="importResult.settingsImported"> · Settings updated</span>
        <span v-if="importResult.customCssImported"> · Custom CSS applied</span>
      </div>
    </section>

    <!-- Custom CSS -->
    <section class="card">
      <h2>Custom Sidebar CSS</h2>
      <p class="hint">Optional CSS rules for fine-tuning the look of the VBerry sidebar.</p>
      <textarea
        class="css-box"
        rows="5"
        placeholder="/* Optional custom CSS for the VBerry sidebar */"
        :value="settings.customCss"
        @change="updateSetting('customCss', ($event.target as HTMLTextAreaElement).value)"
      />
    </section>
  </main>
</template>

<style scoped>
.page {
  max-width: 780px;
  margin: 0 auto;
  padding: 28px 20px 64px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.brand {
  display: flex;
  align-items: center;
  gap: 14px;
}

.logo {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  flex-shrink: 0;
}

.header h1 {
  margin: 0;
  font-size: 22px;
  letter-spacing: -0.01em;
}

.subtitle {
  margin: 2px 0 0;
  color: var(--text-muted);
  font-size: 13px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-pill {
  padding: 4px 10px;
  border-radius: 99px;
  background: var(--bg-active);
  color: var(--text);
  font-size: 12px;
  font-weight: 500;
}

.card {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  background: var(--bg-subtle);
}

.card h2 {
  margin: 0 0 6px;
  font-size: 15.5px;
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
  margin: 0 0 12px;
  color: var(--text-muted);
  font-size: 12.5px;
  line-height: 1.45;
}

.shortcut-list {
  margin-top: 2px;
}

.kbd {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  white-space: nowrap;
}

.kbd.unset {
  color: var(--text-muted);
  border-style: dashed;
}

.tip-line {
  margin: 10px 0 0;
  padding: 8px 11px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.45;
}

.tip-line code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text);
}

.nested-group {
  margin: 8px 0 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  background: var(--bg);
  border-radius: 8px;
}

.nested-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.chip-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.chip-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  cursor: pointer;
  font-size: 12.5px;
  user-select: none;
}

.chip-toggle:hover {
  background: var(--bg-hover);
}

.warn-inline {
  display: block;
  margin-top: 2px;
  color: var(--danger);
}

.row-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.file-btn,
.btn-primary,
.btn-secondary {
  display: inline-flex;
  align-items: center;
  padding: 7px 14px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 500;
  border: 1px solid var(--border);
  white-space: nowrap;
}

.file-btn,
.btn-primary {
  background: var(--accent);
  color: var(--accent-text);
  border-color: transparent;
}

.file-btn:hover,
.btn-primary:hover {
  filter: brightness(1.06);
}

.btn-secondary {
  background: var(--bg);
}

.btn-secondary:hover {
  background: var(--bg-hover);
}

.alert {
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: 7px;
  font-size: 12.5px;
}

.alert.error {
  background: rgba(217, 48, 37, 0.14);
  color: var(--danger);
}

.alert.success {
  background: rgba(24, 128, 56, 0.15);
  color: var(--grp-green);
}

.preview-box {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.preview-head {
  font-size: 13px;
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.preview-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
}

.setting-row:first-of-type {
  border-top: none;
}

.check-row {
  cursor: pointer;
}

.label {
  font-weight: 500;
}

.desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 1px;
}

select,
.text-input,
.rule-input,
.num-input {
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg);
}

.num-input {
  width: 84px;
}

.range-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.range-val {
  min-width: 36px;
  text-align: right;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.add-panel-form {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.text-input {
  flex: 1;
  min-width: 180px;
}

.panel-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--bg);
  margin-bottom: 8px;
}

.panel-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.panel-card-head strong {
  flex: 1;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.btn-danger-ghost {
  border: none;
  background: transparent;
  color: var(--danger);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 5px;
}

.btn-danger-ghost:hover {
  background: rgba(217, 48, 37, 0.1);
}

.rules-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rule-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.rule-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 99px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  font-size: 12px;
}

.rule-chip button {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-muted);
  padding: 0 2px;
}

.add-rule-form {
  display: flex;
  gap: 6px;
}

.rule-input {
  flex: 1;
  font-size: 12px;
}

.css-box {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  resize: vertical;
}

.muted {
  color: var(--text-muted);
  font-size: 12.5px;
}
</style>
