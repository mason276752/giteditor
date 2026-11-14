<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { History, RefLabel, Row } from '../git/history'
import { fmtTime } from '../util'
import Icon, { type IconName } from './Icon.vue'

const props = defineProps<{
  history: History
  selected: string | null
  changed: (hash: string) => boolean
  hasRemotes: boolean
}>()
const remotes = defineModel<boolean>('remotes', { required: true })
const emit = defineEmits<{ select: [hash: string] }>()

const ROW = 30
const LANE = 14
const MAX_LANES = 14
const OVERSCAN = 12

const scroller = ref<HTMLElement>()
const scrollTop = ref(0)
const viewport = ref(600)
const query = ref('')
const notFound = ref(false)

const lanes = computed(() => Math.min(props.history.lanes, MAX_LANES))
const graphWidth = computed(() => lanes.value * LANE + 6)
const first = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW) - OVERSCAN))
const visible = computed(() => {
  const end = Math.min(props.history.rows.length, Math.ceil((scrollTop.value + viewport.value) / ROW) + OVERSCAN)
  return props.history.rows.slice(first.value, end).map((row, i) => ({ row, i: first.value + i }))
})

const x = (lane: number) => lane * LANE + LANE / 2 + 3
const y = (half: number) => (half * ROW) / 2
function paths(row: Row) {
  const out: { d: string; c: number }[] = []
  for (let i = 0; i < row.lines.length; i += 5) {
    const [x1, y1, x2, y2, c] = row.lines.slice(i, i + 5)
    if (x1 >= MAX_LANES && x2 >= MAX_LANES) continue
    const my = (y(y1) + y(y2)) / 2
    out.push({
      d: x1 === x2 ? `M${x(x1)} ${y(y1)}V${y(y2)}` : `M${x(x1)} ${y(y1)}C${x(x1)} ${my} ${x(x2)} ${my} ${x(x2)} ${y(y2)}`,
      c,
    })
  }
  return out
}

const LABEL_ICON: Record<RefLabel['kind'], IconName> = { head: 'commit', branch: 'branch', remote: 'branch', tag: 'tag' }
const subject = (hash: string) => props.history.commits.get(hash)!.message.split('\n', 1)[0]

function onScroll() {
  scrollTop.value = scroller.value!.scrollTop
}

// Keep the selected commit in view when it's chosen from elsewhere (search, a parent link, undo).
function reveal(hash: string | null) {
  const i = hash ? props.history.index.get(hash) : undefined
  const el = scroller.value
  if (i === undefined || !el) return
  const top = i * ROW
  if (top < el.scrollTop || top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 3)
}
watch(() => [props.selected, props.history] as const, ([h]) => nextTick(() => reveal(h)))

function search(backwards = false) {
  const q = query.value.trim().toLowerCase()
  if (!q) return
  const rows = props.history.rows
  const start = props.selected ? props.history.index.get(props.selected) ?? -1 : -1
  for (let k = 1; k <= rows.length; k++) {
    const i = (start + (backwards ? -k : k) + rows.length * 2) % rows.length
    const c = props.history.commits.get(rows[i].hash)!
    if (c.hash.startsWith(q) || c.message.toLowerCase().includes(q) || `${c.author.name} ${c.author.email}`.toLowerCase().includes(q)) {
      notFound.value = false
      emit('select', c.hash)
      return
    }
  }
  notFound.value = true
}

// ↑／↓ move through the list.
function step(delta: number) {
  const rows = props.history.rows
  if (!rows.length) return
  const i = props.selected ? props.history.index.get(props.selected) ?? -1 : -1
  emit('select', rows[Math.min(rows.length - 1, Math.max(0, i + delta))].hash)
}
defineExpose({ step })

let ro: ResizeObserver | undefined
onMounted(() => {
  ro = new ResizeObserver(() => {
    viewport.value = scroller.value?.clientHeight ?? 600
  })
  ro.observe(scroller.value!)
  reveal(props.selected)
})
onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <div class="graph">
    <div class="graph-bar">
      <label class="search">
        <Icon name="search" />
        <input v-model="query" type="search" placeholder="搜尋訊息、作者或 hash，按 Enter" spellcheck="false"
               @input="notFound = false" @keydown.enter.prevent="search(($event as KeyboardEvent).shiftKey)" />
      </label>
      <span v-if="notFound" class="muted small">沒有符合的 commit</span>
      <label v-if="hasRemotes" class="check small" title="遠端分支指向的是遠端那邊的歷史；改寫之後，舊的 commit 會因為它們繼續顯示">
        <input v-model="remotes" type="checkbox" />遠端分支
      </label>
      <span class="muted small count">{{ history.rows.length.toLocaleString() }} 個 commit</span>
    </div>
    <div ref="scroller" class="graph-scroll" @scroll="onScroll">
      <div class="graph-body" :style="{ height: `${history.rows.length * ROW}px` }">
        <button v-for="{ row, i } in visible" :key="row.hash" type="button" class="crow"
                :class="{ active: row.hash === selected, changed: changed(row.hash) }"
                :style="{ transform: `translateY(${i * ROW}px)` }" @click="emit('select', row.hash)">
          <svg class="lanes" :width="graphWidth" :height="ROW" aria-hidden="true">
            <path v-for="(p, k) in paths(row)" :key="k" :d="p.d" :class="`g${p.c}`" />
            <circle v-if="row.col < MAX_LANES" :cx="x(row.col)" :cy="ROW / 2" :class="`g${row.color}`" class="dot"
                    :r="history.commits.get(row.hash)!.parents.length > 1 ? 3.4 : 4.2" />
          </svg>
          <span class="subject">
            <span v-for="l in history.labels.get(row.hash) ?? []" :key="l.name" class="ref" :class="[`ref-${l.kind}`, { current: l.current }]"
                  :title="l.name">
              <Icon :name="LABEL_ICON[l.kind]" />{{ l.short }}
            </span>
            <span class="msg">{{ subject(row.hash) }}</span>
          </span>
          <span v-if="changed(row.hash)" class="mark" title="改寫過（還沒寫入）">M</span>
          <Icon v-if="history.commits.get(row.hash)!.sig" name="shield" class="signed" />
          <span class="who">{{ history.commits.get(row.hash)!.author.name }}</span>
          <span class="when">{{ fmtTime(history.commits.get(row.hash)!.author.time, history.commits.get(row.hash)!.author.tz) }}</span>
          <code class="sha">{{ row.hash.slice(0, 7) }}</code>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.graph { display: flex; flex-direction: column; max-height: max(420px, calc(100vh - 150px)); overflow: hidden; }
.graph-bar { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.search { display: flex; align-items: center; gap: 6px; flex: 1; max-width: 26em; padding: 0 10px; border: 1px solid var(--line); border-radius: 9px; color: var(--muted); }
.search:focus-within { border-color: var(--accent); }
.search input { flex: 1; min-width: 0; height: 32px; border: 0; background: none; color: var(--text); font: inherit; font-size: 14px; outline: none; }
.count { margin-left: auto; white-space: nowrap; }
.graph-scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.graph-body { position: relative; min-width: 100%; }
.crow {
  position: absolute; left: 0; right: 0; top: 0; height: 30px;
  display: flex; align-items: center; gap: 8px; padding: 0 10px 0 4px;
  border: 0; background: none; color: var(--text); font: inherit; font-size: 13.5px; text-align: left; cursor: pointer;
}
.crow:hover { background: var(--hover); }
.crow.active { background: var(--accent-soft); }
.crow:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.lanes { flex: none; overflow: hidden; }
.lanes path { fill: none; stroke-width: 2; stroke: currentColor; }
.lanes .dot { stroke: var(--panel); stroke-width: 2; fill: currentColor; }
.crow.changed .dot { stroke: var(--warn); stroke-width: 2.4; }
.subject { flex: 1; min-width: 0; display: flex; align-items: center; gap: 5px; overflow: hidden; }
.msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ref {
  flex: none; display: inline-flex; align-items: center; gap: 3px; max-width: 14em; padding: 0 7px 0 5px;
  border: 1px solid var(--line); border-radius: 999px; font-size: 12px; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ref .icon { width: 12px; height: 12px; }
.ref-branch { border-color: color-mix(in srgb, var(--accent) 50%, var(--line)); color: var(--accent); }
.ref-branch.current { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 600; }
.ref-remote { color: var(--muted); }
.ref-tag { border-color: color-mix(in srgb, var(--folder) 55%, var(--line)); color: var(--folder); }
.ref-head { background: var(--text); border-color: var(--text); color: var(--bg); font-weight: 600; }
.mark { flex: none; color: var(--warn); font-size: 12px; font-weight: 700; }
.signed { flex: none; width: 14px; height: 14px; color: var(--accent); }
.who { flex: none; width: 9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.when { flex: none; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.sha { flex: none; color: var(--muted); font-size: 12px; }
@media (max-width: 760px) {
  .who, .when { display: none; }
}
</style>
