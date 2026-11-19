<script setup lang="ts">
import { CHROME_GROUP_COLORS, type ChromeGroupColor } from '@/shared/types'

export interface GroupModalState {
  mode: 'create' | 'edit-native' | 'edit-saved'
  groupId?: number
  savedId?: string
  title: string
  color: ChromeGroupColor
}

const props = defineProps<{
  modal: GroupModalState | null
}>()

const emit = defineEmits<{
  close: []
  submit: []
  'update:title': [value: string]
  'update:color': [value: ChromeGroupColor]
}>()
</script>

<template>
  <div v-if="props.modal" class="modal-backdrop" @click.self="emit('close')">
    <form class="modal" @submit.prevent="emit('submit')">
      <div class="modal-title">
        {{ props.modal.mode === 'create' ? 'New Tab Group' : 'Edit Tab Group' }}
      </div>
      <input
        :value="props.modal.title"
        class="modal-input"
        placeholder="Group name"
        @input="emit('update:title', ($event.target as HTMLInputElement).value)"
      />
      <div class="color-picker">
        <button
          v-for="c in CHROME_GROUP_COLORS"
          :key="c"
          type="button"
          class="color-swatch"
          :class="{ selected: props.modal.color === c }"
          :style="{ background: `var(--grp-${c})` }"
          :title="c"
          @click="emit('update:color', c)"
        />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" @click="emit('close')">Cancel</button>
        <button type="submit" class="btn-primary">
          {{ props.modal.mode === 'create' ? 'Create' : 'Save' }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.38);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
}

.modal {
  width: min(290px, calc(100vw - 24px));
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.modal-title {
  font-weight: 600;
  font-size: 13.5px;
}

.modal-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-subtle);
  outline: none;
}

.modal-input:focus {
  border-color: var(--accent);
  background: var(--bg);
}

.color-picker {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.color-swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
}

.color-swatch.selected {
  outline: 2px solid var(--text);
  outline-offset: 2px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.btn-ghost,
.btn-primary {
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  cursor: pointer;
  font-size: 12px;
}

.btn-ghost {
  background: transparent;
}

.btn-primary {
  background: var(--accent);
  color: var(--accent-text);
  border-color: transparent;
}
</style>
