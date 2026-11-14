<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import { readError } from '../git/fs'
import Icon from './Icon.vue'

// A node of a tree whose folders are read when first opened: a commit's tree objects, or the
// folders of the .git directory. `id` is whatever the loader needs (an object hash, a path).
export interface TNode {
  name: string
  id: string
  dir: boolean
  note?: string
}

const props = defineProps<{
  node: TNode
  path: string
  depth: number
  load: (node: TNode) => Promise<TNode[]>
  active: string | null
}>()
const emit = defineEmits<{ open: [node: TNode, path: string] }>()

const open = ref(false)
const children = shallowRef<TNode[] | null>(null)
const error = ref('')

async function toggle() {
  if (!props.node.dir) {
    emit('open', props.node, props.path)
    return
  }
  open.value = !open.value
  if (open.value && !children.value) {
    try {
      children.value = await props.load(props.node)
    } catch (e) {
      error.value = readError(e)
    }
  }
}
</script>

<template>
  <li>
    <button type="button" class="tnode" :class="{ active: active === path }" :style="{ paddingLeft: `${depth * 16 + 6}px` }"
            :title="path" @click="toggle">
      <Icon v-if="node.dir" name="chevron" class="caret" :class="{ open }" />
      <span v-else class="caret"></span>
      <Icon :name="node.dir ? 'folder' : 'file'" :class="{ folder: node.dir }" />
      <span class="tname">{{ node.name }}</span>
      <span v-if="node.note" class="tnote">{{ node.note }}</span>
    </button>
    <p v-if="error" class="terror" :style="{ paddingLeft: `${depth * 16 + 40}px` }">{{ error }}</p>
    <ul v-if="open && children">
      <TreeNode v-for="c in children" :key="c.name" :node="c" :path="`${path}/${c.name}`" :depth="depth + 1"
                :load="load" :active="active" @open="(n, p) => emit('open', n, p)" />
      <li v-if="!children.length" class="tempty" :style="{ paddingLeft: `${depth * 16 + 40}px` }">（空的）</li>
    </ul>
  </li>
</template>

<style scoped>
ul { margin: 0; padding: 0; list-style: none; }
.tnode {
  display: flex; align-items: center; gap: 5px; width: 100%; min-height: 28px; padding: 2px 8px 2px 6px;
  border: 0; border-radius: 6px; background: none; color: var(--text); font: inherit; font-size: 13.5px; text-align: left; cursor: pointer;
}
.tnode:hover { background: var(--hover); }
.tnode.active { background: var(--accent-soft); }
.caret { width: 14px; height: 14px; flex: none; color: var(--muted); transition: transform .12s; }
.caret.open { transform: rotate(90deg); }
.folder { color: var(--folder); }
.tname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tnote { flex: none; margin-left: auto; padding-left: 10px; color: var(--muted); font-size: 12px; }
.terror, .tempty { margin: 0; color: var(--muted); font-size: 12.5px; line-height: 24px; }
.terror { color: var(--danger); }
</style>
