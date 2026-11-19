<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  CHROME_GROUP_COLORS,
  DEFAULT_SETTINGS,
  type ChromeGroupColor,
  type SavedPanel,
  type Settings,
} from '@/shared/types'
import {
  loadSavedPanels,
  loadSettings,
  loadSnapshots,
  saveSavedPanels,
  saveSettings,
  saveSnapshots,
  uid,
} from '@/shared/storage'
import {
  executeImport,
  exportBackupJson,
  inspectImportJson,
  type ImportPreview,
  type ImportResult,
} from '@/shared/sidebery-import'

const settings = ref<Settings>({ ...DEFAULT_SETTINGS })
const savedPanels = ref<SavedPanel[]>([])
const statusMsg = ref('')

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

// New saved panel form
const newPanelTitle = ref('')
const newPanelColor = ref<ChromeGroupColor>('blue')
const newRulePatterns = ref<Record<string, string>>({})

async function load() {
  const [s, p] = await Promise.all([loadSettings(), loadSavedPanels()])
  settings.value = s
  savedPanels.value = p
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
  flashStatus('Panel added')
}

async function removeSavedPanel(id: string) {
  savedPanels.value = savedPanels.value.filter(p => p.id !== id)
  await saveSavedPanels(savedPanels.value)
  flashStatus('Panel removed')
}

async function updatePanelColor(panel: SavedPanel, color: ChromeGroupColor) {
  panel.color = color
  await saveSavedPanels(savedPanels.value)
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
  flashStatus('Move rule added')
}

async function removeMoveRule(panel: SavedPanel, ruleId: string) {
  panel.moveRules = panel.moveRules.filter(r => r.id !== ruleId)
  await saveSavedPanels(savedPanels.value)
}

async function onFileSelected(e: Event) {
  importError.value = ''
  importResult.value = null
  importPreview.value = null

  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  try {
    const text = await file.text()
    importPreview.value = inspectImportJson(text)
  } catch (err) {
    importError.value = err instanceof Error ? err.message : 'Failed to parse JSON file'
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
    importError.value = err instanceof Error ? err.message : 'Import failed'
  }
}

async function exportData() {
  const { filename, json } = await exportBackupJson()
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

onMounted(load)
</script>

<template>
  <main class="page">
    <header class="header">
      <div>
        <h1>VBerry Settings</h1>
        <p class="subtitle">Chrome-native vertical tab trees &amp; Tab Group panels</p>
      </div>
      <span v-if="statusMsg" class="status-pill">{{ statusMsg }}</span>
    </header>

    <!-- Import from Sidebery / Export -->
    <section class="card">
      <h2>Sidebery Import &amp; Backup</h2>
      <p class="hint">
        Import original Firefox <strong>Sidebery v5</strong> JSON backups
        (<code>sidebery-data-*.json</code>), standalone Sidebery snapshots, or VBerry backups.
        Sidebery panels map 1:1 to Chrome Tab Groups with matching colors and URL move rules.
      </p>

      <div class="row-actions">
        <label class="file-btn">
          Choose Sidebery / VBerry JSON…
          <input type="file" accept=".json,application/json" hidden @change="onFileSelected" />
        </label>
        <button class="btn-secondary" @click="exportData">Export VBerry Backup</button>
      </div>

      <div v-if="importError" class="alert error">{{ importError }}</div>

      <div v-if="importPreview" class="preview-box">
        <div class="preview-head">
          Detected: <strong>{{ importPreview.format }}</strong>
          <span v-if="importPreview.version"> (v{{ importPreview.version }})</span>
        </div>
        <label v-if="importPreview.panelsCount > 0" class="check">
          <input v-model="importOpts.importPanels" type="checkbox" />
          Import {{ importPreview.panelsCount }} Tabs Panels (with colors &amp; URL move rules)
        </label>
        <label v-if="importPreview.snapshotsCount > 0" class="check">
          <input v-model="importOpts.importSnapshots" type="checkbox" />
          Import {{ importPreview.snapshotsCount }} Snapshots (auto-decompresses delta snapshots)
        </label>
        <label v-if="importPreview.hasSettings" class="check">
          <input v-model="importOpts.importSettings" type="checkbox" />
          Import compatible settings (theme, density, tab trees, auto-snapshot)
        </label>
        <label v-if="importPreview.hasCustomCss" class="check">
          <input v-model="importOpts.importCustomCss" type="checkbox" />
          Import Custom Sidebar CSS
        </label>
        <div class="preview-actions">
          <button class="btn-primary" @click="runImport">Import Selected Data</button>
          <button class="btn-secondary" @click="importPreview = null">Cancel</button>
        </div>
      </div>

      <div v-if="importResult" class="alert success">
        Imported {{ importResult.panelsImported }} panel(s) and
        {{ importResult.snapshotsImported }} snapshot(s)
        <span v-if="importResult.settingsImported"> · Settings updated</span>
        <span v-if="importResult.customCssImported"> · Custom CSS applied</span>
      </div>
    </section>

    <!-- General Settings -->
    <section class="card">
      <h2>Appearance &amp; Behavior</h2>

      <div class="setting-row">
        <div>
          <div class="label">Theme</div>
          <div class="desc">Follow Chrome's system theme or force Light / Dark.</div>
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
          <div class="label">Row Density</div>
          <div class="desc">Compact fits more tabs on screen.</div>
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
          <div class="label">Font Size</div>
          <div class="desc">Adjust sidebar text size ({{ settings.fontSize }}px).</div>
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
          <div class="label">Tab Icon Size</div>
          <div class="desc">Adjust tab favicon &amp; pinned icon size ({{ settings.iconSize }}px).</div>
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
          <div class="label">UI Icon Size</div>
          <div class="desc">Adjust toolbar, settings, and close button icon size ({{ settings.uiIconSize }}px).</div>
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

      <label class="setting-row check-row">
        <div>
          <div class="label">Auto-collapse inactive Chrome Tab Groups</div>
          <div class="desc">When switching panels in VBerry, collapse other groups in Chrome's tab strip.</div>
        </div>
        <input
          type="checkbox"
          :checked="settings.autoCollapseInactiveGroups"
          @change="updateSetting('autoCollapseInactiveGroups', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <label class="setting-row check-row">
        <div>
          <div class="label">Auto-nest opened tabs under opener</div>
          <div class="desc">Links opened from a tab become its child in the tab tree.</div>
        </div>
        <input
          type="checkbox"
          :checked="settings.autoNestChildTabs"
          @change="updateSetting('autoNestChildTabs', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <label class="setting-row check-row">
        <div>
          <div class="label">Show tab counts on panel pills</div>
        </div>
        <input
          type="checkbox"
          :checked="settings.showTabCounts"
          @change="updateSetting('showTabCounts', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <label class="setting-row check-row">
        <div>
          <div class="label">Confirm before closing all tabs in a group</div>
        </div>
        <input
          type="checkbox"
          :checked="settings.confirmCloseGroup"
          @change="updateSetting('confirmCloseGroup', ($event.target as HTMLInputElement).checked)"
        />
      </label>

      <div class="setting-row">
        <div>
          <div class="label">Auto-Snapshot Interval (minutes)</div>
          <div class="desc">Set to 0 to disable periodic automatic snapshots (powered by chrome.alarms).</div>
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
          <div class="label">Snapshot Limit</div>
          <div class="desc">Maximum number of snapshots to keep; oldest snapshots are pruned automatically.</div>
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

    <!-- Saved Panels & URL Move Rules -->
    <section class="card">
      <h2>Saved Panels &amp; URL Auto-Group Rules</h2>
      <p class="hint">
        Saved panels stay visible in the panel strip even when empty, and automatically route
        matching URLs into their Chrome Tab Group.
      </p>

      <form class="add-panel-form" @submit.prevent="addSavedPanel">
        <input v-model="newPanelTitle" placeholder="New panel name (e.g. Work)" class="text-input" />
        <select v-model="newPanelColor">
          <option v-for="c in CHROME_GROUP_COLORS" :key="c" :value="c">{{ c }}</option>
        </select>
        <button type="submit" class="btn-primary">Add Panel</button>
      </form>

      <div v-if="savedPanels.length === 0" class="muted">No saved panels yet.</div>

      <div v-for="panel in savedPanels" :key="panel.id" class="panel-card">
        <div class="panel-card-head">
          <span class="dot" :style="{ background: `var(--grp-${panel.color})` }" />
          <strong>{{ panel.title }}</strong>
          <select
            :value="panel.color"
            @change="updatePanelColor(panel, ($event.target as HTMLSelectElement).value as ChromeGroupColor)"
          >
            <option v-for="c in CHROME_GROUP_COLORS" :key="c" :value="c">{{ c }}</option>
          </select>
          <button class="btn-danger-ghost" @click="removeSavedPanel(panel.id)">Remove</button>
        </div>

        <div class="rules-list">
          <div v-for="r in panel.moveRules" :key="r.id" class="rule-chip">
            <code>{{ r.pattern }}</code>
            <button @click="removeMoveRule(panel, r.id)">×</button>
          </div>
          <form class="add-rule-form" @submit.prevent="addMoveRule(panel)">
            <input
              v-model="newRulePatterns[panel.id]"
              class="rule-input"
              placeholder="URL regex or domain (e.g. github\.com)"
            />
            <button type="submit" class="btn-secondary">+ Rule</button>
          </form>
        </div>
      </div>
    </section>

    <!-- Custom CSS -->
    <section class="card">
      <h2>Custom Sidebar CSS</h2>
      <textarea
        class="css-box"
        rows="5"
        placeholder="/* Optional CSS injected into the VBerry Side Panel */"
        :value="settings.customCss"
        @change="updateSetting('customCss', ($event.target as HTMLTextAreaElement).value)"
      />
    </section>
  </main>
</template>

<style scoped>
.page {
  max-width: 760px;
  margin: 0 auto;
  padding: 24px 20px 64px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header h1 {
  margin: 0;
  font-size: 22px;
}

.subtitle {
  margin: 2px 0 0;
  color: var(--text-muted);
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
  border-radius: 10px;
  padding: 16px 18px;
  background: var(--bg-subtle);
}

.card h2 {
  margin: 0 0 8px;
  font-size: 15px;
}

.hint {
  margin: 0 0 12px;
  color: var(--text-muted);
  font-size: 12.5px;
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
  border-radius: 6px;
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 500;
  border: 1px solid var(--border);
}

.file-btn,
.btn-primary {
  background: var(--accent);
  color: var(--accent-text);
  border-color: transparent;
}

.btn-secondary {
  background: var(--bg);
}

.alert {
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: 6px;
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
  padding: 12px;
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
}

select,
.text-input,
.rule-input,
.num-input {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
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
}

.text-input {
  flex: 1;
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
}

.btn-danger-ghost {
  border: none;
  background: transparent;
  color: var(--danger);
  cursor: pointer;
  font-size: 12px;
}

.rules-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rule-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 2px 8px;
  border-radius: 99px;
  background: var(--bg-subtle);
  font-size: 12px;
}

.rule-chip button {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-muted);
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
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
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
