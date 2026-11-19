<script setup lang="ts">
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
  | { kind: 'bookmark'; node: chrome.bookmarks.BookmarkTreeNode }
  | { kind: 'history'; item: chrome.history.HistoryItem }
  | { kind: 'session'; session: chrome.sessions.Session }
  | SnapshotContextTarget

export type ItemMenuState = ItemMenuPayload & { x: number; y: number }

defineProps<{
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
</script>

<template>
  <!-- Tab Context Menu -->
  <div
    v-if="tabMenu"
    class="ctx-menu"
    :style="{ left: `${tabMenu.x}px`, top: `${tabMenu.y}px` }"
    @click.stop
  >
    <button @click="emit('tabAction', 'new-child')">New Child Tab</button>
    <button @click="emit('tabAction', 'duplicate')">Duplicate</button>
    <button @click="emit('tabAction', 'pin')">{{ tabMenu.tab.pinned ? 'Unpin' : 'Pin' }}</button>
    <button @click="emit('tabAction', 'mute')">
      {{ tabMenu.tab.mutedInfo?.muted ? 'Unmute' : 'Mute' }}
    </button>
    <button @click="emit('tabAction', 'discard')">Unload Tab</button>
    <hr />
    <button @click="emit('tabAction', 'indent')">Indent (Make Child)</button>
    <button @click="emit('tabAction', 'outdent')">Outdent</button>
    <hr />
    <div class="ctx-label">Move to Group</div>
    <button @click="emit('tabAction', 'move-group', UNGROUPED_ID)">Ungrouped</button>
    <button
      v-for="g in groups"
      :key="`ng_${g.id}`"
      @click="emit('tabAction', 'move-group', g.id)"
    >
      <span class="ctx-dot" :style="{ background: `var(--grp-${g.color})` }" />
      {{ g.title || 'Group' }}
    </button>
    <button
      v-for="sp in unmaterializedSavedPanels"
      :key="`sp_${sp.id}`"
      @click="emit('tabAction', 'move-group', sp)"
    >
      <span class="ctx-dot" :style="{ background: `var(--grp-${sp.color})` }" />
      {{ sp.title }}
    </button>
    <hr />
    <button class="danger" @click="emit('tabAction', 'close-branch')">Close Branch</button>
    <button class="danger" @click="emit('tabAction', 'close')">Close Tab</button>
  </div>

  <!-- Panel / Group Context Menu -->
  <div
    v-if="groupMenu"
    class="ctx-menu"
    :style="{ left: `${groupMenu.x}px`, top: `${groupMenu.y}px` }"
    @click.stop
  >
    <button @click="emit('groupAction', 'new-tab')">New Tab</button>
    <button @click="emit('groupAction', 'new-group')">New Tab Group…</button>
    <template v-if="groupMenu.kind !== 'ungrouped'">
      <hr />
      <button @click="emit('groupAction', 'edit')">Rename / Change Color…</button>
      <button v-if="groupMenu.kind === 'native'" @click="emit('groupAction', 'toggle-collapse')">
        {{ groupMenu.group.collapsed ? 'Expand in Tab Strip' : 'Collapse in Tab Strip' }}
      </button>
    </template>
    <hr />
    <button @click="emit('groupAction', 'expand-all')">Expand All Branches</button>
    <button @click="emit('groupAction', 'collapse-all')">Collapse All Branches</button>
    <button @click="emit('groupAction', 'sort-title')">Sort Tabs by Title</button>
    <button @click="emit('groupAction', 'sort-url')">Sort Tabs by URL</button>
    <button @click="emit('groupAction', 'dedupe')">Close Duplicate Tabs</button>
    <hr />
    <button @click="emit('groupAction', 'discard')">Unload Inactive Tabs</button>
    <button @click="emit('groupAction', 'mute-all')">Toggle Mute All Tabs</button>
    <button @click="emit('groupAction', 'bookmark')">Bookmark All Tabs</button>
    <button @click="emit('groupAction', 'snapshot')">Take Snapshot</button>
    <hr />
    <button v-if="groupMenu.kind !== 'ungrouped'" @click="emit('groupAction', 'ungroup')">
      Ungroup All Tabs
    </button>
    <button class="danger" @click="emit('groupAction', 'close-all')">Close All Tabs</button>
    <button
      v-if="groupMenu.kind === 'saved'"
      class="danger"
      @click="emit('groupAction', 'delete-panel')"
    >
      Delete Panel
    </button>
  </div>

  <!-- Bookmarks / History / Snapshots Context Menu -->
  <div
    v-if="itemMenu"
    class="ctx-menu"
    :style="{ left: `${itemMenu.x}px`, top: `${itemMenu.y}px` }"
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
      <button v-if="itemMenu.kind === 'session'" @click="emit('itemAction', 'restore-session')">
        Restore Tab
      </button>
      <button @click="emit('itemAction', 'open')">Open</button>
      <button @click="emit('itemAction', 'open-bg')">Open in Background</button>
      <hr />
      <div class="ctx-label">Open in Tab Group</div>
      <button @click="emit('itemAction', 'open-in-group', UNGROUPED_ID)">Ungrouped</button>
      <button
        v-for="g in groups"
        :key="`ig_${g.id}`"
        @click="emit('itemAction', 'open-in-group', g.id)"
      >
        <span class="ctx-dot" :style="{ background: `var(--grp-${g.color})` }" />
        {{ g.title || 'Group' }}
      </button>
      <button
        v-for="sp in unmaterializedSavedPanels"
        :key="`isp_${sp.id}`"
        @click="emit('itemAction', 'open-in-group', sp)"
      >
        <span class="ctx-dot" :style="{ background: `var(--grp-${sp.color})` }" />
        {{ sp.title }}
      </button>
      <hr />
      <button @click="emit('itemAction', 'copy-url')">Copy URL</button>
      <button
        v-if="itemMenu.kind === 'bookmark'"
        class="danger"
        @click="emit('itemAction', 'delete-bookmark')"
      >
        Delete Bookmark
      </button>
      <button
        v-if="itemMenu.kind === 'history'"
        class="danger"
        @click="emit('itemAction', 'delete-history')"
      >
        Delete from History
      </button>
    </template>

    <template v-else-if="itemMenu.kind === 'bookmark' && !itemMenu.node.url">
      <button @click="emit('itemAction', 'open-folder-tabs')">Open All in New Tabs</button>
      <button @click="emit('itemAction', 'open-folder-group')">Open All as Tab Group</button>
      <template v-if="itemMenu.node.parentId && itemMenu.node.parentId !== '0'">
        <hr />
        <button class="danger" @click="emit('itemAction', 'delete-bookmark')">Delete Folder</button>
      </template>
    </template>

    <template v-else-if="itemMenu.kind === 'snapshot'">
      <button @click="emit('itemAction', 'snap-restore-new')">Restore in New Window</button>
      <button @click="emit('itemAction', 'snap-restore-here')">Restore in Current Window</button>
      <button @click="emit('itemAction', 'snap-export-md')">Export Markdown</button>
      <hr />
      <button class="danger" @click="emit('itemAction', 'snap-delete')">Delete Snapshot</button>
    </template>

    <template v-else-if="itemMenu.kind === 'session'">
      <button @click="emit('itemAction', 'restore-session')">Restore Window</button>
    </template>

    <template v-else-if="itemMenu.kind === 'snapshot-window'">
      <button @click="emit('itemAction', 'snap-restore-window-new')">
        Restore Window in New Window
      </button>
      <button @click="emit('itemAction', 'snap-restore-window-here')">Restore Window Here</button>
    </template>

    <template v-else-if="itemMenu.kind === 'snapshot-group'">
      <button @click="emit('itemAction', 'snap-restore-group')">Restore Group Here</button>
    </template>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  min-width: 175px;
  max-height: 80vh;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px;
  box-shadow: var(--shadow);
  z-index: 50;
  display: flex;
  flex-direction: column;
}

.ctx-menu button {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font-size: 12.5px;
}

.ctx-menu button:hover {
  background: var(--bg-hover);
}

.ctx-menu button.danger {
  color: var(--danger);
}

.ctx-menu hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 4px 0;
}

.ctx-label {
  padding: 3px 8px;
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted);
}

.ctx-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
