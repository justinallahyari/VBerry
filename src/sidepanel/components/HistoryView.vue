<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { getChromeFaviconUrl } from '@/shared/storage'
import { historyStartTime, rankSearchItems } from '@/shared/search'

const props = defineProps<{
  query: string
  activeIndex?: number
  historyDays: number
}>()

const emit = defineEmits<{
  openUrl: [url: string, background: boolean]
  contextMenu: [item: chrome.history.HistoryItem, e: MouseEvent]
  sessionContextMenu: [session: chrome.sessions.Session, e: MouseEvent]
}>()

const containerRef = ref<HTMLElement | null>(null)
const recentlyClosed = ref<chrome.sessions.Session[]>([])
const historyItems = ref<chrome.history.HistoryItem[]>([])
let loadSeq = 0

async function load() {
  const seq = ++loadSeq
  const q = props.query.trim()
  const startTime = historyStartTime(props.historyDays)
  const [sessions, hist] = await Promise.all([
    chrome.sessions.getRecentlyClosed({ maxResults: 10 }).catch(() => []),
    chrome.history.search({ text: q, maxResults: 80, startTime }),
  ])
  if (seq !== loadSeq) return
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

function shortHost(rawUrl?: string): string {
  if (!rawUrl) return ''
  try {
    const u = new URL(rawUrl)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}

function formatTime(ms?: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

watch(() => [props.query, props.historyDays], load)
onMounted(load)
</script>

<template>
  <div ref="containerRef" class="list-view">
    <template v-if="!query.trim() && recentlyClosed.length">
      <div class="section-label">
        <span>Recently closed</span>
        <span class="section-count">{{ recentlyClosed.length }}</span>
      </div>
      <div
        v-for="(s, idx) in recentlyClosed"
        :key="s.tab?.sessionId || s.window?.sessionId || idx"
        class="row closed-row"
        @click="restoreSession(s.tab?.sessionId || s.window?.sessionId)"
        @contextmenu.prevent="emit('sessionContextMenu', s, $event)"
      >
        <img
          v-if="s.tab?.url"
          class="fav"
          :src="getChromeFaviconUrl(s.tab.url, 32)"
          alt=""
        />
        <svg v-else class="win-icon" viewBox="0 0 16 16" aria-hidden="true">
          <rect
            x="2"
            y="3"
            width="12"
            height="10"
            rx="2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.45"
          />
          <path d="M2 6h12" fill="none" stroke="currentColor" stroke-width="1.35" />
        </svg>
        <span class="title">
          {{ s.tab ? s.tab.title || s.tab.url : `Window (${s.window?.tabs?.length ?? 0} tabs)` }}
        </span>
        <span class="reopen-pill">Reopen</span>
      </div>
    </template>

    <div class="section-label">
      <span>{{ query.trim() ? 'Matching history' : 'Browsing history' }}</span>
      <span v-if="historyItems.length" class="section-count">{{ historyItems.length }}</span>
    </div>
    <div v-if="historyItems.length === 0" class="empty">
      {{ query.trim() ? `No history matches “${query.trim()}”.` : 'No recent history entries.' }}
    </div>
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
      <span v-if="shortHost(item.url)" class="host">{{ shortHost(item.url) }}</span>
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px 4px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-muted);
}

.section-count {
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}

.row {
  display: flex;
  align-items: center;
  gap: 7px;
  height: var(--tab-h);
  padding: 0 9px;
  margin: 1px 6px;
  border-radius: 7px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.1s ease;
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
  width: var(--icon-size);
  height: var(--icon-size);
  color: var(--accent);
  flex-shrink: 0;
}

.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reopen-pill {
  opacity: 0;
  font-size: 10.5px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent);
  flex-shrink: 0;
  transition: opacity 0.1s ease;
}

.closed-row:hover .reopen-pill {
  opacity: 1;
}

.host {
  font-size: 11px;
  color: var(--text-muted);
  max-width: 105px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}

.time {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  flex-shrink: 0;
}

.empty {
  padding: 30px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12.5px;
}
</style>
