<template lang="pug">
.ConfigPopup(ref="rootEl" @wheel="onWheel")
  h2.title {{translate('settings.export_title')}}

  ToggleField(label="settings.backup_all" :value="allSelected" @update:value="onAllChanged")
  ToggleField(label="settings.backup_settings" v-model:value="state.settings")
  ToggleField(label="settings.backup_menu" v-model:value="state.menu")
  ToggleField(label="settings.backup_containers" v-model:value="state.containers")
  ToggleField(label="settings.backup_nav" v-model:value="state.nav")
  ToggleField(v-if="state.hasStyles" label="settings.backup_styles" v-model:value="state.styles")
  ToggleField(label="settings.backup_snapshots" v-model:value="state.snapshots")
  ToggleField(label="settings.backup_favicons" v-model:value="state.favicons")
  ToggleField(label="settings.backup_kb" v-model:value="state.keybindings")

  .ctrls
    a.btn(ref="exportDataLink" @mouseenter="genExportData") {{translate('settings.help_exp_data')}}
</template>

<script lang="ts" setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import type { BackupData, Stored } from 'src/types'
import type { AnySnapTab } from 'src/services/snapshots'
import { translate } from 'src/dict'
import * as Utils from 'src/utils'
import * as Styles from 'src/services/styles'
import * as Logs from 'src/services/logs'
import ToggleField from '../../components/toggle-field.vue'

const rootEl = ref<HTMLElement | null>(null)
const exportDataLink = ref<HTMLAnchorElement | null>(null)
let exportObjectUrl = ''

const state = reactive({
  settings: true,
  menu: true,
  containers: true,
  nav: true,
  hasStyles: false,
  styles: true,
  snapshots: true,
  favicons: true,
  keybindings: true,
})

onMounted(async () => {
  state.hasStyles = await Styles.hasCustomCSS()
})

onUnmounted(() => {
  if (exportObjectUrl) {
    URL.revokeObjectURL(exportObjectUrl)
    exportObjectUrl = ''
  }
})

const allSelected = computed<boolean>(() => {
  const all =
    state.settings &&
    state.menu &&
    state.containers &&
    state.nav &&
    (!state.hasStyles || state.styles) &&
    state.snapshots &&
    state.favicons &&
    state.keybindings
  return all
})

function onAllChanged(): void {
  if (allSelected.value) {
    state.settings = false
    state.menu = false
    state.containers = false
    state.nav = false
    if (state.hasStyles) state.styles = false
    state.snapshots = false
    state.favicons = false
    state.keybindings = false
  } else {
    state.settings = true
    state.menu = true
    state.containers = true
    state.nav = true
    if (state.hasStyles) state.styles = true
    state.snapshots = true
    state.favicons = true
    state.keybindings = true
  }
}

function onWheel(e: WheelEvent): void {
  if (!rootEl.value) return
  let scrollOffset = rootEl.value.scrollTop
  let maxScrollOffset = rootEl.value.scrollHeight - rootEl.value.offsetHeight
  if (scrollOffset === 0 && e.deltaY < 0) e.preventDefault()
  if (scrollOffset === maxScrollOffset && e.deltaY > 0) e.preventDefault()
}

async function genExportData(): Promise<void> {
  const storageKeys: (keyof Stored)[] = []
  if (state.containers) storageKeys.push('containers')
  if (state.settings) storageKeys.push('settings')
  if (state.nav) storageKeys.push('sidebar')
  if (state.menu) storageKeys.push('contextMenu')
  if (state.hasStyles && state.styles) {
    storageKeys.push('sidebarCSS')
    storageKeys.push('groupCSS')
  }
  if (state.snapshots) {
    storageKeys.push('snapshots')
  }
  if (state.favicons) {
    storageKeys.push('favicons_01')
    storageKeys.push('favicons_02')
    storageKeys.push('favicons_03')
    storageKeys.push('favicons_04')
    storageKeys.push('favicons_05')
    storageKeys.push('favHashes')
    storageKeys.push('favDomains')
  }

  let data
  const backup: BackupData = {}
  try {
    data = await browser.storage.local.get<Stored>(storageKeys)
  } catch (err) {
    return Logs.err('genExportData: Cannot get storage data', err)
  }

  if (state.containers && data.containers) backup.containers = Utils.clone(data.containers)
  if (state.settings && data.settings) backup.settings = Utils.clone(data.settings)
  if (state.nav && data.sidebar) backup.sidebar = Utils.clone(data.sidebar)
  if (state.menu && data.contextMenu) backup.contextMenu = Utils.clone(data.contextMenu)
  if (state.hasStyles && state.styles) {
    if (data.sidebarCSS) backup.sidebarCSS = data.sidebarCSS
    if (data.groupCSS) backup.groupCSS = data.groupCSS
  }
  if (state.snapshots && data.snapshots) {
    const exportedSnapshots = Utils.clone(data.snapshots)
    for (const snap of exportedSnapshots) {
      if (!snap?.tabs) continue
      for (const win of snap.tabs) {
        if (!win) continue
        for (const panel of win) {
          if (!panel) continue
          for (const rawTab of panel) {
            if (!rawTab || typeof rawTab !== 'object') continue
            const tab = rawTab as AnySnapTab
            if (tab.originalUrl) {
              tab.url = Utils.restoreOriginalUrlForExport(tab.url, tab.originalUrl)
              delete tab.originalUrl
            } else {
              tab.url = Utils.restoreOriginalUrlForExport(tab.url)
            }
          }
        }
      }
    }
    backup.snapshots = exportedSnapshots
  }
  if (state.favicons && data.favicons_01?.length && data.favDomains && data.favHashes) {
    const fullList = [...data.favicons_01]
    if (data.favicons_02?.length) fullList.push(...data.favicons_02)
    if (data.favicons_03?.length) fullList.push(...data.favicons_03)
    if (data.favicons_04?.length) fullList.push(...data.favicons_04)
    if (data.favicons_05?.length) fullList.push(...data.favicons_05)
    backup.favicons = fullList
    backup.favDomains = Utils.clone(data.favDomains)
    backup.favHashes = [...data.favHashes]
  }

  backup.ver = browser.runtime?.getManifest?.()?.version ?? '5.6.1'

  if (state.keybindings) {
    backup.keybindings = {}
    if (typeof browser?.commands?.getAll === 'function') {
      const cmds = (await browser.commands.getAll().catch(() => [])) ?? []
      for (const cmd of cmds) {
        if (cmd.name && cmd.shortcut) backup.keybindings[cmd.name] = cmd.shortcut
      }
    }
  }

  const backupJSON = JSON.stringify(backup)
  const file = new Blob([backupJSON], { type: 'application/json' })
  const now = Date.now()
  const date = Utils.uDate(now, '.')
  const time = Utils.uTime(now, '.')

  if (exportDataLink.value) {
    if (exportObjectUrl) URL.revokeObjectURL(exportObjectUrl)
    exportObjectUrl = URL.createObjectURL(file)
    exportDataLink.value.href = exportObjectUrl
    exportDataLink.value.download = `sidebery-data-${date}-${time}.json`
    exportDataLink.value.title = `sidebery-data-${date}-${time}.json`
  }
}
</script>
