/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/giteditor/',
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 60_000,
  },
})
