<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  CHROME_GROUP_COLORS,
  DEFAULT_SETTINGS,
  DEFAULT_SYNC_CONFIG,
  type ChromeGroupColor,
  type CustomTheme,
  type PresetThemeId,
  type SavedPanel,
  type Settings,
  type SyncConfig,
  type SyncStateMeta,
  type ThemeColors,
  type ThemeId,
} from '@/shared/types'
import {
  applyVisualTheme,
  AUTO_THEME_GROUPS,
  deriveThemePaletteFromColors,
  getEffectivePresetPalette,
  isAutoThemeId,
  normalizeHex,
  parseHexRgb,
  resolveEffectiveThemeId,
  resolveThemePalette,
  THEME_ORDER,
} from '@/shared/themes'
import {
  downloadTextFile,
  loadSavedPanels,
  loadSettings,
  loadSnapshots,
  loadSyncConfig,
  loadSyncMeta,
  normalizeSettings,
  normalizeSyncConfig,
  normalizeSyncMeta,
  saveSavedPanels,
  saveSettings,
  saveSnapshots,
  saveSyncConfig,
  STORAGE_KEYS,
  toArray,
  uid,
} from '@/shared/storage'
import { reconcileSync, SYNC_QUOTA_BYTES } from '@/shared/sync'
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
const syncConfig = ref<SyncConfig>({ ...DEFAULT_SYNC_CONFIG })
const syncMeta = ref<SyncStateMeta>(normalizeSyncMeta(undefined))
const syncingNow = ref(false)
const commands = ref<chrome.commands.Command[]>([])
const vivaldiDetected = ref(false)
const statusMsg = ref('')
const activeSection = ref('sec-shortcuts')
const previewFolded = ref(false)
const themeEditorOpen = ref(false)
const autoEditVariant = ref<'light' | 'dark'>('light')

const THEME_COLOR_FIELDS: ReadonlyArray<{ key: keyof Omit<ThemeColors, 'scheme'>; label: string }> = [
  { key: 'bg', label: 'Background' },
  { key: 'surface', label: 'Surface' },
  { key: 'bgSubtle', label: 'Toolbar strip' },
  { key: 'border', label: 'Border' },
  { key: 'text', label: 'Primary text' },
  { key: 'textMuted', label: 'Muted text' },
  { key: 'defaultAccent', label: 'Theme accent' },
]

const SECTIONS = [
  { id: 'sec-shortcuts', label: 'Shortcuts' },
  { id: 'sec-search', label: 'Quick Search' },
  { id: 'sec-appearance', label: 'Appearance & tabs' },
  { id: 'sec-groups', label: 'Groups & rules' },
  { id: 'sec-snapshots', label: 'Snapshots' },
  { id: 'sec-sync', label: 'Account sync' },
  { id: 'sec-backup', label: 'Backup & CSS' },
] as const

const HISTORY_RANGE_OPTIONS: Array<{ days: number; label: string }> = [
  { days: 1, label: 'Past 24 hours' },
  { days: 3, label: 'Past 3 days' },
  { days: 7, label: 'Past 7 days' },
  { days: 30, label: 'Past month' },
  { days: 90, label: 'Past 3 months' },
  { days: 365, label: 'Past year' },
  { days: 0, label: 'All time' },
]

const COMMAND_ORDER = [
  '_execute_action',
  'toggle_side_panel',
  'new_tab_in_panel',
  'create_snapshot',
  'discard_inactive_tabs',
]

const COMMAND_LABELS: Record<string, string> = {
  _execute_action: 'Open Quick Search',
  toggle_side_panel: 'Toggle side panel',
  new_tab_in_panel: 'New tab in active group',
  create_snapshot: 'Save tab snapshot',
  discard_inactive_tabs: 'Unload inactive tabs',
}

const FORMAT_LABELS: Record<ImportPreview['format'], string> = {
  'vberry-backup': 'VBerry backup',
  'sidebery-backup': 'Sidebery backup',
  'sidebery-snapshot': 'Sidebery snapshot',
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

const hasCustomSizing = computed(
  () =>
    settings.value.fontSize !== DEFAULT_SETTINGS.fontSize ||
    settings.value.iconSize !== DEFAULT_SETTINGS.iconSize ||
    settings.value.uiIconSize !== DEFAULT_SETTINGS.uiIconSize ||
    settings.value.tabControlIconSize !== DEFAULT_SETTINGS.tabControlIconSize
)

const previewVars = computed(() => {
  const baseH = settings.value.density === 'compact' ? 26 : 32
  const padIcon = settings.value.density === 'compact' ? 8 : 12
  const padFont = settings.value.density === 'compact' ? 10 : 14
  const rowH = Math.max(baseH, settings.value.iconSize + padIcon, settings.value.fontSize + padFont)
  return {
    '--pv-font': `${settings.value.fontSize}px`,
    '--pv-icon': `${settings.value.iconSize}px`,
    '--pv-ui-icon': `${settings.value.uiIconSize}px`,
    '--pv-ctrl-icon': `${settings.value.tabControlIconSize}px`,
    '--pv-row-h': `${rowH}px`,
  }
})

function scrollToSection(id: string) {
  activeSection.value = id
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function loadCommands() {
  try {
    const all = await chrome.commands.getAll()
    commands.value = [...all].sort((a, b) => {
      const ai = COMMAND_ORDER.indexOf(a.name ?? '')
      const bi = COMMAND_ORDER.indexOf(b.name ?? '')
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })
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
  void chrome.tabs
    .create({ url: chrome.runtime.getURL('welcome.html'), active: true })
    .catch(() => {})
}

function commandLabel(cmd: chrome.commands.Command): string {
  if (cmd.name && COMMAND_LABELS[cmd.name]) return COMMAND_LABELS[cmd.name]
  return cmd.description || cmd.name || ''
}

function colorLabel(color: ChromeGroupColor): string {
  return color.charAt(0).toUpperCase() + color.slice(1)
}

async function openBrowserSyncSettings() {
  const url = (await isVivaldi()) ? 'vivaldi://settings/sync/' : 'chrome://settings/syncSetup'
  await chrome.tabs.create({ url, active: true }).catch(() => {})
}

const syncAccountName = computed(() =>
  vivaldiDetected.value ? 'Vivaldi Account' : 'Google Account'
)

const syncQuotaPercent = computed(() =>
  Math.min(100, Math.round((syncMeta.value.bytesInUse / SYNC_QUOTA_BYTES) * 100))
)

function formatSyncBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  const kb = bytes / 1024
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`
}

function formatSyncTimestamp(ts: number | null): string {
  if (!ts) return 'Not synced yet'
  const d = new Date(ts)
  const now = new Date()
  const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Today, ${timeStr}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeStr}`
}

async function runSyncNow(silent = false) {
  if (syncingNow.value) return
  syncingNow.value = true
  try {
    let nextMeta: SyncStateMeta | undefined
    try {
      const res = await chrome.runtime.sendMessage<{
        ok?: boolean
        error?: string
        meta?: SyncStateMeta
      }>({ type: 'vberry:sync-now' })
      if (res?.meta) nextMeta = normalizeSyncMeta(res.meta)
    } catch {
      // Fall back to in-page reconcile if background worker is restarting
    }
    if (!nextMeta) {
      nextMeta = await reconcileSync()
    }
    syncMeta.value = nextMeta
    if (!silent) {
      flashStatus(nextMeta.lastError ? 'Sync issue' : 'Synced')
    }
  } finally {
    syncingNow.value = false
  }
}

async function updateSyncToggle<K extends keyof SyncConfig>(key: K, value: SyncConfig[K]) {
  syncConfig.value[key] = value
  await saveSyncConfig({ [key]: value })
  if (syncConfig.value.enabled && (key === 'enabled' || value === true)) {
    await runSyncNow(true)
  }
  flashStatus(syncConfig.value.enabled ? 'Sync updated' : 'Sync paused')
}

async function load() {
  const [s, p, sc, sm, viv] = await Promise.all([
    loadSettings(),
    loadSavedPanels(),
    loadSyncConfig(),
    loadSyncMeta(),
    isVivaldi(),
    loadCommands(),
  ])
  settings.value = s
  savedPanels.value = p
  syncConfig.value = sc
  syncMeta.value = sm
  vivaldiDetected.value = viv
  applyTheme(s)
  if (location.hash === '#import') {
    activeSection.value = 'sec-backup'
    setTimeout(() => scrollToSection('sec-backup'), 60)
  } else if (location.hash === '#sync') {
    activeSection.value = 'sec-sync'
    setTimeout(() => scrollToSection('sec-sync'), 60)
  }
  if (sc.enabled && sm.lastSyncedAt === null) {
    void runSyncNow(true)
  }
}

const systemPrefersDark = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-color-scheme: dark)').matches

const autoThemeCards = computed(() =>
  AUTO_THEME_GROUPS.map(g => {
    const lightP = getEffectivePresetPalette(g.lightId, settings.value.themeOverrides)
    const darkP = getEffectivePresetPalette(g.darkId, settings.value.themeOverrides)
    return {
      ...g,
      lightP,
      darkP,
      lightAccent: lightP.defaultAccent,
      darkAccent: darkP.defaultAccent,
    }
  })
)

const themeCards = computed(() =>
  THEME_ORDER.map(id => {
    const p = getEffectivePresetPalette(id, settings.value.themeOverrides)
    return {
      ...p,
      previewAccent: p.defaultAccent,
    }
  })
)

const customThemeCards = computed(() =>
  (settings.value.customThemes ?? []).map(ct => {
    const p = deriveThemePaletteFromColors(
      {
        id: ct.id,
        name: ct.name || 'Custom theme',
        tagline: `Custom ${ct.scheme} theme`,
        isCustom: true,
      },
      ct
    )
    return {
      ...p,
      previewAccent: p.defaultAccent,
    }
  })
)

const activePalette = computed(() => resolveThemePalette(settings.value, systemPrefersDark()))

const activeCustomTheme = computed<CustomTheme | null>(
  () => settings.value.customThemes.find(t => t.id === settings.value.theme) ?? null
)

const activeAutoGroup = computed(
  () => AUTO_THEME_GROUPS.find(g => g.id === settings.value.theme) ?? null
)

const editablePresetId = computed<PresetThemeId>(() => {
  if (activeAutoGroup.value) {
    return autoEditVariant.value === 'dark'
      ? activeAutoGroup.value.darkId
      : activeAutoGroup.value.lightId
  }
  return resolveEffectiveThemeId(settings.value.theme, systemPrefersDark())
})

const editablePalette = computed(() => {
  if (activeCustomTheme.value) {
    return deriveThemePaletteFromColors(
      {
        id: activeCustomTheme.value.id,
        name: activeCustomTheme.value.name || 'Custom theme',
        tagline: 'Custom theme',
        isCustom: true,
      },
      activeCustomTheme.value
    )
  }
  return getEffectivePresetPalette(editablePresetId.value, settings.value.themeOverrides)
})

let colorSaveTimer: ReturnType<typeof setTimeout> | undefined
function scheduleThemeSettingsSave(patch: Partial<Settings>, msg = 'Theme updated') {
  applyTheme(settings.value)
  clearTimeout(colorSaveTimer)
  colorSaveTimer = setTimeout(() => {
    void saveSettings(patch).then(() => flashStatus(msg))
  }, 120)
}

function selectTheme(id: ThemeId) {
  if (isAutoThemeId(id)) {
    autoEditVariant.value = systemPrefersDark() ? 'dark' : 'light'
  }
  void updateSetting('theme', id)
}

function toggleThemeEditor() {
  if (!themeEditorOpen.value && isAutoThemeId(settings.value.theme)) {
    autoEditVariant.value = systemPrefersDark() ? 'dark' : 'light'
  }
  themeEditorOpen.value = !themeEditorOpen.value
}

async function createCustomThemeFromCurrent() {
  const src = editablePalette.value
  const index = settings.value.customThemes.length + 1
  const created: CustomTheme = {
    id: uid('theme'),
    name: activeCustomTheme.value ? `${src.name} copy` : `Custom theme ${index}`,
    scheme: src.scheme,
    bg: src.bg,
    surface: src.surface,
    bgSubtle: src.bgSubtle,
    border: src.border,
    text: src.text,
    textMuted: src.textMuted,
    defaultAccent: src.defaultAccent,
  }
  const nextCustom = [...settings.value.customThemes, created]
  settings.value.customThemes = nextCustom
  settings.value.theme = created.id
  themeEditorOpen.value = true
  applyTheme(settings.value)
  await saveSettings({
    customThemes: nextCustom,
    theme: created.id,
  })
  flashStatus('Custom theme created')
}

async function deleteActiveCustomTheme() {
  const cur = activeCustomTheme.value
  if (!cur) return
  const nextCustom = settings.value.customThemes.filter(t => t.id !== cur.id)
  const fallbackTheme: ThemeId = vivaldiDetected.value ? 'vivaldi' : 'auto'
  settings.value.customThemes = nextCustom
  settings.value.theme = fallbackTheme
  applyTheme(settings.value)
  await saveSettings({ customThemes: nextCustom, theme: fallbackTheme })
  flashStatus('Custom theme removed')
}

function updateCustomThemeName(name: string) {
  const cur = activeCustomTheme.value
  if (!cur) return
  cur.name = name.trim() || 'Custom theme'
  scheduleThemeSettingsSave({ customThemes: settings.value.customThemes })
}

function updateEditableThemeScheme(scheme: 'light' | 'dark') {
  if (activeCustomTheme.value) {
    activeCustomTheme.value.scheme = scheme
    scheduleThemeSettingsSave({ customThemes: settings.value.customThemes })
    return
  }
  const pid = editablePresetId.value
  const nextOverrides = {
    ...settings.value.themeOverrides,
    [pid]: { ...(settings.value.themeOverrides[pid] ?? {}), scheme },
  }
  settings.value.themeOverrides = nextOverrides
  scheduleThemeSettingsSave({ themeOverrides: nextOverrides })
}

function updateEditableThemeColor(key: keyof Omit<ThemeColors, 'scheme'>, rawValue: string) {
  const trimmed = rawValue.trim()
  if (!parseHexRgb(trimmed)) return
  const hex = normalizeHex(trimmed, editablePalette.value[key])

  const patch: Partial<Settings> = {}
  if (activeCustomTheme.value) {
    activeCustomTheme.value[key] = hex
    patch.customThemes = settings.value.customThemes
  } else {
    const pid = editablePresetId.value
    const nextOverrides = {
      ...settings.value.themeOverrides,
      [pid]: { ...(settings.value.themeOverrides[pid] ?? {}), [key]: hex },
    }
    settings.value.themeOverrides = nextOverrides
    patch.themeOverrides = nextOverrides
  }

  scheduleThemeSettingsSave(patch)
}

async function resetPresetCustomization() {
  const pid = editablePresetId.value
  if (!settings.value.themeOverrides[pid]) return
  const nextOverrides = { ...settings.value.themeOverrides }
  delete nextOverrides[pid]
  settings.value.themeOverrides = nextOverrides
  applyTheme(settings.value)
  await saveSettings({ themeOverrides: nextOverrides })
  flashStatus('Preset reset')
}

function applyTheme(s: Settings) {
  applyVisualTheme(s)
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

async function resetSizing() {
  const patch = {
    fontSize: DEFAULT_SETTINGS.fontSize,
    iconSize: DEFAULT_SETTINGS.iconSize,
    uiIconSize: DEFAULT_SETTINGS.uiIconSize,
    tabControlIconSize: DEFAULT_SETTINGS.tabControlIconSize,
  }
  Object.assign(settings.value, patch)
  await saveSettings(patch)
  flashStatus('Sizes reset')
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

function onScrollSpy() {
  const threshold = 130
  for (let i = SECTIONS.length - 1; i >= 0; i--) {
    const el = document.getElementById(SECTIONS[i].id)
    if (el && el.getBoundingClientRect().top <= threshold) {
      activeSection.value = SECTIONS[i].id
      return
    }
  }
}

function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area !== 'local') return
  if (changes[STORAGE_KEYS.settings]) {
    settings.value = normalizeSettings(changes[STORAGE_KEYS.settings].newValue)
    applyTheme(settings.value)
  }
  if (changes[STORAGE_KEYS.savedPanels]) {
    savedPanels.value = toArray<SavedPanel>(changes[STORAGE_KEYS.savedPanels].newValue)
  }
  if (changes[STORAGE_KEYS.syncConfig]) {
    syncConfig.value = normalizeSyncConfig(changes[STORAGE_KEYS.syncConfig].newValue)
  }
  if (changes[STORAGE_KEYS.syncMeta]) {
    syncMeta.value = normalizeSyncMeta(changes[STORAGE_KEYS.syncMeta].newValue)
  }
}

onMounted(() => {
  void load()
  window.addEventListener('focus', loadCommands)
  window.addEventListener('scroll', onScrollSpy, { passive: true })
  chrome.storage?.onChanged?.addListener(onStorageChanged)
})

onUnmounted(() => {
  clearTimeout(colorSaveTimer)
  window.removeEventListener('focus', loadCommands)
  window.removeEventListener('scroll', onScrollSpy)
  chrome.storage?.onChanged?.removeListener(onStorageChanged)
})
</script>

<template>
  <div class="studio">
    <!-- Sticky Navigation Rail -->
    <aside class="rail">
      <div class="rail-inner">
        <div class="brand">
          <img class="logo" src="/icons/icon-128.png" alt="VBerry" />
          <div>
            <div class="brand-name">VBerry</div>
            <div class="brand-sub">Preferences</div>
          </div>
        </div>

        <nav class="rail-nav" aria-label="Settings sections">
          <button
            v-for="sec in SECTIONS"
            :key="sec.id"
            type="button"
            class="nav-item"
            :class="{ active: activeSection === sec.id }"
            @click="scrollToSection(sec.id)"
          >
            {{ sec.label }}
          </button>
        </nav>

        <div class="rail-foot">
          <div class="env-badge">
            <span class="env-dot" />
            <span>{{ vivaldiDetected ? 'Vivaldi mode active' : 'Chromium mode active' }}</span>
          </div>
          <button type="button" class="guide-link" @click="openWelcomeGuide">
            Open welcome guide
          </button>
          <div v-if="statusMsg" class="status-pill" role="status">{{ statusMsg }}</div>
        </div>
      </div>
    </aside>

    <!-- Main Preferences Column -->
    <main class="content">
      <!-- Keyboard Shortcuts -->
      <section id="sec-shortcuts" class="section-block">
        <div class="section-head">
          <div>
            <h2>Keyboard shortcuts</h2>
            <p class="hint">
              Assign keys in your browser's extension shortcuts page. This list refreshes
              automatically when you switch back.
            </p>
          </div>
          <button type="button" class="btn-primary" @click="openShortcutsPage">
            Set shortcuts
          </button>
        </div>

        <div class="surface-panel">
          <div v-for="cmd in commands" :key="cmd.name" class="setting-row">
            <div class="label">{{ commandLabel(cmd) }}</div>
            <kbd class="kbd" :class="{ unset: !cmd.shortcut }">{{ cmd.shortcut || 'Not set' }}</kbd>
          </div>
        </div>

        <p class="tip-line">
          <template v-if="vivaldiDetected">
            Left-click the VBerry toolbar button to open Quick Search, or press your side panel
            shortcut anytime to toggle the vertical tab tree.
          </template>
          <template v-else>
            Left-click the VBerry toolbar button for Quick Search, right-click it to open the side
            panel, or type <code>=</code> then Space in the address bar.
          </template>
        </p>
      </section>

      <!-- Quick Search -->
      <section id="sec-search" class="section-block">
        <div class="section-head">
          <div>
            <h2>Quick Search</h2>
            <p class="hint">Control what opens first and which sources are searched together.</p>
          </div>
        </div>

        <div class="surface-panel">
          <div class="setting-row">
            <div>
              <div class="label">Default popup view</div>
              <div class="desc">
                First view shown when you open the toolbar popup.
                <span
                  v-if="settings.popupDefaultView === 'search' && !settings.unifiedSearch"
                  class="warn-inline"
                >
                  Unified Search is turned off, so the popup will open to your active tab group.
                </span>
              </div>
            </div>
            <select
              :value="settings.popupDefaultView"
              @change="
                updateSetting(
                  'popupDefaultView',
                  ($event.target as HTMLSelectElement).value as Settings['popupDefaultView']
                )
              "
            >
              <option value="search">Unified Search</option>
              <option value="tabs">Tabs (active group)</option>
              <option value="bookmarks">Bookmarks</option>
              <option value="history">History</option>
              <option value="snapshots">Snapshots</option>
            </select>
          </div>

          <label class="setting-row check-row">
            <div>
              <div class="label">Unified Search</div>
              <div class="desc">
                Search open tabs, bookmarks, and recent history together in one ranked list.
              </div>
            </div>
            <input
              type="checkbox"
              class="vb-switch"
              :checked="settings.unifiedSearch"
              @change="updateSetting('unifiedSearch', ($event.target as HTMLInputElement).checked)"
            />
          </label>

          <template v-if="settings.unifiedSearch">
            <div class="nested-box">
              <div class="nested-row">
                <span class="nested-title">Include when searching</span>
                <div class="chip-grid">
                  <label class="chip-toggle" :class="{ on: settings.unifiedSearchTabs }">
                    <input
                      type="checkbox"
                      :checked="settings.unifiedSearchTabs"
                      @change="
                        updateSetting(
                          'unifiedSearchTabs',
                          ($event.target as HTMLInputElement).checked
                        )
                      "
                    />
                    <span>Open tabs</span>
                  </label>
                  <label class="chip-toggle" :class="{ on: settings.unifiedSearchBookmarks }">
                    <input
                      type="checkbox"
                      :checked="settings.unifiedSearchBookmarks"
                      @change="
                        updateSetting(
                          'unifiedSearchBookmarks',
                          ($event.target as HTMLInputElement).checked
                        )
                      "
                    />
                    <span>Bookmarks</span>
                  </label>
                  <label class="chip-toggle" :class="{ on: settings.unifiedSearchHistory }">
                    <input
                      type="checkbox"
                      :checked="settings.unifiedSearchHistory"
                      @change="
                        updateSetting(
                          'unifiedSearchHistory',
                          ($event.target as HTMLInputElement).checked
                        )
                      "
                    />
                    <span>History</span>
                  </label>
                </div>
              </div>

              <div class="nested-row">
                <span class="nested-title">Show before typing</span>
                <div class="chip-grid">
                  <label class="chip-toggle" :class="{ on: settings.unifiedEmptyShowTabs }">
                    <input
                      type="checkbox"
                      :checked="settings.unifiedEmptyShowTabs"
                      @change="
                        updateSetting(
                          'unifiedEmptyShowTabs',
                          ($event.target as HTMLInputElement).checked
                        )
                      "
                    />
                    <span>Recent tabs</span>
                  </label>
                  <label class="chip-toggle" :class="{ on: settings.unifiedEmptyShowBookmarks }">
                    <input
                      type="checkbox"
                      :checked="settings.unifiedEmptyShowBookmarks"
                      @change="
                        updateSetting(
                          'unifiedEmptyShowBookmarks',
                          ($event.target as HTMLInputElement).checked
                        )
                      "
                    />
                    <span>Saved bookmarks</span>
                  </label>
                  <label class="chip-toggle" :class="{ on: settings.unifiedEmptyShowHistory }">
                    <input
                      type="checkbox"
                      :checked="settings.unifiedEmptyShowHistory"
                      @change="
                        updateSetting(
                          'unifiedEmptyShowHistory',
                          ($event.target as HTMLInputElement).checked
                        )
                      "
                    />
                    <span>Recent history</span>
                  </label>
                </div>
              </div>
            </div>

            <label class="setting-row check-row">
              <div>
                <div class="label">Keep Unified Search in popup only</div>
                <div class="desc">
                  Hide the Unified Search icon from the side panel while keeping it in Quick Search.
                </div>
              </div>
              <input
                type="checkbox"
                class="vb-switch"
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
              <div class="label">Highlight top match while typing</div>
              <div class="desc">Press Enter immediately to jump to the best match.</div>
            </div>
            <input
              type="checkbox"
              class="vb-switch"
              :checked="settings.autoHighlightSearchMatch"
              @change="
                updateSetting(
                  'autoHighlightSearchMatch',
                  ($event.target as HTMLInputElement).checked
                )
              "
            />
          </label>

          <label class="setting-row check-row">
            <div>
              <div class="label">Search tabs across all groups</div>
              <div class="desc">Turn off to filter only the group currently open.</div>
            </div>
            <input
              type="checkbox"
              class="vb-switch"
              :checked="settings.searchAllGroups"
              @change="updateSetting('searchAllGroups', ($event.target as HTMLInputElement).checked)"
            />
          </label>

          <label class="setting-row check-row">
            <div>
              <div class="label">Keep search focused when switching popup views</div>
              <div class="desc">Leave the cursor in the search box when clicking group pills.</div>
            </div>
            <input
              type="checkbox"
              class="vb-switch"
              :checked="settings.focusSearchOnPanelSwitch"
              @change="
                updateSetting(
                  'focusSearchOnPanelSwitch',
                  ($event.target as HTMLInputElement).checked
                )
              "
            />
          </label>

          <label class="setting-row check-row">
            <div>
              <div class="label">Clear search after opening a result</div>
              <div class="desc">Reset the search query once you jump to a match.</div>
            </div>
            <input
              type="checkbox"
              class="vb-switch"
              :checked="settings.clearSearchOnSelect"
              @change="
                updateSetting('clearSearchOnSelect', ($event.target as HTMLInputElement).checked)
              "
            />
          </label>

          <label class="setting-row check-row">
            <div>
              <div class="label">Clear search when switching views</div>
              <div class="desc">
                Turn off to keep your query as you move between Tabs, Bookmarks, and History.
              </div>
            </div>
            <input
              type="checkbox"
              class="vb-switch"
              :checked="settings.clearSearchOnPanelSwitch"
              @change="
                updateSetting(
                  'clearSearchOnPanelSwitch',
                  ($event.target as HTMLInputElement).checked
                )
              "
            />
          </label>

          <div class="setting-row">
            <div>
              <div class="label">History search window</div>
              <div class="desc">
                How far back to search in History and Unified Search.
                <span v-if="settings.historyDays === 0" class="warn-inline">
                  Searching all-time history may feel slower on multi-year profiles.
                </span>
              </div>
            </div>
            <select
              :value="settings.historyDays"
              @change="
                updateSetting('historyDays', Number(($event.target as HTMLSelectElement).value))
              "
            >
              <option v-for="opt in HISTORY_RANGE_OPTIONS" :key="opt.days" :value="opt.days">
                {{ opt.label }}
              </option>
            </select>
          </div>
        </div>
      </section>

      <!-- Appearance & Tabs -->
      <section id="sec-appearance" class="section-block">
        <div class="section-head">
          <div>
            <h2>Appearance &amp; tabs</h2>
            <p class="hint">
              Tune theme, spacing, and icon proportions with instant visual feedback below.
            </p>
          </div>
          <button
            v-if="hasCustomSizing"
            type="button"
            class="btn-secondary"
            @click="resetSizing"
          >
            Reset sizes
          </button>
        </div>

        <!-- Live Interactive Preview -->
        <div class="live-preview" :style="previewVars">
          <div class="pv-top">
            <div class="pv-pills">
              <span class="pv-pill" style="--pill-color: var(--accent)">
                <span>Tabs</span>
                <span v-if="settings.showTabCounts" class="pv-cnt">2</span>
              </span>
              <span class="pv-pill active" style="--pill-color: var(--grp-purple)">
                <span>Research</span>
                <span v-if="settings.showTabCounts" class="pv-cnt">3</span>
              </span>
              <span class="pv-pill" style="--pill-color: var(--grp-blue)">
                <span>Work</span>
                <span v-if="settings.showTabCounts" class="pv-cnt">5</span>
              </span>
            </div>
            <div class="pv-utils">
              <span class="pv-util">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5" />
                  <path d="m10.5 10.5 3.2 3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                </svg>
              </span>
              <span class="pv-util">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4.2 2.2h7.6a1 1 0 0 1 1 1v10.6L8 11.1l-4.8 2.7V3.2a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
                </svg>
              </span>
            </div>
          </div>

          <div class="pv-tree">
            <div class="pv-row active" @click="previewFolded = !previewFolded">
              <span class="pv-fold" title="Click to test folding">
                <svg :class="{ folded: previewFolded }" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
              <span class="pv-title">Architecture RFC — Tab Tree Engine</span>
              <span v-if="previewFolded" class="pv-badge">+2</span>
              <span class="pv-close">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" />
                </svg>
              </span>
            </div>

            <template v-if="!previewFolded">
              <div class="pv-row child">
                <span class="pv-guide" />
                <span class="pv-fav">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4" />
                    <path d="M2.5 6h11" fill="none" stroke="currentColor" stroke-width="1.3" />
                  </svg>
                </span>
                <span class="pv-title">Vivaldi WebPanel lifecycle notes</span>
              </div>
              <div class="pv-row child">
                <span class="pv-guide" />
                <span class="pv-fav">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4" />
                    <path d="M2.5 6h11" fill="none" stroke="currentColor" stroke-width="1.3" />
                  </svg>
                </span>
                <span class="pv-title">Sidebery backup schema reference</span>
              </div>
            </template>
          </div>
        </div>

        <div class="surface-panel">
          <div class="theme-block">
            <div class="theme-block-head">
              <div>
                <div class="label">Theme</div>
                <div class="desc">
                  Choose Vivaldi or Chrome defaults, pick a studio palette, or customize and sync
                  your own themes.
                </div>
              </div>
              <div class="theme-head-actions">
                <button type="button" class="btn-secondary" @click="toggleThemeEditor">
                  {{ themeEditorOpen ? 'Done customizing' : 'Customize colors' }}
                </button>
                <button type="button" class="btn-primary" @click="createCustomThemeFromCurrent">
                  New custom theme
                </button>
              </div>
            </div>

            <div class="theme-grid" role="radiogroup" aria-label="Theme">
              <!-- Adaptive Light / Dark Split Cards (System, Vivaldi Default, Chrome Default) -->
              <button
                v-for="ag in autoThemeCards"
                :key="ag.id"
                type="button"
                class="theme-card"
                :class="{ selected: settings.theme === ag.id }"
                :title="ag.tagline"
                @click="selectTheme(ag.id)"
              >
                <div class="tc-preview tc-split">
                  <div
                    class="tc-half"
                    :style="{ background: ag.lightP.bg, borderColor: ag.lightP.border }"
                  >
                    <span class="tc-bar" :style="{ background: ag.lightP.bgSubtle }" />
                    <span
                      class="tc-row"
                      :style="{
                        background: ag.lightP.surface,
                        borderLeftColor: ag.lightAccent,
                      }"
                    />
                  </div>
                  <div
                    class="tc-half"
                    :style="{ background: ag.darkP.bg, borderColor: ag.darkP.border }"
                  >
                    <span class="tc-bar" :style="{ background: ag.darkP.bgSubtle }" />
                    <span
                      class="tc-row"
                      :style="{
                        background: ag.darkP.surface,
                        borderLeftColor: ag.darkAccent,
                      }"
                    />
                  </div>
                </div>
                <div class="tc-meta">
                  <span class="tc-name">{{ ag.name }}</span>
                  <span class="tc-tag">{{ ag.tag }}</span>
                </div>
              </button>

              <!-- Concrete Built-in Theme Cards -->
              <button
                v-for="tc in themeCards"
                :key="tc.id"
                type="button"
                class="theme-card"
                :class="{ selected: settings.theme === tc.id }"
                :title="tc.tagline"
                @click="selectTheme(tc.id)"
              >
                <div
                  class="tc-preview"
                  :style="{ background: tc.bg, borderColor: tc.border }"
                >
                  <div class="tc-top" :style="{ background: tc.bgSubtle, borderColor: tc.border }">
                    <span class="tc-pill" :style="{ background: tc.surface }" />
                    <span class="tc-dot" :style="{ background: tc.previewAccent }" />
                  </div>
                  <div class="tc-body">
                    <div
                      class="tc-active-line"
                      :style="{
                        background: tc.surface,
                        borderLeftColor: tc.previewAccent,
                      }"
                    >
                      <span class="tc-ink" :style="{ background: tc.text }" />
                    </div>
                    <div class="tc-muted-line">
                      <span class="tc-ink muted" :style="{ background: tc.textMuted }" />
                    </div>
                  </div>
                </div>
                <div class="tc-meta">
                  <span class="tc-name">{{ tc.name }}</span>
                  <span class="tc-tag">
                    {{ tc.scheme === 'dark' ? 'Dark' : 'Light' }}{{ tc.isModifiedPreset ? ' · Edited' : '' }}
                  </span>
                </div>
              </button>

              <!-- User-Created Custom Theme Cards -->
              <button
                v-for="ct in customThemeCards"
                :key="ct.id"
                type="button"
                class="theme-card"
                :class="{ selected: settings.theme === ct.id }"
                :title="ct.tagline"
                @click="selectTheme(ct.id)"
              >
                <div
                  class="tc-preview"
                  :style="{ background: ct.bg, borderColor: ct.border }"
                >
                  <div class="tc-top" :style="{ background: ct.bgSubtle, borderColor: ct.border }">
                    <span class="tc-pill" :style="{ background: ct.surface }" />
                    <span class="tc-dot" :style="{ background: ct.previewAccent }" />
                  </div>
                  <div class="tc-body">
                    <div
                      class="tc-active-line"
                      :style="{
                        background: ct.surface,
                        borderLeftColor: ct.previewAccent,
                      }"
                    >
                      <span class="tc-ink" :style="{ background: ct.text }" />
                    </div>
                    <div class="tc-muted-line">
                      <span class="tc-ink muted" :style="{ background: ct.textMuted }" />
                    </div>
                  </div>
                </div>
                <div class="tc-meta">
                  <span class="tc-name">{{ ct.name }}</span>
                  <span class="tc-tag">Custom</span>
                </div>
              </button>
            </div>

            <!-- Interactive Theme Color Studio -->
            <div v-if="themeEditorOpen" class="theme-editor">
              <div class="theme-editor-head">
                <div class="theme-editor-title">
                  <template v-if="activeCustomTheme">
                    <input
                      type="text"
                      class="text-input theme-name-input"
                      aria-label="Custom theme name"
                      :value="activeCustomTheme.name"
                      placeholder="Theme name"
                      @change="updateCustomThemeName(($event.target as HTMLInputElement).value)"
                    />
                  </template>
                  <template v-else>
                    <span class="editor-heading">Customizing {{ editablePalette.name }}</span>
                    <div
                      v-if="activeAutoGroup"
                      class="seg-group"
                      role="radiogroup"
                      aria-label="Variant to edit"
                    >
                      <button
                        type="button"
                        class="seg-btn"
                        :class="{ active: autoEditVariant === 'light' }"
                        @click="autoEditVariant = 'light'"
                      >
                        Light variant
                      </button>
                      <button
                        type="button"
                        class="seg-btn"
                        :class="{ active: autoEditVariant === 'dark' }"
                        @click="autoEditVariant = 'dark'"
                      >
                        Dark variant
                      </button>
                    </div>
                  </template>
                </div>

                <div class="theme-editor-actions">
                  <div class="seg-group" role="radiogroup" aria-label="Color scheme">
                    <button
                      type="button"
                      class="seg-btn"
                      :class="{ active: editablePalette.scheme === 'light' }"
                      @click="updateEditableThemeScheme('light')"
                    >
                      Light
                    </button>
                    <button
                      type="button"
                      class="seg-btn"
                      :class="{ active: editablePalette.scheme === 'dark' }"
                      @click="updateEditableThemeScheme('dark')"
                    >
                      Dark
                    </button>
                  </div>

                  <template v-if="activeCustomTheme">
                    <button
                      type="button"
                      class="btn-secondary"
                      @click="createCustomThemeFromCurrent"
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      class="btn-danger-ghost"
                      @click="deleteActiveCustomTheme"
                    >
                      Delete
                    </button>
                  </template>
                  <template v-else>
                    <button
                      type="button"
                      class="btn-secondary"
                      @click="createCustomThemeFromCurrent"
                    >
                      Save as new theme
                    </button>
                    <button
                      v-if="editablePalette.isModifiedPreset"
                      type="button"
                      class="btn-danger-ghost"
                      @click="resetPresetCustomization"
                    >
                      Reset preset
                    </button>
                  </template>
                </div>
              </div>

              <div class="color-token-grid">
                <div v-for="field in THEME_COLOR_FIELDS" :key="field.key" class="token-cell">
                  <label class="token-well" :title="`Pick ${field.label.toLowerCase()} color`">
                    <input
                      type="color"
                      :value="editablePalette[field.key]"
                      @input="
                        updateEditableThemeColor(
                          field.key,
                          ($event.target as HTMLInputElement).value
                        )
                      "
                    />
                    <span
                      class="token-swatch"
                      :style="{ background: editablePalette[field.key] }"
                    />
                  </label>
                  <div class="token-meta">
                    <span class="token-label">{{ field.label }}</span>
                    <input
                      type="text"
                      class="token-hex-input"
                      maxlength="7"
                      :aria-label="`${field.label} hex code`"
                      :value="editablePalette[field.key].toUpperCase()"
                      @change="
                        updateEditableThemeColor(
                          field.key,
                          ($event.target as HTMLInputElement).value
                        )
                      "
                    />
                  </div>
                </div>
              </div>
            </div>

            <div v-if="activePalette.vivaldiSlug" class="vivaldi-theme-note">
              Matching Vivaldi browser theme:
              <code>vivaldi themes/{{ activePalette.vivaldiSlug }}.zip</code>
              <span class="vivaldi-note-sub">(import in Vivaldi Settings → Themes → Open Theme)</span>
            </div>
          </div>

          <div class="setting-row">
            <div>
              <div class="label">Row density</div>
              <div class="desc">Compact fits more open tabs into a single screen height.</div>
            </div>
            <div class="seg-group" role="radiogroup" aria-label="Row density">
              <button
                type="button"
                class="seg-btn"
                :class="{ active: settings.density === 'comfortable' }"
                @click="updateSetting('density', 'comfortable')"
              >
                Comfortable
              </button>
              <button
                type="button"
                class="seg-btn"
                :class="{ active: settings.density === 'compact' }"
                @click="updateSetting('density', 'compact')"
              >
                Compact
              </button>
            </div>
          </div>

          <div class="setting-row">
            <div>
              <div class="label">Text size</div>
              <div class="desc">Font size in the side panel and Quick Search popup.</div>
            </div>
            <div class="range-wrap">
              <input
                type="range"
                min="10"
                max="20"
                step="1"
                :value="settings.fontSize"
                @input="
                  updateSetting('fontSize', Number(($event.target as HTMLInputElement).value))
                "
              />
              <span class="range-val">{{ settings.fontSize }}px</span>
            </div>
          </div>

          <div class="setting-row">
            <div>
              <div class="label">Site icon size</div>
              <div class="desc">Favicon size on regular and pinned tabs.</div>
            </div>
            <div class="range-wrap">
              <input
                type="range"
                min="12"
                max="28"
                step="1"
                :value="settings.iconSize"
                @input="
                  updateSetting('iconSize', Number(($event.target as HTMLInputElement).value))
                "
              />
              <span class="range-val">{{ settings.iconSize }}px</span>
            </div>
          </div>

          <div class="setting-row">
            <div>
              <div class="label">Toolbar icon size</div>
              <div class="desc">Navigation icons in the top utility strip.</div>
            </div>
            <div class="range-wrap">
              <input
                type="range"
                min="14"
                max="26"
                step="1"
                :value="settings.uiIconSize"
                @input="
                  updateSetting('uiIconSize', Number(($event.target as HTMLInputElement).value))
                "
              />
              <span class="range-val">{{ settings.uiIconSize }}px</span>
            </div>
          </div>

          <div class="setting-row">
            <div>
              <div class="label">Close &amp; fold icon size</div>
              <div class="desc">Close button and branch chevron size on each tab row.</div>
            </div>
            <div class="range-wrap">
              <input
                type="range"
                min="8"
                max="20"
                step="1"
                :value="settings.tabControlIconSize"
                @input="
                  updateSetting(
                    'tabControlIconSize',
                    Number(($event.target as HTMLInputElement).value)
                  )
                "
              />
              <span class="range-val">{{ settings.tabControlIconSize }}px</span>
            </div>
          </div>

          <label class="setting-row check-row">
            <div>
              <div class="label">Nest child tabs under their opener</div>
              <div class="desc">Links opened from a page automatically indent underneath it.</div>
            </div>
            <input
              type="checkbox"
              class="vb-switch"
              :checked="settings.autoNestChildTabs"
              @change="
                updateSetting('autoNestChildTabs', ($event.target as HTMLInputElement).checked)
              "
            />
          </label>

          <label class="setting-row check-row">
            <div>
              <div class="label">Show tab counts on group pills</div>
              <div class="desc">Display the number of open tabs next to each group name.</div>
            </div>
            <input
              type="checkbox"
              class="vb-switch"
              :checked="settings.showTabCounts"
              @change="updateSetting('showTabCounts', ($event.target as HTMLInputElement).checked)"
            />
          </label>

          <label class="setting-row check-row">
            <div>
              <div class="label">Collapse inactive groups in browser tab bar</div>
              <div class="desc">
                Automatically collapse native Chrome tab groups you aren't viewing.
              </div>
            </div>
            <input
              type="checkbox"
              class="vb-switch"
              :checked="settings.autoCollapseInactiveGroups"
              @change="
                updateSetting(
                  'autoCollapseInactiveGroups',
                  ($event.target as HTMLInputElement).checked
                )
              "
            />
          </label>

          <label class="setting-row check-row">
            <div>
              <div class="label">Confirm before closing all tabs in a group</div>
              <div class="desc">Ask before closing multiple tabs from a group menu.</div>
            </div>
            <input
              type="checkbox"
              class="vb-switch"
              :checked="settings.confirmCloseGroup"
              @change="
                updateSetting('confirmCloseGroup', ($event.target as HTMLInputElement).checked)
              "
            />
          </label>

          <div class="setting-row">
            <div>
              <div class="label">Browser mode</div>
              <div class="desc">
                Adapts new-tab pages and virtual vs native tab groups automatically.
              </div>
            </div>
            <select
              :value="settings.browserMode"
              @change="
                updateSetting(
                  'browserMode',
                  ($event.target as HTMLSelectElement).value as Settings['browserMode']
                )
              "
            >
              <option value="auto">Auto-detect</option>
              <option value="chrome">Chrome</option>
              <option value="vivaldi">Vivaldi</option>
            </select>
          </div>
        </div>
      </section>

      <!-- Saved Groups & Auto-Sorting -->
      <section id="sec-groups" class="section-block">
        <div class="section-head">
          <div>
            <h2>Saved groups &amp; auto-sorting</h2>
            <p class="hint">
              Keep favorite groups pinned in your sidebar and route matching URLs into them
              automatically.
            </p>
          </div>
        </div>

        <div class="surface-panel padded-panel">
          <form class="add-panel-form" @submit.prevent="addSavedPanel">
            <input
              v-model="newPanelTitle"
              placeholder="Group name (e.g. Work, Docs, Shopping)"
              class="text-input"
            />
            <div class="swatch-strip" role="radiogroup" aria-label="New group color">
              <button
                v-for="c in CHROME_GROUP_COLORS"
                :key="c"
                type="button"
                class="mini-swatch"
                :class="{ selected: newPanelColor === c }"
                :style="{ background: `var(--grp-${c})` }"
                :title="colorLabel(c)"
                @click="newPanelColor = c"
              />
            </div>
            <button type="submit" class="btn-primary">Add group</button>
          </form>

          <div v-if="savedPanels.length === 0" class="empty-inline">
            No saved groups yet. Add one above to keep it pinned in your top bar or attach URL
            routing rules.
          </div>

          <div
            v-for="panel in savedPanels"
            :key="panel.id"
            class="panel-card"
            :style="{ '--panel-color': `var(--grp-${panel.color})` }"
          >
            <div class="panel-card-head">
              <strong>{{ panel.title }}</strong>
              <select
                :value="panel.color"
                aria-label="Group color"
                @change="
                  updatePanelColor(
                    panel,
                    ($event.target as HTMLSelectElement).value as ChromeGroupColor
                  )
                "
              >
                <option v-for="c in CHROME_GROUP_COLORS" :key="c" :value="c">
                  {{ colorLabel(c) }}
                </option>
              </select>
              <button type="button" class="btn-danger-ghost" @click="removeSavedPanel(panel.id)">
                Remove
              </button>
            </div>

            <div class="rules-list">
              <div v-if="panel.moveRules.length" class="rule-chips">
                <div v-for="r in panel.moveRules" :key="r.id" class="rule-chip">
                  <code>{{ r.pattern }}</code>
                  <button type="button" title="Remove rule" @click="removeMoveRule(panel, r.id)">
                    ×
                  </button>
                </div>
              </div>
              <form class="add-rule-form" @submit.prevent="addMoveRule(panel)">
                <input
                  v-model="newRulePatterns[panel.id]"
                  class="rule-input"
                  placeholder="Domain or regex rule (e.g. github.com or /linear\.app/i)"
                />
                <button type="submit" class="btn-secondary">Add rule</button>
              </form>
            </div>
          </div>
        </div>
      </section>

      <!-- Snapshots -->
      <section id="sec-snapshots" class="section-block">
        <div class="section-head">
          <div>
            <h2>Snapshots</h2>
            <p class="hint">
              Automatically back up open windows, groups, and nested tab hierarchies on a schedule.
            </p>
          </div>
        </div>

        <div class="surface-panel">
          <div class="setting-row">
            <div>
              <div class="label">Auto-save interval (minutes)</div>
              <div class="desc">Set to 0 to save snapshots manually only.</div>
            </div>
            <input
              type="number"
              min="0"
              step="15"
              class="num-input"
              :value="settings.autoSnapshotMinutes"
              @change="
                updateSetting(
                  'autoSnapshotMinutes',
                  Math.max(0, Number(($event.target as HTMLInputElement).value) || 0)
                )
              "
            />
          </div>

          <div class="setting-row">
            <div>
              <div class="label">Snapshots to keep</div>
              <div class="desc">Older snapshots roll off automatically past this limit.</div>
            </div>
            <input
              type="number"
              min="1"
              max="500"
              step="1"
              class="num-input"
              :value="settings.maxSnapshots"
              @change="
                updateSetting(
                  'maxSnapshots',
                  Math.max(
                    1,
                    Math.min(500, Math.round(Number(($event.target as HTMLInputElement).value) || 30))
                  )
                )
              "
            />
          </div>
        </div>
      </section>

      <!-- Account Sync -->
      <section id="sec-sync" class="section-block">
        <div class="section-head">
          <div>
            <h2>Account sync</h2>
            <p class="hint">
              Keep preferences, saved groups, and snapshots synced across your computers through
              your {{ syncAccountName }}.
            </p>
          </div>
          <div class="row-actions">
            <button type="button" class="btn-secondary" @click="openBrowserSyncSettings">
              {{ vivaldiDetected ? 'Open Vivaldi Sync' : 'Open Chrome Sync' }}
            </button>
            <button
              type="button"
              class="btn-primary"
              :disabled="!syncConfig.enabled || syncingNow"
              @click="runSyncNow(false)"
            >
              {{ syncingNow ? 'Syncing…' : 'Sync now' }}
            </button>
          </div>
        </div>

        <div class="surface-panel">
          <div class="sync-status-bar">
            <div class="sync-status-main">
              <div class="sync-headline">
                <span
                  class="sync-state-dot"
                  :class="{
                    paused: !syncConfig.enabled,
                    err: syncConfig.enabled && Boolean(syncMeta.lastError),
                  }"
                />
                <span class="sync-headline-text">
                  <template v-if="!syncConfig.enabled">Sync paused on this device</template>
                  <template v-else-if="syncMeta.lastError">Sync needs attention</template>
                  <template v-else>Active via {{ syncAccountName }}</template>
                </span>
              </div>
              <div class="sync-subline">
                <span>Last synced: {{ formatSyncTimestamp(syncMeta.lastSyncedAt) }}</span>
                <template v-if="syncConfig.enabled && syncConfig.syncSnapshots">
                  <span>·</span>
                  <span v-if="syncMeta.syncedSnapshotCount < syncMeta.totalSnapshotCount">
                    Newest {{ syncMeta.syncedSnapshotCount }} of
                    {{ syncMeta.totalSnapshotCount }} snapshots synced (all
                    {{ syncMeta.totalSnapshotCount }} kept locally)
                  </span>
                  <span v-else>
                    {{ syncMeta.syncedSnapshotCount }}
                    {{ syncMeta.syncedSnapshotCount === 1 ? 'snapshot' : 'snapshots' }} synced
                  </span>
                </template>
              </div>
              <div v-if="syncConfig.enabled && syncMeta.lastError" class="warn-inline">
                {{ syncMeta.lastError }}
              </div>
            </div>

            <div class="sync-meter-wrap" aria-label="Browser sync storage usage">
              <div class="sync-meter-nums">
                <strong>{{ formatSyncBytes(syncMeta.bytesInUse) }}</strong>
                <span>/ 100 KB</span>
              </div>
              <div class="sync-meter-track">
                <span
                  class="sync-meter-fill"
                  :class="{ high: syncQuotaPercent >= 90 }"
                  :style="{ width: `${Math.max(syncMeta.bytesInUse > 0 ? 2 : 0, syncQuotaPercent)}%` }"
                />
              </div>
            </div>
          </div>

          <label class="setting-row check-row">
            <div>
              <div class="label">Sync across signed-in devices</div>
              <div class="desc">
                Automatically push and pull updates in the background through your browser's native
                encrypted sync.
              </div>
            </div>
            <input
              type="checkbox"
              class="vb-switch"
              :checked="syncConfig.enabled"
              @change="updateSyncToggle('enabled', ($event.target as HTMLInputElement).checked)"
            />
          </label>

          <label class="setting-row check-row" :class="{ 'muted-row': !syncConfig.enabled }">
            <div>
              <div class="label">Sync preferences &amp; saved groups</div>
              <div class="desc">
                Themes and custom palettes, layout sizes, Quick Search options, URL auto-sorting
                rules, and custom CSS.
              </div>
            </div>
            <input
              type="checkbox"
              class="vb-switch"
              :disabled="!syncConfig.enabled"
              :checked="syncConfig.syncSettings"
              @change="
                updateSyncToggle('syncSettings', ($event.target as HTMLInputElement).checked)
              "
            />
          </label>

          <label class="setting-row check-row" :class="{ 'muted-row': !syncConfig.enabled }">
            <div>
              <div class="label">Sync tab snapshots</div>
              <div class="desc">
                Compresses and merges snapshots across devices without overwriting snapshots saved
                on other machines.
              </div>
            </div>
            <input
              type="checkbox"
              class="vb-switch"
              :disabled="!syncConfig.enabled"
              :checked="syncConfig.syncSnapshots"
              @change="
                updateSyncToggle('syncSnapshots', ($event.target as HTMLInputElement).checked)
              "
            />
          </label>
        </div>

        <p class="tip-line">
          <template v-if="vivaldiDetected">
            Sign in to your <strong>Vivaldi Account</strong> in
            <code>Vivaldi Settings → Sync</code> and ensure <strong>Extensions</strong> is checked
            so Vivaldi end-to-end encrypts and syncs VBerry data across your devices.
          </template>
          <template v-else>
            Sign in to your <strong>Google Account</strong> in
            <code>Chrome Settings → Sync and Google services</code> and ensure
            <strong>Extensions</strong> (or <strong>Sync everything</strong>) is turned on.
          </template>
        </p>
      </section>

      <!-- Backup, Import & Custom CSS -->
      <section id="sec-backup" class="section-block">
        <div class="section-head">
          <div>
            <h2>Backup, Sidebery import &amp; CSS</h2>
            <p class="hint">
              Export your complete VBerry setup, migrate groups and snapshots from Sidebery, or add
              custom sidebar styles.
            </p>
          </div>
        </div>

        <div class="surface-panel padded-panel">
          <div class="row-actions">
            <label class="file-btn">
              Import backup JSON…
              <input type="file" accept=".json,application/json" hidden @change="onFileSelected" />
            </label>
            <button type="button" class="btn-secondary" @click="exportData">
              Export VBerry backup
            </button>
          </div>

          <div v-if="importError" class="alert error">{{ importError }}</div>

          <div v-if="importPreview" class="preview-box">
            <div class="preview-head">
              Detected <strong>{{ FORMAT_LABELS[importPreview.format] }}</strong>
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
              <button type="button" class="btn-primary" @click="runImport">Import selected</button>
              <button type="button" class="btn-secondary" @click="importPreview = null">
                Cancel
              </button>
            </div>
          </div>

          <div v-if="importResult" class="alert success">
            Imported {{ importResult.panelsImported }} group(s) and
            {{ importResult.snapshotsImported }} snapshot(s)
            <span v-if="importResult.settingsImported"> · Preferences updated</span>
            <span v-if="importResult.customCssImported"> · Custom CSS applied</span>
          </div>

          <div class="css-section">
            <label class="css-label" for="custom-css-input">Custom sidebar CSS</label>
            <textarea
              id="custom-css-input"
              class="css-box"
              rows="5"
              placeholder="/* Optional CSS rules injected into the VBerry sidebar & popup */"
              :value="settings.customCss"
              @change="updateSetting('customCss', ($event.target as HTMLTextAreaElement).value)"
            />
          </div>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.studio {
  max-width: 1020px;
  margin: 0 auto;
  padding: 32px 24px 80px;
  display: grid;
  grid-template-columns: 215px minmax(0, 1fr);
  gap: 36px;
  align-items: start;
}

.rail {
  position: sticky;
  top: 28px;
}

.rail-inner {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 6px;
}

.logo {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  flex-shrink: 0;
}

.brand-name {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 17px;
  letter-spacing: -0.02em;
  line-height: 1.15;
}

.brand-sub {
  font-size: 12px;
  color: var(--text-muted);
}

.rail-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  position: relative;
  border: none;
  background: transparent;
  color: var(--text-muted);
  text-align: left;
  padding: 7px 11px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.1s ease, color 0.1s ease;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.nav-item.active {
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--border);
  padding: 6px 10px;
}

.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
}

.rail-foot {
  padding-top: 14px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.env-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--text-muted);
  padding: 0 4px;
}

.env-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success);
  flex-shrink: 0;
}

.guide-link {
  align-self: flex-start;
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 12.5px;
  font-weight: 500;
  padding: 2px 4px;
  cursor: pointer;
}

.guide-link:hover {
  text-decoration: underline;
}

.status-pill {
  align-self: flex-start;
  padding: 3px 10px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11.5px;
  font-weight: 600;
}

.content {
  display: flex;
  flex-direction: column;
  gap: 34px;
}

.section-block {
  scroll-margin-top: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.section-head > div {
  flex: 1;
  min-width: 240px;
}

.section-head h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 650;
  letter-spacing: -0.015em;
}

.hint {
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.5;
  max-width: 62ch;
}

.surface-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 11px;
  padding: 2px 18px;
  box-shadow: var(--shadow-sm);
}

.padded-panel {
  padding: 18px;
}

/* Live Interactive Preview inside Appearance */
.live-preview {
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  background: var(--bg);
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  font-size: var(--pv-font);
}

.pv-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border);
}

.pv-pills {
  display: flex;
  gap: 5px;
}

.pv-pill {
  --pill-color: var(--accent);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid color-mix(in srgb, var(--pill-color) 62%, var(--border));
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
}

.pv-pill.active {
  background: color-mix(in srgb, var(--pill-color) 15%, var(--surface));
  border-color: var(--pill-color);
  box-shadow: inset 0 0 0 0.5px var(--pill-color), var(--shadow-sm);
  color: var(--text);
}

.pv-pill.active .pv-cnt {
  color: var(--text);
  opacity: 0.82;
}

.pv-cnt {
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}

.pv-utils {
  display: flex;
  gap: 6px;
  color: var(--text-muted);
}

.pv-util svg {
  width: var(--pv-ui-icon);
  height: var(--pv-ui-icon);
}

.pv-tree {
  padding: 7px 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pv-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  height: var(--pv-row-h);
  padding: 0 8px;
  border-radius: 7px;
  user-select: none;
}

.pv-row.active {
  background: var(--bg-active);
  cursor: pointer;
}

.pv-row.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 5px;
  bottom: 5px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
}

.pv-row.child {
  padding-left: 24px;
  color: var(--text-muted);
}

.pv-guide {
  position: absolute;
  left: 15px;
  top: -2px;
  bottom: -2px;
  width: 1px;
  background: var(--border-strong);
}

.pv-fold {
  width: max(22px, var(--pv-icon));
  height: max(22px, var(--pv-icon));
  border-radius: 5px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.pv-fold svg {
  width: var(--pv-ctrl-icon);
  height: var(--pv-ctrl-icon);
  transition: transform 0.12s ease;
}

.pv-fold svg.folded {
  transform: rotate(-90deg);
}

.pv-fav svg {
  width: var(--pv-icon);
  height: var(--pv-icon);
}

.pv-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pv-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 99px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--accent);
}

.pv-close {
  display: inline-flex;
  color: var(--text-muted);
}

.pv-close svg {
  width: var(--pv-ctrl-icon);
  height: var(--pv-ctrl-icon);
}

/* Rows & Controls */
.theme-block {
  padding: 15px 0 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.theme-block-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.theme-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.theme-editor {
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--bg);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.theme-editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.theme-editor-title {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.editor-heading {
  font-weight: 600;
  font-size: 13px;
}

.theme-name-input {
  min-width: 190px;
  max-width: 240px;
  font-weight: 600;
}

.theme-editor-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.color-token-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(156px, 1fr));
  gap: 8px;
}

.token-cell {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
}

.token-well {
  position: relative;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  cursor: pointer;
}

.token-well input[type='color'] {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  border: none;
  padding: 0;
}

.token-swatch {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 6px;
  border: 1px solid rgba(128, 128, 128, 0.38);
}

.token-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.token-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.token-hex-input {
  width: 100%;
  padding: 1px 4px;
  margin-left: -4px;
  border: 1px solid transparent;
  border-radius: 4px;
  background-color: transparent;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text);
  outline: none;
}

.token-hex-input:focus {
  border-color: var(--accent);
  background-color: var(--bg);
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.theme-card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 8px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.12s ease, background-color 0.12s ease, box-shadow 0.12s ease;
}

.theme-card:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.theme-card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1.5px var(--accent);
  background: var(--surface);
}

.theme-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.tc-preview {
  height: 48px;
  border-radius: 6px;
  border: 1px solid;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.tc-split {
  flex-direction: row;
  border-color: var(--border);
}

.tc-half {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 5px;
}

.tc-half + .tc-half {
  border-left: 1px solid var(--border);
}

.tc-bar {
  height: 7px;
  border-radius: 2px;
  width: 70%;
}

.tc-row {
  height: 11px;
  border-radius: 3px;
  border-left: 3px solid;
}

.tc-top {
  height: 13px;
  padding: 0 5px;
  border-bottom: 1px solid;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.tc-pill {
  width: 24px;
  height: 6px;
  border-radius: 2px;
}

.tc-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.tc-body {
  flex: 1;
  padding: 5px 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  justify-content: center;
}

.tc-active-line {
  height: 10px;
  border-radius: 3px;
  border-left: 2.5px solid;
  display: flex;
  align-items: center;
  padding: 0 5px;
}

.tc-muted-line {
  height: 6px;
  display: flex;
  align-items: center;
  padding-left: 10px;
}

.tc-ink {
  height: 3px;
  width: 68%;
  border-radius: 2px;
  opacity: 0.78;
}

.tc-ink.muted {
  width: 52%;
  opacity: 0.55;
}

.tc-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 0 2px;
}

.tc-name {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tc-tag {
  font-size: 10.5px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.vivaldi-theme-note {
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.vivaldi-theme-note code {
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text);
}

.vivaldi-note-sub {
  opacity: 0.85;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 13px 0;
  border-top: 1px solid var(--border);
}

.setting-row:first-child {
  border-top: none;
}

.check-row {
  cursor: pointer;
}

.label {
  font-weight: 500;
  font-size: 13.5px;
}

.desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
  max-width: 56ch;
}

.warn-inline {
  display: block;
  margin-top: 3px;
  color: var(--danger);
}

.kbd {
  padding: 3px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--bg-subtle);
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: nowrap;
}

.kbd.unset {
  color: var(--text-muted);
  border-style: dashed;
  background: transparent;
}

.tip-line {
  margin: 0;
  padding: 10px 14px;
  border-radius: 9px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--text-muted);
  line-height: 1.5;
}

.tip-line code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  color: var(--text);
}

.nested-box {
  margin: 4px 0 8px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  background: var(--bg);
  border-radius: 9px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.nested-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.nested-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
}

.chip-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  user-select: none;
  transition: border-color 0.1s ease, background-color 0.1s ease, color 0.1s ease;
}

.chip-toggle input {
  margin: 0;
  accent-color: var(--accent);
}

.chip-toggle.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
}

.seg-group {
  display: inline-flex;
  padding: 2px;
  border-radius: 8px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.seg-btn {
  border: none;
  background: transparent;
  color: var(--text-muted);
  padding: 5px 11px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.seg-btn.active {
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow-sm);
}

select,
.text-input,
.rule-input,
.num-input {
  padding: 6px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background-color: var(--bg);
  font-size: 12.5px;
  outline: none;
}

select:focus,
.text-input:focus,
.rule-input:focus,
.num-input:focus,
.css-box:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
  background-color: var(--surface);
}

.num-input {
  width: 84px;
  font-variant-numeric: tabular-nums;
}

.range-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.range-wrap input[type='range'] {
  width: 130px;
  accent-color: var(--accent);
  cursor: pointer;
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
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.text-input {
  flex: 1;
  min-width: 200px;
}

.swatch-strip {
  display: flex;
  align-items: center;
  gap: 6px;
}

.mini-swatch {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  padding: 0;
}

.mini-swatch.selected {
  outline: 2px solid var(--text);
  outline-offset: 2px;
}

.empty-inline {
  padding: 12px 0 4px;
  color: var(--text-muted);
  font-size: 12.5px;
}

.panel-card {
  --panel-color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--panel-color) 65%, var(--border));
  border-radius: 9px;
  padding: 12px 14px;
  background: var(--bg);
  margin-top: 10px;
}

.panel-card-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 10px;
}

.panel-card-head strong {
  flex: 1;
  font-size: 13.5px;
}

.btn-danger-ghost {
  border: none;
  background: transparent;
  color: var(--danger);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  padding: 4px 8px;
  border-radius: 6px;
}

.btn-danger-ghost:hover {
  background: var(--danger-soft);
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
  padding: 2px 9px;
  border-radius: 99px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 12px;
}

.rule-chip code {
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.rule-chip button {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-muted);
  padding: 0 2px;
}

.rule-chip button:hover {
  color: var(--danger);
}

.add-rule-form {
  display: flex;
  gap: 8px;
}

.rule-input {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 12px;
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
  justify-content: center;
  padding: 7px 14px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 500;
  border: 1px solid var(--border-strong);
  white-space: nowrap;
  transition: background-color 0.1s ease, border-color 0.1s ease;
}

.file-btn,
.btn-primary {
  background: var(--accent);
  color: var(--accent-text);
  border-color: transparent;
}

.file-btn:hover,
.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-primary:disabled {
  opacity: 0.55;
  cursor: default;
}

.sync-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 15px 0 14px;
  flex-wrap: wrap;
}

.sync-status-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 220px;
  flex: 1;
}

.sync-headline {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sync-state-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success);
  flex-shrink: 0;
}

.sync-state-dot.paused {
  background: var(--text-muted);
}

.sync-state-dot.err {
  background: var(--danger);
}

.sync-headline-text {
  font-weight: 600;
  font-size: 13.5px;
}

.sync-subline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.sync-meter-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  min-width: 140px;
}

.sync-meter-nums {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.sync-meter-nums strong {
  color: var(--text);
  font-weight: 600;
}

.sync-meter-track {
  width: 140px;
  height: 5px;
  border-radius: 99px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  overflow: hidden;
}

.sync-meter-fill {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: var(--accent);
  transition: width 0.2s ease;
}

.sync-meter-fill.high {
  background: var(--danger);
}

.muted-row {
  opacity: 0.55;
}

.btn-secondary {
  background: var(--surface);
  color: var(--text);
}

.btn-secondary:hover {
  background: var(--bg-hover);
}

.alert {
  margin-top: 12px;
  padding: 9px 12px;
  border-radius: 8px;
  font-size: 12.5px;
}

.alert.error {
  background: var(--danger-soft);
  color: var(--danger);
}

.alert.success {
  background: var(--success-soft);
  color: var(--success);
}

.preview-box {
  margin-top: 12px;
  padding: 13px 15px;
  border-radius: 9px;
  border: 1px solid var(--border-strong);
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
  font-size: 12.5px;
}

.check input {
  accent-color: var(--accent);
}

.preview-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.css-section {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.css-label {
  font-weight: 500;
  font-size: 13px;
}

.css-box {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg);
  font-family: var(--font-mono);
  font-size: 12px;
  resize: vertical;
  outline: none;
}

@media (max-width: 760px) {
  .studio {
    grid-template-columns: 1fr;
    gap: 20px;
    padding: 20px 16px 60px;
  }

  .rail {
    position: static;
  }

  .rail-nav {
    flex-direction: row;
    overflow-x: auto;
    padding-bottom: 4px;
  }

  .nav-item {
    white-space: nowrap;
  }

  .nav-item.active::before {
    display: none;
  }

  .theme-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
