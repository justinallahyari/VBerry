<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { BookmarkFolderOption } from '@/shared/bookmarks'

export interface BookmarkModalState {
  mode: 'add-bookmark' | 'edit-bookmark' | 'add-folder' | 'edit-folder'
  nodeId?: string
  originalParentId?: string
  title: string
  url: string
  parentId: string
  index?: number
  focusField?: 'title' | 'parent'
}

const props = defineProps<{
  modal: BookmarkModalState | null
  folders: BookmarkFolderOption[]
  activeTab?: { title?: string; url?: string } | null
}>()

const emit = defineEmits<{
  close: []
  submit: []
  'update:title': [value: string]
  'update:url': [value: string]
  'update:parentId': [value: string]
}>()

const titleInputRef = ref<HTMLInputElement | null>(null)
const folderSelectRef = ref<HTMLSelectElement | null>(null)

watch(
  () => props.modal,
  async m => {
    if (!m) return
    await nextTick()
    if (m.focusField === 'parent') {
      folderSelectRef.value?.focus()
    } else {
      titleInputRef.value?.focus()
      titleInputRef.value?.select()
    }
  }
)

function fillActiveTab() {
  if (!props.activeTab?.url) return
  emit('update:title', props.activeTab.title || props.activeTab.url)
  emit('update:url', props.activeTab.url)
}

function modalHeading(mode: BookmarkModalState['mode']): string {
  if (mode === 'add-bookmark') return 'Add bookmark'
  if (mode === 'edit-bookmark') return 'Edit bookmark'
  if (mode === 'add-folder') return 'New folder'
  return 'Edit folder'
}

function submitLabel(mode: BookmarkModalState['mode']): string {
  if (mode === 'add-bookmark') return 'Add bookmark'
  if (mode === 'add-folder') return 'Create folder'
  return 'Save changes'
}

function folderLabel(f: BookmarkFolderOption): string {
  return `${'\u00A0\u00A0'.repeat(f.level)}${f.level > 0 ? '└ ' : ''}${f.title}`
}
</script>

<template>
  <div v-if="props.modal" class="modal-backdrop" @click.self="emit('close')">
    <form class="modal" @submit.prevent="emit('submit')" @keydown.esc.stop="emit('close')">
      <div class="modal-head">
        <div class="modal-title">{{ modalHeading(props.modal.mode) }}</div>
        <button
          v-if="props.modal.mode === 'add-bookmark' && props.activeTab?.url"
          type="button"
          class="fill-btn"
          title="Fill with the current tab's title and URL"
          @click="fillActiveTab"
        >
          Use current tab
        </button>
      </div>

      <label class="field">
        <span class="field-label">Name</span>
        <input
          ref="titleInputRef"
          :value="props.modal.title"
          class="modal-input"
          :placeholder="
            props.modal.mode === 'add-folder' || props.modal.mode === 'edit-folder'
              ? 'Folder name'
              : 'Page title'
          "
          required
          @input="emit('update:title', ($event.target as HTMLInputElement).value)"
        />
      </label>

      <label
        v-if="props.modal.mode === 'add-bookmark' || props.modal.mode === 'edit-bookmark'"
        class="field"
      >
        <span class="field-label">URL</span>
        <input
          :value="props.modal.url"
          class="modal-input"
          placeholder="https://example.com"
          required
          @input="emit('update:url', ($event.target as HTMLInputElement).value)"
        />
      </label>

      <label v-if="props.folders.length" class="field">
        <span class="field-label">Folder</span>
        <select
          ref="folderSelectRef"
          :value="props.modal.parentId"
          class="modal-input"
          @change="emit('update:parentId', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="f in props.folders" :key="f.id" :value="f.id">
            {{ folderLabel(f) }}
          </option>
        </select>
      </label>

      <div class="modal-actions">
        <button type="button" class="btn-ghost" @click="emit('close')">Cancel</button>
        <button type="submit" class="btn-primary">
          {{ submitLabel(props.modal.mode) }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(12, 14, 20, 0.46);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
}

.modal {
  width: min(315px, calc(100vw - 24px));
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  padding: 15px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.modal-title {
  font-weight: 600;
  font-size: 14px;
}

.fill-btn {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-subtle);
  color: var(--accent);
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
}

.fill-btn:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-label {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-muted);
}

.modal-input {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background-color: var(--bg);
  outline: none;
  font-size: 12.5px;
}

.modal-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
  background-color: var(--surface);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 7px;
  margin-top: 2px;
}

.btn-ghost,
.btn-primary {
  padding: 6px 13px;
  border-radius: 7px;
  border: 1px solid var(--border);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}

.btn-ghost {
  background: transparent;
  color: var(--text-muted);
}

.btn-ghost:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.btn-primary {
  background: var(--accent);
  color: var(--accent-text);
  border-color: transparent;
}

.btn-primary:hover {
  background: var(--accent-hover);
}
</style>
