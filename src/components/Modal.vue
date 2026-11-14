<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Icon from './Icon.vue'

// Shown while mounted (v-if); Esc, the × and a click outside all emit close.
defineProps<{ title: string; wide?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()

onMounted(() => dialog.value?.showModal())
function onClick(e: MouseEvent) {
  if (e.target === dialog.value) emit('close')
}
</script>

<template>
  <dialog ref="dialog" class="modal" :class="{ wide }" @cancel.prevent="emit('close')" @click="onClick">
    <div class="modal-box">
      <header class="pane-head">
        <b class="grow clip">{{ title }}</b>
        <slot name="actions" />
        <button type="button" class="btn icon small" title="關閉（Esc）" @click="emit('close')"><Icon name="x" /></button>
      </header>
      <div class="modal-body"><slot /></div>
    </div>
  </dialog>
</template>

<style scoped>
.modal {
  width: min(560px, calc(100vw - 24px)); max-height: calc(100vh - 40px); padding: 0;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); color: var(--text); box-shadow: 0 20px 60px rgb(0 0 0 / .25);
}
.modal.wide { width: min(980px, calc(100vw - 24px)); }
.modal::backdrop { background: rgb(0 0 0 / .4); }
.modal-box { display: flex; flex-direction: column; max-height: calc(100vh - 42px); }
.modal-body { padding: 14px 16px 18px; overflow: auto; }
</style>
