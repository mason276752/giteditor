<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import Modal from './Modal.vue'

// A plain text editor for files, commit messages and rebase todo lists.
const props = defineProps<{ title: string; text: string }>()
const emit = defineEmits<{ done: [text: string | null] }>()

const value = ref(props.text)
const area = ref<HTMLTextAreaElement>()

function cancel() {
  if (value.value !== props.text && !confirm('放棄這些修改？')) return
  emit('done', null)
}

function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    emit('done', value.value)
  } else if (e.key === 'Tab' && !e.shiftKey) {
    // A tab in a text file, not a jump to the next button.
    e.preventDefault()
    const el = area.value!
    el.setRangeText('\t', el.selectionStart, el.selectionEnd, 'end')
    value.value = el.value
  }
}

onMounted(() => {
  area.value!.focus()
  area.value!.setSelectionRange(0, 0)
})
</script>

<template>
  <Modal :title="title" wide @close="cancel">
    <template #actions>
      <button type="button" class="btn small primary" @click="emit('done', value)"><Icon name="check" />儲存（⌘S）</button>
    </template>
    <textarea ref="area" v-model="value" class="editor" spellcheck="false" autocomplete="off" @keydown="onKey"></textarea>
  </Modal>
</template>

<style scoped>
.editor {
  display: block; width: 100%; height: min(62vh, 640px); resize: vertical;
  font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size: 4; white-space: pre; overflow: auto;
}
</style>
