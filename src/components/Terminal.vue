<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import type { Line } from '../git/shell'
import Icon from './Icon.vue'

const props = defineProps<{
  lines: Line[]
  prompt: string
  busy: boolean
  keyLabel: string | null
  complete: (line: string) => Promise<{ start: number; options: string[] }>
}>()
const emit = defineEmits<{ run: [line: string]; close: []; key: []; clear: [] }>()

const input = ref('')
const suggest = ref('')
const field = ref<HTMLInputElement>()
const out = ref<HTMLElement>()
const history: string[] = []
let back = -1 // position while browsing the history with ↑/↓
let draft = ''

function submit() {
  const line = input.value
  if (props.busy) return
  if (line.trim() && history.at(-1) !== line) history.push(line)
  back = -1
  input.value = ''
  emit('run', line)
}

function browse(step: number) {
  if (!history.length) return
  if (back < 0) {
    if (step > 0) return
    draft = input.value
    back = history.length
  }
  back = Math.min(history.length, Math.max(0, back + step))
  input.value = back === history.length ? draft : history[back]
  if (back === history.length) back = -1
  nextTick(() => field.value?.setSelectionRange(input.value.length, input.value.length))
}

async function tab() {
  const line = input.value
  const { start, options } = await props.complete(line)
  if (input.value !== line || !options.length) return
  let common = options[0]
  for (const o of options) while (!o.startsWith(common)) common = common.slice(0, -1)
  const word = line.slice(start)
  if (options.length === 1) input.value = line.slice(0, start) + options[0] + (options[0].endsWith('/') ? '' : ' ')
  else if (common.length > word.length) input.value = line.slice(0, start) + common
  else suggest.value = options.slice(0, 80).join('  ') + (options.length > 80 ? '  …' : '')
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Tab') suggest.value = ''
  if (e.key === 'Enter') {
    e.preventDefault()
    submit()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    browse(-1)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    browse(1)
  } else if (e.key === 'Tab') {
    e.preventDefault()
    tab()
  } else if (e.key === 'l' && e.ctrlKey) {
    e.preventDefault()
    emit('clear')
  } else if (e.key === 'c' && e.ctrlKey && !field.value?.selectionEnd) {
    input.value = ''
  }
}

watch(
  () => props.lines.length,
  () => nextTick(() => out.value && (out.value.scrollTop = out.value.scrollHeight)),
)
watch(
  () => props.busy,
  (b) => !b && nextTick(() => field.value?.focus()),
)
onMounted(() => field.value?.focus())
defineExpose({ focus: () => field.value?.focus() })
</script>

<template>
  <section class="term" aria-label="終端機">
    <header class="term-head">
      <Icon name="terminal" />
      <b>終端機</b>
      <span class="muted small grow clip">只改這個頁面記住的狀態，寫入 .git 才會生效</span>
      <button type="button" class="btn small" :title="keyLabel ? `目前的私鑰：${keyLabel}` : '載入簽名用的私鑰（git commit -S）'" @click="emit('key')">
        <Icon name="key" /><span class="clip key">{{ keyLabel ?? '私鑰' }}</span>
      </button>
      <button type="button" class="btn small" @click="emit('run', 'help')">說明</button>
      <button type="button" class="btn icon small" title="清除畫面（Ctrl+L）" @click="emit('clear')"><Icon name="trash" /></button>
      <button type="button" class="btn icon small" title="收起（Ctrl+`）" @click="emit('close')"><Icon name="x" /></button>
    </header>
    <div ref="out" class="term-out" @click="field?.focus()">
      <p v-if="!lines.length" class="hint">輸入 git 指令，例如 git status、git log --oneline、git commit --amend --date="2024-01-01 09:00"。help 看全部指令。</p>
      <pre v-for="(l, i) in lines" :key="i" :class="l.kind">{{ l.text }}</pre>
    </div>
    <p v-if="suggest" class="suggest">{{ suggest }}</p>
    <label class="term-in">
      <span class="prompt">{{ prompt }}</span>
      <input ref="field" v-model="input" spellcheck="false" autocomplete="off" autocapitalize="off" :disabled="busy"
             aria-label="指令" @keydown="onKey" />
      <span v-if="busy" class="spinner" aria-hidden="true"></span>
    </label>
  </section>
</template>

<style scoped>
.term {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 35;
  display: flex; flex-direction: column; height: min(44vh, 460px);
  border-top: 1px solid var(--line); background: var(--panel); box-shadow: 0 -8px 30px rgb(0 0 0 / .12);
  padding-bottom: env(safe-area-inset-bottom);
}
.term-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px 6px 14px; border-bottom: 1px solid var(--line); }
.term-head .key { max-width: 12em; }
.term-out { flex: 1; min-height: 0; overflow: auto; padding: 8px 14px; background: var(--bg); overscroll-behavior: contain; }
.term-out pre, .term-out .hint {
  margin: 0; font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere;
}
.term-out .cmd { margin-top: 8px; color: var(--accent); font-weight: 600; }
.term-out .cmd:first-child { margin-top: 0; }
.term-out .err { color: var(--danger); }
.term-out .hint { color: var(--muted); }
.suggest { margin: 0; padding: 4px 14px; border-top: 1px dashed var(--line); color: var(--muted); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.term-in { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-top: 1px solid var(--line); }
.prompt { flex: none; color: var(--accent); font: 600 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.term-in input {
  flex: 1; min-width: 0; min-height: 30px; padding: 2px 4px; border: 0; background: none;
  font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.term-in input:focus { outline: none; }
@media (max-width: 600px) {
  .term { height: 52vh; }
  .term-head .muted { display: none; }
}
</style>
