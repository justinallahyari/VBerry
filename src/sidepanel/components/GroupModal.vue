<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
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

const nameInputRef = ref<HTMLInputElement | null>(null)

watch(
  () => props.modal,
  async m => {
    if (!m) return
    await nextTick()
    nameInputRef.value?.focus()
    nameInputRef.value?.select()
  }
)
</script>

<template>
  <div v-if="props.modal" class="modal-backdrop" @click.self="emit('close')">
    <form class="modal" @submit.prevent="emit('submit')" @keydown.esc.stop="emit('close')">
      <div class="modal-title">
        {{ props.modal.mode === 'create' ? 'New tab group' : 'Edit tab group' }}
      </div>
      <label class="field">
        <span class="field-label">Group name</span>
        <input
          ref="nameInputRef"
          :value="props.modal.title"
          class="modal-input"
          placeholder="e.g. Research, Sprint, Reading"
          @input="emit('update:title', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <div class="field">
        <span class="field-label">Color</span>
        <div class="color-picker">
          <button
            v-for="c in CHROME_GROUP_COLORS"
            :key="c"
            type="button"
            class="color-swatch"
            :class="{ selected: props.modal.color === c }"
            :style="{ background: `var(--grp-${c})` }"
            :title="c.charAt(0).toUpperCase() + c.slice(1)"
            :aria-label="c"
            @click="emit('update:color', c)"
          >
            <svg v-if="props.modal.color === c" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="m2.5 6.2 2.3 2.3 4.7-5"
                fill="none"
                stroke="#ffffff"
                stroke-width="1.9"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn-ghost" @click="emit('close')">Cancel</button>
        <button type="submit" class="btn-primary">
          {{ props.modal.mode === 'create' ? 'Create group' : 'Save changes' }}
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
  width: min(300px, calc(100vw - 24px));
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  padding: 15px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.modal-title {
  font-weight: 600;
  font-size: 14px;
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
  background: var(--bg);
  outline: none;
  font-size: 12.5px;
}

.modal-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
  background: var(--surface);
}

.color-picker {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
}

.color-swatch {
  width: 23px;
  height: 23px;
  border-radius: 50%;
  border: none;
  padding: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.color-swatch svg {
  width: 12px;
  height: 12px;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.45));
}

.color-swatch.selected {
  outline: 2px solid var(--text);
  outline-offset: 2px;
}

.color-swatch:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
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
