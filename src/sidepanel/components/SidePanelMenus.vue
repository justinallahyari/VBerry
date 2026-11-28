<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { SavedPanel } from '@/shared/types'
import { UNGROUPED_ID } from '@/shared/groups'
import type { SnapshotContextTarget } from './SnapshotsView.vue'

export type TabMenuState = { tab: chrome.tabs.Tab; x: number; y: number }

export type GroupMenuPayload =
  | { kind: 'ungrouped' }
  | { kind: 'native'; group: chrome.tabGroups.TabGroup }
  | { kind: 'saved'; panel: SavedPanel }

export type GroupMenuState = GroupMenuPayload & { x: number; y: number }

export type ItemMenuPayload =
  | { kind: 'bookmark'; node: chrome.bookmarks.BookmarkTreeNode; fromSearch?: boolean }
  | { kind: 'bookmark-panel' }
  | { kind: 'history'; item: chrome.history.HistoryItem }
  | { kind: 'session'; session: chrome.sessions.Session }
  | SnapshotContextTarget

export type ItemMenuState = ItemMenuPayload & { x: number; y: number }

const props = defineProps<{
  tabMenu: TabMenuState | null
  groupMenu: GroupMenuState | null
  itemMenu: ItemMenuState | null
  groups: chrome.tabGroups.TabGroup[]
  unmaterializedSavedPanels: SavedPanel[]
}>()

const emit = defineEmits<{
  tabAction: [action: string, target?: number | SavedPanel]
  groupAction: [action: string]
  itemAction: [action: string, target?: number | SavedPanel]
}>()

const tabMenuRef = ref<HTMLElement | null>(null)
const groupMenuRef = ref<HTMLElement | null>(null)
const itemMenuRef = ref<HTMLElement | null>(null)
const pos = ref<{ x: number; y: number }>({ x: 0, y: 0 })

async function positionMenu(anchor: { x: number; y: number } | null, elRef: typeof tabMenuRef) {
  if (!anchor) return
  pos.value = { x: anchor.x, y: anchor.y }
  await nextTick()
  const el = elRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const pad = 6
  const maxX = Math.max(pad, window.innerWidth - rect.width - pad)
  const x = anchor.x + rect.width <= window.innerWidth - pad ? Math.max(pad, anchor.x) : maxX

  let y = anchor.y
  if (anchor.y + rect.height > window.innerHeight - pad) {
    y =
      anchor.y - rect.height >= pad
        ? anchor.y - rect.height
        : Math.max(pad, window.innerHeight - rect.height - pad)
  }
  pos.value = { x: Math.round(x), y: Math.round(y) }
}

watch(
  () => props.tabMenu,
  m => void positionMenu(m, tabMenuRef)
)
watch(
  () => props.groupMenu,
  m => void positionMenu(m, groupMenuRef)
)
watch(
  () => props.itemMenu,
  m => void positionMenu(m, itemMenuRef)
)
</script>

<template>
  <!-- Tab Context Menu -->
  <div
    v-if="tabMenu"
    ref="tabMenuRef"
    class="ctx-menu"
    role="menu"
    :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
    @click.stop
  >
    <button type="button" @click="emit('tabAction', 'new-child')">New child tab</button>
    <button type="button" @click="emit('tabAction', 'duplicate')">Duplicate tab</button>
    <button type="button" @click="emit('tabAction', 'pin')">
      {{ tabMenu.tab.pinned ? 'Unpin tab' : 'Pin tab' }}
    </button>
    <button type="button" @click="emit('tabAction', 'mute')">
      {{ tabMenu.tab.mutedInfo?.muted ? 'Unmute tab' : 'Mute tab' }}
    </button>
    <button type="button" @click="emit('tabAction', 'discard')">Unload tab</button>
    <hr />
    <button type="button" @click="emit('tabAction', 'indent')">Indent under tab above</button>
    <button type="button" @click="emit('tabAction', 'outdent')">Outdent one level</button>
    <hr />
    <div class="ctx-label">Move to group</div>
    <button type="button" @click="emit('tabAction', 'move-group', UNGROUPED_ID)">
      <span class="ctx-group-pill" style="--pill-color: var(--accent)">Tabs (ungrouped)</span>
    </button>
    <button
      v-for="g in groups"
      :key="`ng_${g.id}`"
      type="button"
      @click="emit('tabAction', 'move-group', g.id)"
    >
      <span class="ctx-group-pill" :style="{ '--pill-color': `var(--grp-${g.color})` }">
        {{ g.title || 'Group' }}
      </span>
    </button>
    <button
      v-for="sp in unmaterializedSavedPanels"
      :key="`sp_${sp.id}`"
      type="button"
      @click="emit('tabAction', 'move-group', sp)"
    >
      <span class="ctx-group-pill" :style="{ '--pill-color': `var(--grp-${sp.color})` }">
        {{ sp.title }}
      </span>
    </button>
    <hr />
    <button type="button" class="danger" @click="emit('tabAction', 'close-branch')">
      Close branch
    </button>
    <button type="button" class="danger" @click="emit('tabAction', 'close')">Close tab</button>
  </div>

  <!-- Panel / Group Context Menu -->
  <div
    v-if="groupMenu"
    ref="groupMenuRef"
    class="ctx-menu"
    role="menu"
    :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
    @click.stop
  >
    <button type="button" @click="emit('groupAction', 'new-tab')">New tab</button>
    <button type="button" @click="emit('groupAction', 'new-group')">New tab group…</button>
    <template v-if="groupMenu.kind !== 'ungrouped'">
      <hr />
      <button type="button" @click="emit('groupAction', 'edit')">Edit group…</button>
      <button
        v-if="groupMenu.kind === 'native'"
        type="button"
        @click="emit('groupAction', 'toggle-collapse')"
      >
        {{ groupMenu.group.collapsed ? 'Expand in browser tab bar' : 'Collapse in browser tab bar' }}
      </button>
    </template>
    <hr />
    <button type="button" @click="emit('groupAction', 'expand-all')">Expand all branches</button>
    <button type="button" @click="emit('groupAction', 'collapse-all')">
      Collapse all branches
    </button>
    <button type="button" @click="emit('groupAction', 'sort-title')">Sort tabs by title</button>
    <button type="button" @click="emit('groupAction', 'sort-url')">Sort tabs by URL</button>
    <button type="button" @click="emit('groupAction', 'dedupe')">Close duplicate tabs</button>
    <hr />
    <button type="button" @click="emit('groupAction', 'discard')">Unload inactive tabs</button>
    <button type="button" @click="emit('groupAction', 'mute-all')">Mute or unmute all tabs</button>
    <button type="button" @click="emit('groupAction', 'bookmark')">Bookmark all tabs</button>
    <button type="button" @click="emit('groupAction', 'snapshot')">Save snapshot</button>
    <hr />
    <button
      v-if="groupMenu.kind !== 'ungrouped'"
      type="button"
      @click="emit('groupAction', 'ungroup')"
    >
      Ungroup tabs
    </button>
    <button type="button" class="danger" @click="emit('groupAction', 'close-all')">
      Close all tabs
    </button>
    <button
      v-if="groupMenu.kind === 'saved'"
      type="button"
      class="danger"
      @click="emit('groupAction', 'delete-panel')"
    >
      Delete saved group
    </button>
  </div>

  <!-- Bookmarks / History / Snapshots Context Menu -->
  <div
    v-if="itemMenu"
    ref="itemMenuRef"
    class="ctx-menu"
    role="menu"
    :style="{ left: `${pos.x}px`, top: `${pos.y}px` }"
    @click.stop
  >
    <template
      v-if="
        (itemMenu.kind === 'bookmark' && itemMenu.node.url) ||
        itemMenu.kind === 'history' ||
        (itemMenu.kind === 'session' && itemMenu.session.tab?.url) ||
        itemMenu.kind === 'snapshot-tab'
      "
    >
      <button
        v-if="itemMenu.kind === 'session'"
        type="button"
        @click="emit('itemAction', 'restore-session')"
      >
        Reopen closed tab
      </button>
      <button type="button" @click="emit('itemAction', 'open')">Open</button>
      <button type="button" @click="emit('itemAction', 'open-bg')">Open in background</button>
      <hr />
      <div class="ctx-label">Open in group</div>
      <button type="button" @click="emit('itemAction', 'open-in-group', UNGROUPED_ID)">
        <span class="ctx-group-pill" style="--pill-color: var(--accent)">Tabs (ungrouped)</span>
      </button>
      <button
        v-for="g in groups"
        :key="`ig_${g.id}`"
        type="button"
        @click="emit('itemAction', 'open-in-group', g.id)"
      >
        <span class="ctx-group-pill" :style="{ '--pill-color': `var(--grp-${g.color})` }">
          {{ g.title || 'Group' }}
        </span>
      </button>
      <button
        v-for="sp in unmaterializedSavedPanels"
        :key="`isp_${sp.id}`"
        type="button"
        @click="emit('itemAction', 'open-in-group', sp)"
      >
        <span class="ctx-group-pill" :style="{ '--pill-color': `var(--grp-${sp.color})` }">
          {{ sp.title }}
        </span>
      </button>
      <hr />
      <template v-if="itemMenu.kind === 'bookmark'">
        <button type="button" @click="emit('itemAction', 'edit-bookmark')">Edit bookmark…</button>
        <button type="button" @click="emit('itemAction', 'move-bookmark')">Move to folder…</button>
        <button type="button" @click="emit('itemAction', 'add-bookmark-below')">
          Add bookmark below…
        </button>
        <button
          v-if="itemMenu.fromSearch"
          type="button"
          @click="emit('itemAction', 'reveal-bookmark')"
        >
          Show in folder
        </button>
      </template>
      <button type="button" @click="emit('itemAction', 'copy-url')">Copy link</button>
      <template v-if="itemMenu.kind === 'bookmark'">
        <hr />
        <button type="button" class="danger" @click="emit('itemAction', 'delete-bookmark')">
          Delete bookmark
        </button>
      </template>
      <button
        v-if="itemMenu.kind === 'history'"
        type="button"
        class="danger"
        @click="emit('itemAction', 'delete-history')"
      >
        Remove from history
      </button>
    </template>

    <template v-else-if="itemMenu.kind === 'bookmark' && !itemMenu.node.url">
      <button type="button" @click="emit('itemAction', 'open-folder-tabs')">
        Open all in new tabs
      </button>
      <button type="button" @click="emit('itemAction', 'open-folder-group')">
        Open all as tab group
      </button>
      <hr />
      <button type="button" @click="emit('itemAction', 'add-bookmark-in-folder')">
        Add bookmark here…
      </button>
      <button type="button" @click="emit('itemAction', 'bookmark-active-in-folder')">
        Save current tab here
      </button>
      <button type="button" @click="emit('itemAction', 'add-subfolder')">New subfolder…</button>
      <hr />
      <button type="button" @click="emit('itemAction', 'sort-folder-title')">Sort by title</button>
      <button type="button" @click="emit('itemAction', 'sort-folder-url')">Sort by URL</button>
      <template v-if="itemMenu.node.parentId && itemMenu.node.parentId !== '0'">
        <hr />
        <button type="button" @click="emit('itemAction', 'edit-folder')">
          Edit or move folder…
        </button>
        <button type="button" class="danger" @click="emit('itemAction', 'delete-bookmark')">
          Delete folder
        </button>
      </template>
    </template>

    <template v-else-if="itemMenu.kind === 'bookmark-panel'">
      <button type="button" @click="emit('itemAction', 'add-bookmark-root')">Add bookmark…</button>
      <button type="button" @click="emit('itemAction', 'bookmark-active-root')">
        Save current tab
      </button>
      <button type="button" @click="emit('itemAction', 'add-folder-root')">New folder…</button>
      <hr />
      <button type="button" @click="emit('itemAction', 'expand-all-folders')">
        Expand all folders
      </button>
      <button type="button" @click="emit('itemAction', 'collapse-all-folders')">
        Collapse all folders
      </button>
    </template>

    <template v-else-if="itemMenu.kind === 'snapshot'">
      <button type="button" @click="emit('itemAction', 'snap-restore-new')">
        Restore in new window
      </button>
      <button type="button" @click="emit('itemAction', 'snap-restore-here')">
        Restore in current window
      </button>
      <button type="button" @click="emit('itemAction', 'snap-export-md')">Export Markdown</button>
      <hr />
      <button type="button" class="danger" @click="emit('itemAction', 'snap-delete')">
        Delete snapshot
      </button>
    </template>

    <template v-else-if="itemMenu.kind === 'session'">
      <button type="button" @click="emit('itemAction', 'restore-session')">Reopen window</button>
    </template>

    <template v-else-if="itemMenu.kind === 'snapshot-window'">
      <button type="button" @click="emit('itemAction', 'snap-restore-window-new')">
        Restore in new window
      </button>
      <button type="button" @click="emit('itemAction', 'snap-restore-window-here')">
        Restore in current window
      </button>
    </template>

    <template v-else-if="itemMenu.kind === 'snapshot-group'">
      <button type="button" @click="emit('itemAction', 'snap-restore-group')">
        Restore group here
      </button>
    </template>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  min-width: 190px;
  max-height: 82vh;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  padding: 5px;
  box-shadow: var(--shadow);
  z-index: 50;
  display: flex;
  flex-direction: column;
}

.ctx-menu button {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5.5px 9px;
  border: none;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font-size: 12.5px;
  transition: background-color 0.08s ease;
}

.ctx-menu button:hover,
.ctx-menu button:focus-visible {
  background: var(--bg-hover);
  outline: none;
}

.ctx-menu button.danger {
  color: var(--danger);
}

.ctx-menu button.danger:hover,
.ctx-menu button.danger:focus-visible {
  background: var(--danger-soft);
}

.ctx-menu hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 4px 2px;
}

.ctx-label {
  padding: 4px 9px 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
}

.ctx-group-pill {
  --pill-color: var(--accent);
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--pill-color) 70%, var(--border));
  background: color-mix(in srgb, var(--pill-color) 10%, var(--surface));
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
