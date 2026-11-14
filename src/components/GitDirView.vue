<script setup lang="ts">
import { onMounted, ref, shallowRef } from 'vue'
import { readBytes, readError } from '../git/fs'
import { inspect, type Inspection } from '../git/inspect'
import type { Repo } from '../git/repo'
import { fmtBytes } from '../util'
import FileView from './FileView.vue'
import Icon from './Icon.vue'
import TreeNode, { type TNode } from './TreeNode.vue'

const props = defineProps<{ repo: Repo }>()

const NOTES: Record<string, string> = {
  HEAD: '目前所在的分支',
  config: '這個 repo 的設定',
  objects: '所有內容：commit、tree、檔案',
  refs: '分支與標籤',
  'packed-refs': '打包起來的分支與標籤',
  logs: 'reflog：分支移動的紀錄',
  index: '暫存區',
  hooks: '鉤子腳本',
  ORIG_HEAD: '上一次大改動前的 HEAD',
  FETCH_HEAD: '上次 fetch 的結果',
}

const roots = shallowRef<TNode[]>([])
const activePath = ref<string | null>(null)
const shown = shallowRef<(Inspection & { path: string; size: number }) | null>(null)
const error = ref('')

const sortNodes = (nodes: TNode[]) => nodes.sort((a, b) => +b.dir - +a.dir || a.name.localeCompare(b.name))

async function load(node: TNode): Promise<TNode[]> {
  const entries = (await props.repo.fs.list(node.id)) ?? []
  return sortNodes(entries.map((e) => ({ name: e.name, dir: e.dir, id: node.id ? `${node.id}/${e.name}` : e.name, note: node.id ? undefined : NOTES[e.name] })))
}

async function openFile(node: TNode) {
  activePath.value = node.id
  error.value = ''
  try {
    const data = await readBytes(props.repo.fs, node.id)
    if (!data) throw new Error('讀不到這個檔案')
    shown.value = { ...inspect(props.repo, node.id, data), path: node.id, size: data.length }
  } catch (e) {
    shown.value = null
    error.value = `無法讀取 ${node.id}：${readError(e)}`
  }
}

onMounted(async () => {
  roots.value = await load({ name: '.git', id: '', dir: true })
})
</script>

<template>
  <div class="work" :class="{ previewing: shown || error }">
    <div class="panel dirtree">
      <p class="muted small intro">.git 資料夾的原始內容。點檔案看裡面是什麼：物件會先解壓縮，pack 索引和暫存區也會解讀。</p>
      <ul>
        <TreeNode v-for="n in roots" :key="n.id" :node="n" :path="n.id" :depth="0" :load="load" :active="activePath"
                  @open="(n2) => openFile(n2)" />
      </ul>
    </div>
    <section v-if="shown || error" class="panel pane">
      <header class="pane-head">
        <Icon name="file" />
        <b class="grow clip">{{ shown?.path ?? activePath }}</b>
        <span v-if="shown" class="muted small">{{ fmtBytes(shown.size) }}</span>
        <button type="button" class="btn icon small" title="關閉" @click="shown = null; error = ''; activePath = null"><Icon name="x" /></button>
      </header>
      <div class="pane-body">
        <p v-if="error" class="error">{{ error }}</p>
        <template v-else-if="shown">
          <p v-if="shown.summary" class="summary">{{ shown.summary }}</p>
          <pre v-if="shown.text !== undefined" class="code">{{ shown.text }}</pre>
          <FileView v-else-if="shown.data" :name="shown.name ?? shown.path" :data="shown.data" />
        </template>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dirtree { padding: 10px 6px; min-height: 420px; }
.dirtree > ul { margin: 0; padding: 0; list-style: none; }
.intro { margin: 2px 8px 10px; }
.summary { margin: 0 0 10px; font-weight: 600; }
.error { color: var(--danger); }
</style>
