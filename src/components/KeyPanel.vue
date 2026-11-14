<script setup lang="ts">
import { markRaw, ref } from 'vue'
import { loadSigner, PassphraseError, type Signer } from '../git/sign'
import Icon from './Icon.vue'

const signer = defineModel<Signer | null>({ required: true })

const keyText = ref('')
const passphrase = ref('')
const error = ref('')
const busy = ref(false)
const fileInput = ref<HTMLInputElement>()
const passInput = ref<HTMLInputElement>()

async function load() {
  if (!keyText.value.trim() || busy.value) return
  error.value = ''
  busy.value = true
  try {
    signer.value = markRaw(await loadSigner(keyText.value, passphrase.value))
    keyText.value = ''
    passphrase.value = ''
  } catch (e) {
    error.value = e instanceof PassphraseError ? (e.wrong ? '密碼不對，請再試一次。' : '這把私鑰有密碼保護，請輸入密碼。') : (e as Error).message
    if (e instanceof PassphraseError) passInput.value?.focus()
  } finally {
    busy.value = false
  }
}

async function onPick() {
  const f = fileInput.value?.files?.[0]
  if (fileInput.value) fileInput.value.value = ''
  if (!f) return
  if (f.size > 64 * 1024) {
    error.value = '這個檔案太大，不像是私鑰。'
    return
  }
  keyText.value = await f.text()
  load()
}
</script>

<template>
  <div class="keypanel">
    <div v-if="signer" class="key-loaded">
      <Icon name="key" />
      <div class="grow">
        <b>{{ signer.label }}</b>
        <code>{{ signer.fingerprint }}</code>
      </div>
      <button type="button" class="btn small" @click="signer = null">換一把</button>
    </div>
    <template v-else>
      <textarea v-model="keyText" rows="4" spellcheck="false" autocomplete="off"
                placeholder="貼上私鑰：-----BEGIN OPENSSH PRIVATE KEY----- 或 -----BEGIN PGP PRIVATE KEY BLOCK-----"></textarea>
      <div class="key-row">
        <button type="button" class="btn small" @click="fileInput?.click()"><Icon name="upload" />選擇私鑰檔</button>
        <input ref="passInput" v-model="passphrase" type="password" class="pass" placeholder="私鑰密碼（沒有就留空）"
               autocomplete="off" @keydown.enter.prevent="load" />
        <button type="button" class="btn small primary" :disabled="!keyText.trim() || busy" @click="load">
          {{ busy ? '讀取中…' : '載入' }}
        </button>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
      <p class="hint">
        支援 SSH（ed25519、RSA、ECDSA）與 GPG 私鑰。私鑰只在這個分頁的記憶體裡使用，不會上傳，也不會存起來。
        SSH 金鑰通常在 <code>~/.ssh/</code>；Mac 的選檔視窗按 <kbd>⌘⇧.</kbd> 可以看到隱藏資料夾。
      </p>
    </template>
    <input ref="fileInput" type="file" hidden @change="onPick" />
  </div>
</template>

<style scoped>
.keypanel { display: grid; gap: 8px; }
textarea { width: 100%; resize: vertical; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.key-row { display: flex; flex-wrap: wrap; gap: 6px; }
.pass { flex: 1; min-width: 10em; }
.key-loaded { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line)); border-radius: 10px; background: var(--accent-soft); }
.key-loaded > .icon { color: var(--accent); }
.key-loaded b { display: block; font-size: 13.5px; overflow-wrap: anywhere; }
.key-loaded code { font-size: 11.5px; color: var(--muted); overflow-wrap: anywhere; }
.error { margin: 0; color: var(--danger); font-size: 13px; }
.hint { margin: 0; color: var(--muted); font-size: 12.5px; }
kbd { padding: 0 4px; border: 1px solid var(--line); border-radius: 4px; font: inherit; font-size: 11.5px; }
</style>
