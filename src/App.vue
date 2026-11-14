<script setup lang="ts">
import { computed, markRaw, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { entryFs, filesFs, findGitDir, handleFs, readError, type GitFs } from './git/fs'
import { loadHistory, shortRef, type History, type RefState } from './git/history'
import { MissingObjectError, Repo } from './git/repo'
import { rewrite, type RewriteRequest } from './git/rewrite'
import type { Signer } from './git/sign'
import { makeBundle, refUpdates, writeToRepo, type RefUpdate } from './git/write'
import { copyText, fmtBytes, isTyping, saveBlob } from './util'
import CommitGraph from './components/CommitGraph.vue'
import CommitPane from './components/CommitPane.vue'
import FileView from './components/FileView.vue'
import GitDirView from './components/GitDirView.vue'
import Icon from './components/Icon.vue'
import Modal from './components/Modal.vue'

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
  }
  interface DataTransferItem {
    getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>
  }
}

// Big, never-reactive objects: Vue only tracks which one is current.
const repo = shallowRef<Repo | null>(null)
const history = shallowRef<History | null>(null)
const base = shallowRef<RefState | null>(null) // refs as on disk
const state = shallowRef<RefState | null>(null) // refs with the edits made here
const past = shallowRef<RefState[]>([])
const future = shallowRef<RefState[]>([])
const origin = shallowRef(new Map<string, string>()) // rewritten commit → the original on disk
const signer = shallowRef<Signer | null>(null)

const repoName = ref('')
const view = ref<'graph' | 'files'>('graph')
const selected = ref<string | null>(null)
const showRemotes = ref(true)
const loading = ref('')
const busy = ref('')
const dragging = ref(false)
const written = ref<RefUpdate[] | null>(null)
const bundleInfo = ref<{ name: string; size: number; commands: string[] } | null>(null)
const preview = shallowRef<{ path: string; data: Uint8Array } | null>(null)

const dirInput = ref<HTMLInputElement>()
const graph = ref<InstanceType<typeof CommitGraph>>()

const isOpen = computed(() => !!repo.value)
const updates = computed(() => (base.value && state.value ? refUpdates(base.value, state.value) : []))
const rewrittenCount = computed(() => {
  const h = history.value
  return h ? [...h.commits.keys()].filter((k) => origin.value.has(k)).length : 0
})
const isChanged = (hash: string) => origin.value.has(hash)
const hasRemotes = computed(() => !!state.value && [...state.value.refs.keys()].some((n) => n.startsWith('refs/remotes/')))
const branchCount = computed(() => (state.value ? [...state.value.refs.keys()].filter((n) => n.startsWith('refs/heads/')).length : 0))
const pushHints = computed(() => {
  const r = repo.value
  if (!r || !written.value) return []
  return written.value
    .filter((u) => u.name !== 'HEAD')
    .flatMap((u) => {
      const name = shortRef(u.name)
      if (u.name.startsWith('refs/tags/')) {
        const remote = [...r.config.keys()].find((k) => /^remote\..+\.url$/.test(k))
        return remote ? [`git push --force ${remote.slice(7, -4)} tag ${name}`] : []
      }
      const remote = r.config.get(`branch.${name}.remote`)
      return remote ? [`git push --force-with-lease ${remote} ${name}`] : []
    })
})
const canWrite = computed(() => !!repo.value?.writable)
const bundleName = computed(() => `${repoName.value || 'repo'}-giteditor.bundle`)

// ---------- toast ----------
const toastMsg = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined
function toast(msg: string, ms = 3600) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMsg.value = ''
  }, ms)
}

// ---------- open ----------
function confirmDiscard() {
  return !updates.value.length || confirm('改寫過的 commit 還沒寫入，要放棄嗎？')
}

async function openSource(fs: GitFs, folder: string) {
  loading.value = '讀取中…'
  try {
    const { fs: gitFs, inside } = await findGitDir(fs)
    const r = markRaw(await Repo.open(gitFs))
    const st: RefState = { refs: new Map(r.refs), head: { ...r.head } }
    const h = await loadHistory(r, st, {
      remotes: showRemotes.value,
      onProgress: (n) => {
        loading.value = `讀取 commit… ${n.toLocaleString()}`
      },
    })
    repo.value = r
    base.value = st
    state.value = st
    history.value = markRaw(h)
    past.value = []
    future.value = []
    origin.value = new Map()
    written.value = null
    view.value = 'graph'
    selected.value = null
    repoName.value = displayName(folder, inside, r)
    if (h.missing) toast(`這是淺層複製（shallow clone），有 ${h.missing} 個比較舊的 commit 不在 repo 裡。`, 6000)
  } catch (e) {
    console.warn('open failed', e)
    toast(readError(e), 6000)
  } finally {
    loading.value = ''
  }
}

function displayName(folder: string, inside: boolean, r: Repo) {
  if (inside || folder !== '.git') return folder
  const url = r.config.get('remote.origin.url')
  return url ? url.replace(/\/+$/, '').split(/[/:]/).pop()!.replace(/\.git$/, '') : folder
}

async function pickFolder() {
  if (!confirmDiscard()) return
  if (!window.showDirectoryPicker) {
    dirInput.value?.click()
    return
  }
  try {
    const h = await window.showDirectoryPicker({ id: 'giteditor', mode: 'read' })
    await openSource(handleFs(h), h.name)
  } catch (e) {
    if ((e as DOMException).name !== 'AbortError') toast(`無法開啟這個資料夾：${readError(e)}`, 6000)
  }
}

function onPickDir() {
  const list = dirInput.value?.files
  if (!list?.length) return
  const files = new Map<string, File>()
  const folder = list[0].webkitRelativePath.split('/')[0]
  for (const f of list) files.set(f.webkitRelativePath.slice(folder.length + 1), f)
  dirInput.value!.value = ''
  openSource(filesFs(files), folder)
}

function closeRepo() {
  if (!confirmDiscard()) return
  repo.value = null
  history.value = null
  base.value = null
  state.value = null
  selected.value = null
  preview.value = null
  written.value = null
}

// ---------- edits ----------
// Moves the selection to the same commit in a rebuilt history (its hash may have changed).
function follow(hash: string | null, h: History) {
  if (!hash || h.commits.has(hash)) return hash
  const orig = origin.value.get(hash) ?? hash
  return [...h.commits.keys()].find((k) => (origin.value.get(k) ?? k) === orig) ?? null
}

async function setState(next: RefState, select: string | null = selected.value) {
  const h = markRaw(await loadHistory(repo.value!, next, { remotes: showRemotes.value }))
  state.value = next
  history.value = h
  selected.value = follow(select, h)
}

watch(showRemotes, () => state.value && setState(state.value))

async function apply(req: RewriteRequest) {
  if (busy.value) return
  busy.value = '改寫中…'
  try {
    const { state: next, map } = await rewrite(repo.value!, history.value!, state.value!, req, (done, total) => {
      busy.value = `改寫中 ${done}/${total}`
    })
    const o = new Map(origin.value)
    for (const [from, to] of map) o.set(to, origin.value.get(from) ?? from)
    origin.value = o
    past.value = [...past.value, state.value!]
    future.value = []
    written.value = null
    await setState(next, map.get(req.target) ?? req.target)
    toast(`已改寫 ${[...map.values()].filter((h) => history.value!.commits.has(h)).length} 個 commit，還沒寫入`)
  } catch (e) {
    console.warn('rewrite failed', e)
    toast(`改寫失敗：${readError(e)}`, 6000)
  } finally {
    busy.value = ''
  }
}

async function undo() {
  if (!past.value.length || busy.value) return
  future.value = [state.value!, ...future.value]
  const prev = past.value.at(-1)!
  past.value = past.value.slice(0, -1)
  await setState(prev)
}

async function redo() {
  if (!future.value.length || busy.value) return
  past.value = [...past.value, state.value!]
  const [next, ...rest] = future.value
  future.value = rest
  await setState(next)
}

async function discardAll() {
  if (!confirm('放棄所有改寫，回到 repo 原本的樣子？')) return
  past.value = []
  future.value = []
  await setState(base.value!)
}

// ---------- write back ----------
const note = () => `rewrite ${rewrittenCount.value} commit${rewrittenCount.value === 1 ? '' : 's'}`

function fallbackIdentity() {
  const h = base.value!.head.hash
  const c = h ? repo.value!.cachedCommit(h) : undefined
  return c ? { name: c.committer.name, email: c.committer.email } : { name: 'giteditor', email: 'giteditor@localhost' }
}

async function writeBack() {
  const r = repo.value!
  if (busy.value || !updates.value.length) return
  // Must be the first thing awaited, while the click still counts as a user gesture.
  if (!(await r.fs.requestWrite?.())) {
    toast('沒有取得寫入權限，什麼都沒寫入。')
    return
  }
  busy.value = '寫入中…'
  try {
    const done = await writeToRepo(r, base.value!, state.value!, fallbackIdentity(), note())
    base.value = state.value
    past.value = []
    future.value = []
    origin.value = new Map()
    written.value = done
    toast(`已寫入：移動了 ${done.length} 個分支／標籤`)
  } catch (e) {
    console.warn('write failed', e)
    toast(`寫入失敗：${readError(e)}`, 8000)
  } finally {
    busy.value = ''
  }
}

async function downloadBundle() {
  if (busy.value || !updates.value.length) return
  busy.value = '打包中…'
  try {
    const { data, commands } = await makeBundle(repo.value!, base.value!, state.value!, bundleName.value, note())
    saveBlob(new Blob([data as Uint8Array<ArrayBuffer>]), bundleName.value)
    bundleInfo.value = { name: bundleName.value, size: data.length, commands }
  } catch (e) {
    toast(`打包失敗：${readError(e)}`, 6000)
  } finally {
    busy.value = ''
  }
}

async function copyCommands(lines: string[]) {
  toast((await copyText(lines.join('\n'))) ? '已複製指令' : '無法複製，請手動選取')
}

// ---------- file preview ----------
async function openFile(path: string, hash: string) {
  try {
    const o = await repo.value!.read(hash)
    preview.value = { path, data: o.data }
  } catch (e) {
    toast(e instanceof MissingObjectError ? '這個檔案不在 repo 裡（submodule 或部分複製）' : readError(e))
  }
}

function downloadPreview() {
  const p = preview.value!
  saveBlob(new Blob([p.data as Uint8Array<ArrayBuffer>]), p.path.split('/').pop()!)
}

// ---------- page-level input ----------
function onKeydown(e: KeyboardEvent) {
  if (!isOpen.value || isTyping(e.target) || preview.value || bundleInfo.value) return
  const mod = e.metaKey || e.ctrlKey
  const key = e.key.toLowerCase()
  if (mod && key === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
  } else if (mod && key === 'y') {
    e.preventDefault()
    redo()
  } else if (view.value === 'graph' && (key === 'arrowdown' || key === 'arrowup') && !mod) {
    e.preventDefault()
    graph.value?.step(key === 'arrowdown' ? 1 : -1)
  } else if (key === 'escape' && selected.value) {
    selected.value = null
  }
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (updates.value.length) {
    e.preventDefault()
    e.returnValue = ''
  }
}

let dragDepth = 0
const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
function onDragEnter(e: DragEvent) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth++
  dragging.value = true
}
function onDragOver(e: DragEvent) {
  if (!hasFiles(e)) return
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
}
function onDragLeave(e: DragEvent) {
  if (hasFiles(e) && --dragDepth <= 0) {
    dragDepth = 0
    dragging.value = false
  }
}
async function onDrop(e: DragEvent) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  dragging.value = false
  const item = [...e.dataTransfer!.items].find((i) => i.kind === 'file')
  if (!item) return
  // Both have to be taken now, while the drop event is being dispatched.
  const handle = item.getAsFileSystemHandle?.().catch(() => null)
  const entry = item.webkitGetAsEntry()
  if (!confirmDiscard()) return
  const h = await handle
  if (h?.kind === 'directory') return openSource(handleFs(h as FileSystemDirectoryHandle), h.name)
  if (entry?.isDirectory) return openSource(entryFs(entry as FileSystemDirectoryEntry), entry.name)
  toast('請拖入資料夾：repo 的資料夾，或裡面的 .git 資料夾。')
}

onMounted(() => {
  if (dirInput.value) dirInput.value.webkitdirectory = true
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('dragenter', onDragEnter)
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('dragenter', onDragEnter)
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
})
</script>

<template>
  <div class="app" :class="{ dragging }" data-drop-label="放開以開啟這個 repo">
    <header class="top">
      <div class="brand">
        <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#0f8a6c"/><path d="M11 8v16M11 13c0 4 10 2 10 7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="11" cy="8.5" r="2.6" fill="#fff"/><circle cx="11" cy="23.5" r="2.6" fill="#fff"/><circle cx="21" cy="21" r="2.6" fill="#bfe8dc"/></svg>
        <div>
          <h1>Git 編輯器</h1>
          <p v-if="!isOpen">在瀏覽器裡看 .git 的歷史，修改 commit 的訊息、作者、時間，還能用私鑰簽名。</p>
        </div>
      </div>
      <div v-if="isOpen && history" class="repo-info">
        <Icon name="repo" />
        <b>{{ repoName }}</b>
        <span class="stats">
          {{ history.commits.size.toLocaleString() }} 個 commit · {{ branchCount }} 個分支<template v-if="repo!.algo === 'sha256'"> · SHA-256</template>
        </span>
        <span v-if="rewrittenCount" class="badge">改寫了 {{ rewrittenCount }} 個 commit，還沒寫入</span>
      </div>
    </header>

    <template v-if="!isOpen">
      <section class="start panel">
        <template v-if="loading">
          <span class="spinner big" aria-hidden="true"></span>
          <strong>{{ loading }}</strong>
        </template>
        <template v-else>
          <Icon name="branch" class="hero" />
          <strong>把 repo 資料夾或 .git 資料夾拖進來</strong>
          <span>所有讀取與計算都在瀏覽器裡完成，檔案不會上傳</span>
          <div class="start-btns">
            <button type="button" class="btn primary" @click="pickFolder"><Icon name="folder" />開啟 repo 資料夾</button>
          </div>
          <span class="small">可以選 repo 本身，也可以直接選裡面的 .git（bare repo 也行）</span>
        </template>
      </section>

      <section class="about panel">
        <h2>可以做什麼</h2>
        <ul>
          <li><strong>看歷史</strong>：所有分支、標籤、遠端分支畫成樹狀的 commit 圖，可以搜尋訊息、作者、hash。</li>
          <li><strong>看內容</strong>：每個 commit 的檔案樹、檔案內容與原始物件；也能直接瀏覽 .git 資料夾，loose 物件、pack 索引、暫存區都會解讀。</li>
          <li><strong>改 commit</strong>：訊息、作者、提交者，以及作者時間和提交者時間（含時區）。後面的 commit 會跟著改寫，分支與標籤一起移過去；遠端分支不動。</li>
          <li><strong>簽名（可選）</strong>：用 SSH（ed25519、RSA、ECDSA）或 GPG 私鑰簽名，有密碼的私鑰也可以。git <code>verify-commit</code> 驗得過。</li>
          <li><strong>寫回去</strong>：Chrome、Edge 可以直接寫回 .git，並留下 reflog（隨時能用 <code>git reflog</code> 退回）。其他瀏覽器下載一個 bundle，用兩行 git 指令套用。</li>
          <li><strong>可以復原</strong>：寫入前的每一步都能復原（⌘Z）。寫入前會檢查分支有沒有在別處被改過，有就不寫。</li>
        </ul>
        <p class="caution">
          <Icon name="alert" />
          改 commit 就是改寫歷史：commit 的 hash 都會變。已經推上遠端的分支，要用 <code>git push --force-with-lease</code> 才能更新，和別人共用的分支請先講好。
        </p>
      </section>
    </template>

    <template v-else-if="history && state">
      <div class="toolbar panel">
        <div class="tabs" role="tablist">
          <button type="button" role="tab" class="tab" :class="{ on: view === 'graph' }" :aria-selected="view === 'graph'"
                  @click="view = 'graph'"><Icon name="branch" /><span>提交歷史</span></button>
          <button type="button" role="tab" class="tab" :class="{ on: view === 'files' }" :aria-selected="view === 'files'"
                  @click="view = 'files'"><Icon name="folder" /><span>.git 檔案</span></button>
        </div>
        <div class="group">
          <button type="button" class="btn icon" :disabled="!past.length || !!busy" title="復原（⌘Z）" @click="undo"><Icon name="undo" /></button>
          <button type="button" class="btn icon" :disabled="!future.length || !!busy" title="重做（⌘⇧Z）" @click="redo"><Icon name="redo" /></button>
        </div>
        <div class="group end">
          <button type="button" class="btn" :class="{ primary: !canWrite }" :disabled="!updates.length || !!busy"
                  title="下載只含新 commit 的 git bundle，再用 git 指令套用" @click="downloadBundle">
            <Icon name="package" /><span>下載 bundle</span>
          </button>
          <button v-if="canWrite" type="button" class="btn primary" :disabled="!updates.length || !!busy"
                  title="把改寫後的 commit 寫進 .git，並移動分支" @click="writeBack">
            <Icon name="save" /><span class="clip">{{ busy || '寫入 .git' }}</span>
          </button>
          <button type="button" class="btn icon" title="關閉這個 repo" @click="closeRepo"><Icon name="x" /></button>
        </div>
      </div>

      <div v-if="updates.length" class="banner">
        <Icon name="history" />
        <span class="grow">
          改寫了 {{ rewrittenCount }} 個 commit，會移動
          <b v-for="(u, i) in updates" :key="u.name">{{ i ? '、' : '' }}{{ u.name === 'HEAD' ? 'HEAD' : shortRef(u.name) }}</b>。
          還沒寫入：{{ canWrite ? '按「寫入 .git」，或' : '這個瀏覽器不能直接寫入資料夾，請' }}下載 bundle 用 git 套用。
        </span>
        <button type="button" class="btn small" :disabled="!!busy" @click="discardAll">全部放棄</button>
      </div>
      <div v-if="written && !updates.length" class="banner">
        <Icon name="check" />
        <span class="grow">
          已寫入 .git，可以用 <code>git reflog</code> 退回。遠端的歷史還是舊的{{ pushHints.length ? '，要更新請執行：' : '。' }}
          <code v-for="c in pushHints" :key="c" class="cmd">{{ c }}</code>
        </span>
        <button type="button" class="btn small" @click="written = null">知道了</button>
      </div>
      <div v-if="!canWrite && !updates.length && !written" class="banner subtle">
        <Icon name="alert" />
        <span class="grow">這個瀏覽器只能讀取資料夾。改好之後可以下載 bundle，用 git 指令套用；在 Chrome 或 Edge 開啟則能直接寫回。</span>
      </div>

      <div v-show="view === 'graph'" class="work" :class="{ previewing: selected }">
        <CommitGraph ref="graph" v-model:remotes="showRemotes" class="panel" :history="history" :selected="selected"
                     :changed="isChanged" :has-remotes="hasRemotes" @select="(h) => (selected = h)" />
        <CommitPane v-if="selected && history.commits.has(selected)" v-model:signer="signer" :repo="repo!"
                    :history="history" :state="state" :hash="selected" :origin="origin.get(selected) ?? null"
                    :busy="!!busy" @close="selected = null" @select="(h) => (selected = h)" @apply="apply"
                    @open-file="openFile" @toast="toast" />
      </div>
      <GitDirView v-if="view === 'files'" :repo="repo!" />
    </template>

    <footer>
      Git 編輯器 · 所有運算都在瀏覽器內完成 ·
      <a href="../">更多工具</a> ·
      <a href="https://github.com/mason276752/giteditor">GitHub 原始碼</a>
    </footer>

    <div class="toast" :class="{ show: toastMsg }" role="status" aria-live="polite">
      <span>{{ toastMsg }}</span>
    </div>

    <Modal v-if="preview" :title="preview.path" wide @close="preview = null">
      <template #actions>
        <span class="muted small">{{ fmtBytes(preview.data.length) }}</span>
        <button type="button" class="btn small" @click="downloadPreview"><Icon name="download" />下載</button>
      </template>
      <FileView :name="preview.path" :data="preview.data" />
    </Modal>

    <Modal v-if="bundleInfo" title="套用 bundle" @close="bundleInfo = null">
      <p>已下載 <b>{{ bundleInfo.name }}</b>（{{ fmtBytes(bundleInfo.size) }}），裡面只有新的 commit。</p>
      <p>把它放進 repo 資料夾，在那裡打開終端機執行：</p>
      <pre class="code wrap">{{ bundleInfo.commands.join('\n') }}</pre>
      <div class="start-btns left">
        <button type="button" class="btn primary" @click="copyCommands(bundleInfo.commands)"><Icon name="copy" />複製指令</button>
      </div>
      <p class="small muted">
        第一行把新的 commit 放進 repo（git 會先確認它們和原本的歷史接得上），之後每一行移動一個分支；
        要是分支在這之間被改過，git 會拒絕，不會蓋掉。套用後可以刪掉 bundle 檔。
      </p>
      <p class="small muted">套用之後這裡看到的還是套用前的狀態；要繼續改，請重新開啟 repo。</p>
    </Modal>

    <input ref="dirInput" type="file" hidden @change="onPickDir" />
  </div>
</template>
