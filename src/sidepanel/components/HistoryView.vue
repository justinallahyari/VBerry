<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { getChromeFaviconUrl } from '@/shared/storage'
import { rankSearchItems } from '@/shared/search'

const props = defineProps<{
  query: string
  activeIndex?: number
}>()

const emit = defineEmits<{
  openUrl: [url: string, background: boolean]
  contextMenu: [item: chrome.history.HistoryItem, e: MouseEvent]
  sessionContextMenu: [session: chrome.sessions.Session, e: MouseEvent]
}>()

const containerRef = ref<HTMLElement | null>(null)
const recentlyClosed = ref<chrome.sessions.Session[]>([])
const historyItems = ref<chrome.history.HistoryItem[]>([])

async function load() {
  const q = props.query.trim()
  const [sessions, hist] = await Promise.all([
    chrome.sessions.getRecentlyClosed({ maxResults: 10 }).catch(() => []),
    chrome.history.search({ text: q, maxResults: 80 }),
  ])
  recentlyClosed.value = sessions
  historyItems.value = q
    ? rankSearchItems(hist, q, h => ({
        title: h.title,
        url: h.url,
        tieBreaker: (h.visitCount ?? 0) * 1000 + (h.lastVisitTime ?? 0) / 1e9,
      }))
    : hist
}

function getResultCount(): number {
  return historyItems.value.length
}

function activateIndex(index: number): boolean {
  const item = historyItems.value[index]
  if (item?.url) {
    emit('openUrl', item.url, false)
    return true
  }
  return false
}

defineExpose({ reload: load, getResultCount, activateIndex })

watch(
  () => props.activeIndex,
  async idx => {
    if (idx === undefined || idx < 0) return
    await nextTick()
    const el = containerRef.value?.querySelector(`[data-row-idx="${idx}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }
)

async function restoreSession(sessionId?: string) {
  if (!sessionId) return
  await chrome.sessions.restore(sessionId)
  await load()
}

function formatTime(ms?: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

watch(() => props.query, load)
onMounted(load)
</script>

<template>
  <div ref="containerRef" class="list-view">
    <template v-if="!query.trim() && recentlyClosed.length">
      <div class="section-label">Recently Closed</div>
      <div
        v-for="(s, idx) in recentlyClosed"
        :key="s.tab?.sessionId || s.window?.sessionId || idx"
        class="row"
        @click="restoreSession(s.tab?.sessionId || s.window?.sessionId)"
        @contextmenu.prevent="emit('sessionContextMenu', s, $event)"
      >
        <img
          v-if="s.tab?.url"
          class="fav"
          :src="getChromeFaviconUrl(s.tab.url, 32)"
          alt=""
        />
        <span v-else class="win-icon">🪟</span>
        <span class="title">
          {{ s.tab ? s.tab.title || s.tab.url : `Window (${s.window?.tabs?.length ?? 0} tabs)` }}
        </span>
      </div>
    </template>

    <div class="section-label">History</div>
    <div v-if="historyItems.length === 0" class="empty">No history entries found.</div>
    <div
      v-for="(item, idx) in historyItems"
      :key="item.id"
      :data-row-idx="idx"
      class="row"
      :class="{ 'search-focus': activeIndex === idx }"
      :title="item.url"
      @click="item.url && emit('openUrl', item.url, false)"
      @auxclick.middle.prevent="item.url && emit('openUrl', item.url, true)"
      @contextmenu.prevent="emit('contextMenu', item, $event)"
    >
      <img class="fav" :src="getChromeFaviconUrl(item.url, 32)" alt="" />
      <span class="title">{{ item.title || item.url }}</span>
      <span class="time">{{ formatTime(item.lastVisitTime) }}</span>
    </div>
  </div>
</template>

<style scoped>
.list-view {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0 16px;
}

.section-label {
  padding: 8px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--tab-h);
  padding: 0 8px;
  margin: 1px 4px;
  border-radius: 6px;
  cursor: pointer;
}

.row:hover {
  background: var(--bg-hover);
}

.row.search-focus {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: var(--bg-selected);
}

.fav {
  width: var(--icon-size);
  height: var(--icon-size);
  border-radius: 3px;
  flex-shrink: 0;
}

.win-icon {
  font-size: 13px;
  flex-shrink: 0;
}

.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.empty {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-muted);
}
</style>
