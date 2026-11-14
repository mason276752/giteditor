<script setup lang="ts">
import type { PropType } from 'vue'

defineProps({ name: { type: String as PropType<IconName>, required: true } })
</script>

<script lang="ts">
// 24×24 stroke icons.
const PATHS = {
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  file: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5',
  text: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M9 13h6M9 17h4',
  image: 'M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1zM4 16l5-5 4 4 2-2 5 5M15.5 8.5h.01',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3',
  x: 'M6 6l12 12M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  commit: 'M12 3v6M12 15v6M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  branch: 'M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9',
  tag: 'M3 12V4a1 1 0 011-1h8l9 9-9 9zM7.5 7.5h.01',
  key: 'M13 15.5a5.5 5.5 0 11-11 0 5.5 5.5 0 0111 0zM21 2l-9.6 9.6M15.5 7.5l3 3L22 7l-3-3',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM9 12l2 2 4-4',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',
  copy: 'M9 9h10v12H9zM5 15V3h10',
  save: 'M5 3h11l3 3v15H5zM8 3v5h7M8 21v-7h8v7',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  history: 'M3 12a9 9 0 103-6.7L3 8M3 3v5h5M12 7v5l3 2',
  package: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  repo: 'M5 4a1 1 0 011-1h13v15H6a1 1 0 00-1 1zM5 19a2 2 0 002 2h12v-3M9 7h6',
  check: 'M5 12l5 5 9-11',
}
export type IconName = keyof typeof PATHS
</script>

<template>
  <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="PATHS[name]" />
  </svg>
</template>
