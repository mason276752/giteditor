<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { decoder } from '../git/bytes'

const props = defineProps<{ name: string; data: Uint8Array }>()

const TEXT_LIMIT = 1 << 20
const HEX_LIMIT = 4096
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i
const MIME: Record<string, string> = { svg: 'image/svg+xml', jpg: 'image/jpeg', ico: 'image/x-icon' }

const kind = computed(() => {
  if (IMAGE.test(props.name)) return 'image'
  return props.data.subarray(0, 8000).includes(0) ? 'binary' : 'text'
})
const text = computed(() => (kind.value === 'text' ? decoder().decode(props.data.subarray(0, TEXT_LIMIT)) : ''))

const hexDump = computed(() => {
  if (kind.value !== 'binary') return ''
  const lines: string[] = []
  const b = props.data.subarray(0, HEX_LIMIT)
  for (let i = 0; i < b.length; i += 16) {
    const row = b.subarray(i, i + 16)
    const hexes = Array.from(row, (x) => x.toString(16).padStart(2, '0')).join(' ')
    const chars = Array.from(row, (x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('')
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hexes.padEnd(47)}  ${chars}`)
  }
  return lines.join('\n')
})

const imageUrl = ref('')
watchEffect((onCleanup) => {
  imageUrl.value = ''
  if (kind.value !== 'image') return
  const ext = props.name.split('.').pop()!.toLowerCase()
  const url = URL.createObjectURL(new Blob([props.data as Uint8Array<ArrayBuffer>], { type: MIME[ext] ?? `image/${ext}` }))
  imageUrl.value = url
  onCleanup(() => URL.revokeObjectURL(url))
})
</script>

<template>
  <div class="fileview">
    <img v-if="kind === 'image'" :src="imageUrl" :alt="name" />
    <template v-else-if="kind === 'text'">
      <pre>{{ text }}</pre>
      <p v-if="data.length > TEXT_LIMIT" class="muted small">只顯示前 1 MB。</p>
    </template>
    <template v-else>
      <p class="muted small">二進位檔案，以下是前 {{ Math.min(data.length, HEX_LIMIT).toLocaleString() }} bytes：</p>
      <pre class="hex">{{ hexDump }}</pre>
    </template>
  </div>
</template>

<style scoped>
.fileview { min-width: 0; }
pre {
  margin: 0; padding: 12px 14px; overflow: auto; max-height: 70vh;
  border: 1px solid var(--line); border-radius: 10px; background: var(--bg);
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; tab-size: 4;
}
.hex { white-space: pre; }
img { display: block; max-width: 100%; max-height: 70vh; margin: 0 auto; border-radius: 8px; background: repeating-conic-gradient(var(--chk) 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
p { margin: 8px 0; }
</style>
