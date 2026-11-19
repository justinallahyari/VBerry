<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { getChromeFaviconUrl } from '@/shared/storage'

const props = defineProps<{
  query: string
}>()

const emit = defineEmits<{
  openUrl: [url: string, background: boolean]
  contextMenu: [node: chrome.bookmarks.BookmarkTreeNode, e: MouseEvent]
}>()

interface FlatBookmark {
  node: chrome.bookmarks.BookmarkTreeNode
  level: number
  isFolder: boolean
}

const tree = ref<chrome.bookmarks.BookmarkTreeNode[]>([])
const searchResults = ref<chrome.bookmarks.BookmarkTreeNode[]>([])
const expanded = ref<Set<string>>(new Set(['1', '2']))

async function load() {
  tree.value = await chrome.bookmarks.getTree()
}

function flatten(nodes: chrome.bookmarks.BookmarkTreeNode[], level = 0): FlatBookmark[] {
  const out: FlatBookmark[] = []
  for (const n of nodes) {
    // Skip synthetic root node (id === '0')
    if (n.id === '0') {
      if (n.children) out.push(...flatten(n.children, 0))
      continue
    }
    const isFolder = !n.url
    out.push({ node: n, level, isFolder })
    if (isFolder && expanded.value.has(n.id) && n.children) {
      out.push(...flatten(n.children, level + 1))
    }
  }
  return out
}

const flatBookmarks = computed(() => flatten(tree.value))

function toggleFolder(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

async function deleteBookmark(node: chrome.bookmarks.BookmarkTreeNode) {
  if (!node.url) {
    if (!confirm(`Delete folder "${node.title}" and all its bookmarks?`)) return
    await chrome.bookmarks.removeTree(node.id)
  } else {
    await chrome.bookmarks.remove(node.id)
  }
}

watch(
  () => props.query,
  async q => {
    const trimmed = q.trim()
    if (!trimmed) {
      searchResults.value = []
      return
    }
    const hits = await chrome.bookmarks.search(trimmed)
    searchResults.value = hits.filter(h => Boolean(h.url))
  },
  { immediate: true }
)

onMounted(() => {
  void load()
  chrome.bookmarks.onCreated.addListener(load)
  chrome.bookmarks.onRemoved.addListener(load)
  chrome.bookmarks.onChanged.addListener(load)
  chrome.bookmarks.onMoved.addListener(load)
})

onUnmounted(() => {
  chrome.bookmarks.onCreated.removeListener(load)
  chrome.bookmarks.onRemoved.removeListener(load)
  chrome.bookmarks.onChanged.removeListener(load)
  chrome.bookmarks.onMoved.removeListener(load)
})
</script>

<template>
  <div class="list-view">
    <template v-if="query.trim()">
      <div v-if="searchResults.length === 0" class="empty">No matching bookmarks.</div>
      <div
        v-for="item in searchResults"
        :key="item.id"
        class="row"
        :title="item.url"
        @click="item.url && emit('openUrl', item.url, false)"
        @auxclick.middle.prevent="item.url && emit('openUrl', item.url, true)"
        @contextmenu.prevent="emit('contextMenu', item, $event)"
      >
        <img class="fav" :src="getChromeFaviconUrl(item.url, 32)" alt="" />
        <span class="title">{{ item.title || item.url }}</span>
      </div>
    </template>

    <template v-else>
      <div
        v-for="item in flatBookmarks"
        :key="item.node.id"
        class="row"
        :style="{ paddingLeft: `${8 + item.level * 14}px` }"
        :title="item.node.url || item.node.title"
        @click="item.isFolder ? toggleFolder(item.node.id) : item.node.url && emit('openUrl', item.node.url, false)"
        @auxclick.middle.prevent="!item.isFolder && item.node.url && emit('openUrl', item.node.url, true)"
        @contextmenu.prevent="emit('contextMenu', item.node, $event)"
      >
        <span v-if="item.isFolder" class="folder-icon">
          {{ expanded.has(item.node.id) ? '▾ 📁' : '▸ 📁' }}
        </span>
        <img v-else class="fav" :src="getChromeFaviconUrl(item.node.url, 32)" alt="" />
        <span class="title">{{ item.node.title || item.node.url || 'Untitled' }}</span>
        <button
          v-if="item.level > 0"
          class="del-btn"
          title="Delete"
          @click.stop="deleteBookmark(item.node)"
        >
          ×
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.list-view {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0 16px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--tab-h);
  padding-right: 6px;
  margin: 1px 4px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
}

.row:hover {
  background: var(--bg-hover);
}

.folder-icon {
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.fav {
  width: var(--icon-size);
  height: var(--icon-size);
  border-radius: 3px;
  flex-shrink: 0;
}

.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.del-btn {
  opacity: 0;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  font-size: 15px;
}

.row:hover .del-btn {
  opacity: 1;
}

.del-btn:hover {
  background: var(--bg-subtle);
  color: var(--danger);
}

.empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-muted);
}
</style>
