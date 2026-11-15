<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { entryFs, filesFs, findGitDir, handleFs, readError, type GitFs } from './git/fs'
import { loadHistory, shortRef, type History, type RefState } from './git/history'
import { MissingObjectError, Repo } from './git/repo'
import { danglingCommits } from './git/revs'
import { rewrite, type RewriteRequest } from './git/rewrite'
import { complete, run, type Line, type ShellEnv } from './git/shell'
import type { Signer } from './git/sign'
import { headCommit, isClean, status, type Snapshot } from './git/work'
import { makeBundle, refUpdates, restoreCommand, staleFiles, writeToRepo, type RefUpdate } from './git/write'
import { copyText, fmtBytes, isTyping, saveBlob } from './util'
import CommitGraph from './components/CommitGraph.vue'
import CommitPane from './components/CommitPane.vue'
import EditorDialog from './components/EditorDialog.vue'
import FileView from './components/FileView.vue'
import GitDirView from './components/GitDirView.vue'
import Icon from './components/Icon.vue'
import KeyPanel from './components/KeyPanel.vue'
import Modal from './components/Modal.vue'
import Terminal from './components/Terminal.vue'

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
const snap = shallowRef<Snapshot | null>(null) // refs and the page's checkout, with the edits made here
const past = shallowRef<Snapshot[]>([])
const future = shallowRef<Snapshot[]>([])
// Commits made here → the original on disk they replace ('' for brand-new ones).
const origin = shallowRef(new Map<string, string>())
const signer = shallowRef<Signer | null>(null)
const pageConfig = new Map<string, string>() // `git config` in the terminal
const noted = new Set<string>() // terminal hints already shown

const repoName = ref('')
const view = ref<'graph' | 'files'>('graph')
const selected = ref<string | null>(null)
const showRemotes = ref(true)
const showDangling = ref(false)
const scanning = ref(false)
const loading = ref('')
const busy = ref('')
const dragging = ref(false)
const written = ref<{ updates: RefUpdate[]; stale: string[] } | null>(null)
const bundleInfo = ref<{ name: string; size: number; commands: string[] } | null>(null)
const preview = shallowRef<{ path: string; data: Uint8Array } | null>(null)
const keyOpen = ref(false)
const termOpen = ref(false)
const termLines = shallowRef<Line[]>([])
const termBusy = ref(false)
const editor = shallowRef<{ title: string; text: string; resolve: (v: string | null) => void } | null>(null)

const dirInput = ref<HTMLInputElement>()
const graph = ref<InstanceType<typeof CommitGraph>>()
const term = ref<InstanceType<typeof Terminal>>()

const state = computed(() => snap.value?.refs ?? null)
const isOpen = computed(() => !!repo.value)
const updates = computed(() => (base.value && state.value ? refUpdates(base.value, state.value) : []))
const changedCount = computed(() => {
  const h = history.value
  return h ? [...h.commits.keys()].filter((k) => origin.value.has(k)).length : 0
})
const markOf = (hash: string): '' | 'M' | '+' => {
  const o = origin.value.get(hash)
  return o === undefined ? '' : o ? 'M' : '+'
}
const hasRemotes = computed(() => !!state.value && [...state.value.refs.keys()].some((n) => n.startsWith('refs/remotes/')))
const branchCount = computed(() => (state.value ? [...state.value.refs.keys()].filter((n) => n.startsWith('refs/heads/')).length : 0))
const pushHints = computed(() => {
  const r = repo.value
  if (!r || !written.value) return []
  const anyRemote = [...r.config.keys()].find((k) => /^remote\..+\.url$/.test(k))?.slice(7, -4)
  return written.value.updates
    .filter((u) => u.name !== 'HEAD')
    .flatMap((u) => {
      const name = shortRef(u.name)
      if (u.name.startsWith('refs/tags/')) {
        if (!anyRemote) return []
        return [u.new ? `git push --force ${anyRemote} tag ${name}` : `git push ${anyRemote} --delete refs/tags/${name}`]
      }
      const remote = r.config.get(`branch.${name}.remote`)
      if (!remote) return []
      return [u.new ? `git push --force-with-lease ${remote} ${name}` : `git push ${remote} --delete ${name}`]
    })
})
const canWrite = computed(() => !!repo.value?.writable)
const bundleName = computed(() => `${repoName.value || 'repo'}-giteditor.bundle`)

// What the page has checked out, for the switcher and the prompt.
const checkoutLabel = computed(() => {
  const s = snap.value
  if (!s) return ''
  const h = s.work.head
  const rb = s.work.rebase
  const where = h.ref ? shortRef(h.ref) : h.hash ? h.hash.slice(0, 7) : '(沒有 commit)'
  return rb ? `${where}|REBASE ${rb.done}/${rb.total}` : where
})
const prompt = computed(() => `(${checkoutLabel.value}) $`)
const checkoutValue = computed(() => {
  const h = snap.value?.work.head
  if (!h) return ''
  if (h.ref) return `branch:${shortRef(h.ref)}`
  return `rev:${h.hash}`
})
const refOptions = (prefix: string) => (state.value ? [...state.value.refs.keys()].filter((n) => n.startsWith(prefix)).map(shortRef).sort() : [])
const danglingTips = shallowRef<string[]>([])
const locked = computed(() => (snap.value?.work.rebase ? '終端機裡的 rebase 還沒做完：先 git rebase --continue 或 --abort，才能在這裡修改。' : ''))

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

// ---------- editor (files, messages, rebase todo) ----------
function editText(title: string, text: string): Promise<string | null> {
  return new Promise((resolve) => {
    editor.value = { title, text, resolve }
  })
}
function closeEditor(text: string | null) {
  editor.value?.resolve(text)
  editor.value = null
}

// ---------- open ----------
function confirmDiscard() {
  return !updates.value.length || confirm('改過的 commit 還沒寫入，要放棄嗎？')
}

async function openSource(fs: GitFs, folder: string) {
  loading.value = '讀取中…'
  try {
    const { fs: gitFs, inside } = await findGitDir(fs)
    const r = markRaw(await Repo.open(gitFs))
    const st: RefState = { refs: new Map(r.refs), head: { ...r.head } }
    const s: Snapshot = { refs: st, work: { head: { ...r.head }, index: null, files: null, rebase: null } }
    const h = await loadHistory(r, st, {
      remotes: showRemotes.value,
      onProgress: (n) => {
        loading.value = `讀取 commit… ${n.toLocaleString()}`
      },
    })
    repo.value = r
    base.value = st
    snap.value = s
    history.value = markRaw(h)
    past.value = []
    future.value = []
    origin.value = new Map()
    written.value = null
    diskCommits = null
    danglingTips.value = []
    showDangling.value = false
    pageConfig.clear()
    noted.clear()
    termLines.value = []
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
  snap.value = null
  selected.value = null
  preview.value = null
  written.value = null
  termOpen.value = false
}

// ---------- dangling commits ----------
let diskCommits: string[] | null = null

// The repo is scanned for commits once; commits made here are added each time.
async function findDangling(s: Snapshot): Promise<string[]> {
  const r = repo.value!
  diskCommits ??= await r.allCommits()
  const made = [...r.mem].filter(([, o]) => o.type === 'commit').map(([h]) => h)
  return danglingCommits(r, s, [...diskCommits, ...made])
}

// ---------- the current state ----------
// Moves the selection to the same commit in a rebuilt history (its hash may have changed).
function follow(hash: string | null, h: History) {
  if (!hash || h.commits.has(hash)) return hash
  const orig = origin.value.get(hash) || hash
  return [...h.commits.keys()].find((k) => (origin.value.get(k) || k) === orig) ?? null
}

async function setSnap(next: Snapshot, select: string | null = selected.value) {
  if (showDangling.value) {
    scanning.value = true
    try {
      danglingTips.value = await findDangling(next)
    } finally {
      scanning.value = false
    }
  } else {
    danglingTips.value = []
  }
  const h = markRaw(
    await loadHistory(repo.value!, next.refs, { remotes: showRemotes.value, checkout: next.work.head, dangling: danglingTips.value }),
  )
  snap.value = next
  history.value = h
  selected.value = follow(select, h)
}

function push(next: Snapshot, rewritten: Iterable<[string, string]>, created: Iterable<string> = []) {
  const o = new Map(origin.value)
  for (const [to, from] of rewritten) o.set(to, origin.value.get(from) || from)
  for (const h of created) o.set(h, '')
  origin.value = o
  past.value = [...past.value, snap.value!]
  future.value = []
  written.value = null
  return setSnap(next)
}

watch([showRemotes, showDangling], async ([, dangling], [, was]) => {
  if (!snap.value) return
  await setSnap(snap.value)
  if (!dangling || was) return
  const n = danglingTips.value.length
  toast(n ? `有 ${n} 個 dangling commit，圖上標成虛線的「dangling」` : '沒有 dangling commit')
})

async function apply(req: RewriteRequest) {
  if (busy.value) return
  busy.value = '改寫中…'
  try {
    const cur = snap.value!
    const { state: refs, map } = await rewrite(repo.value!, history.value!, cur.refs, req, (done, total) => {
      busy.value = `改寫中 ${done}/${total}`
    })
    // The page's checkout follows its branch, or its commit when detached.
    const wh = cur.work.head
    const head = wh.ref ? { ref: wh.ref, hash: refs.refs.get(wh.ref) ?? null } : { ref: null, hash: wh.hash && (map.get(wh.hash) ?? wh.hash) }
    const next: Snapshot = { refs, work: { ...cur.work, head } }
    const [oldHead, newHead] = [headCommit(cur), headCommit(next)]
    if (oldHead && newHead && oldHead !== newHead && (cur.work.index || cur.work.files)) {
      const [a, b] = await Promise.all([repo.value!.commit(oldHead), repo.value!.commit(newHead)])
      if (a.tree !== b.tree && !isClean(await status(repo.value!, cur))) {
        throw new Error('終端機的工作區有還沒 commit 的修改，而這次會改到目前 checkout 的 commit 的檔案。先 commit，或 git reset --hard 丟掉，再改。')
      }
      if (a.tree !== b.tree) next.work = { ...next.work, index: null, files: null }
    }
    await push(next, [...map].map(([from, to]) => [to, from] as [string, string]))
    selected.value = map.get(req.target) ?? req.target
    toast(`已改寫 ${[...map.values()].filter((h) => history.value!.commits.has(h)).length} 個 commit，還沒寫入`)
  } catch (e) {
    console.warn('rewrite failed', e)
    toast(`改寫失敗：${readError(e)}`, 8000)
  } finally {
    busy.value = ''
  }
}

async function undo() {
  if (!past.value.length || busy.value || termBusy.value) return
  future.value = [snap.value!, ...future.value]
  const prev = past.value.at(-1)!
  past.value = past.value.slice(0, -1)
  await setSnap(prev)
}

async function redo() {
  if (!future.value.length || busy.value || termBusy.value) return
  past.value = [...past.value, snap.value!]
  const [next, ...rest] = future.value
  future.value = rest
  await setSnap(next)
}

async function discardAll() {
  if (!confirm('放棄所有修改，回到 repo 原本的樣子？')) return
  past.value = []
  future.value = []
  await setSnap({ refs: base.value!, work: { head: { ...base.value!.head }, index: null, files: null, rebase: null } })
}

// ---------- terminal ----------
async function runCommand(line: string): Promise<Line[]> {
  if (termBusy.value || !snap.value) return []
  termLines.value = [...termLines.value, { kind: 'cmd', text: `${prompt.value} ${line}` }]
  termBusy.value = true
  try {
    const sh: ShellEnv = {
      repo: repo.value!,
      snap: snap.value,
      signer: signer.value,
      config: pageConfig,
      hooks: { editText, dangling: () => findDangling(sh.snap) },
      noted,
    }
    const res = await run(sh, line)
    termLines.value = res.clear ? [] : [...termLines.value, ...res.lines.filter((l) => l.text)]
    if (res.snap !== snap.value) {
      const before = headCommit(snap.value)
      await push(res.snap, res.rewritten, res.created)
      // Follow HEAD when it moves and the old HEAD (or nothing) was selected.
      const after = headCommit(res.snap)
      if (after && after !== before && (!selected.value || selected.value === before || !history.value!.commits.has(selected.value))) {
        selected.value = after
      }
    }
    return res.lines
  } catch (e) {
    console.warn('command failed', e)
    const lines: Line[] = [{ kind: 'err', text: `error: ${readError(e)}` }]
    termLines.value = [...termLines.value, ...lines]
    return lines
  } finally {
    termBusy.value = false
  }
}

const completeLine = (line: string) =>
  complete({ repo: repo.value!, snap: snap.value!, signer: signer.value, config: pageConfig, hooks: { editText, dangling: async () => [] } }, line)

// Commands run from buttons: the terminal shows them if it's open, a toast tells the outcome if not.
async function runFromUi(line: string) {
  const lines = await runCommand(line)
  if (termOpen.value) return
  const err = lines.find((l) => l.kind === 'err')
  const msg = err ?? lines.find((l) => l.kind === 'out')
  if (msg) toast(msg.text.split('\n').filter(Boolean)[0] ?? '', err ? 7000 : 3600)
}

const quote = (s: string) => (/^[\w./@%+=:,^~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

function onCheckoutPick(e: Event) {
  const el = e.target as HTMLSelectElement
  const v = el.value
  el.value = checkoutValue.value
  const kind = v.slice(0, v.indexOf(':'))
  const name = v.slice(v.indexOf(':') + 1)
  runFromUi(kind === 'branch' ? `git switch ${quote(name)}` : `git switch --detach ${quote(name)}`)
}

function checkoutCommit(hash: string) {
  // Prefer the local branch sitting there, if there's exactly one.
  const branches = (history.value?.labels.get(hash) ?? []).filter((l) => l.kind === 'branch')
  runFromUi(branches.length === 1 ? `git switch ${quote(branches[0].short)}` : `git switch --detach ${hash}`)
}

function branchAt(hash: string) {
  const name = window.prompt(`在 ${hash.slice(0, 7)} 建立的新分支名稱：`)?.trim()
  if (name) runFromUi(`git branch ${quote(name)} ${hash}`)
}

async function toggleTerminal() {
  termOpen.value = !termOpen.value
  if (termOpen.value) {
    await nextTick()
    term.value?.focus()
  }
}

// ---------- write back ----------
const note = () => `rewrite history (${changedCount.value} commit${changedCount.value === 1 ? '' : 's'})`

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
    const stale = await staleFiles(r, base.value!, state.value!)
    const done = await writeToRepo(r, base.value!, state.value!, fallbackIdentity(), note())
    base.value = state.value
    past.value = []
    future.value = []
    origin.value = new Map()
    written.value = { updates: done, stale }
    diskCommits = null
    toast(`已寫入：更新了 ${done.length} 個分支／標籤`)
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
    if (data) saveBlob(new Blob([data as Uint8Array<ArrayBuffer>]), bundleName.value)
    bundleInfo.value = { name: data ? bundleName.value : '', size: data?.length ?? 0, commands }
  } catch (e) {
    toast(`打包失敗：${readError(e)}`, 6000)
  } finally {
    busy.value = ''
  }
}

async function copyCommands(lines: string[]) {
  toast((await copyText(lines.join('\n'))) ? '已複製指令' : '無法複製，請手動選取')
}

const updateText = (u: RefUpdate) => `${u.old ? (u.new ? '' : '刪除 ') : '新增 '}${u.name === 'HEAD' ? 'HEAD' : shortRef(u.name)}`

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
  if (!isOpen.value || preview.value || bundleInfo.value || editor.value || keyOpen.value) return
  const mod = e.metaKey || e.ctrlKey
  const key = e.key.toLowerCase()
  if (e.ctrlKey && key === '`') {
    e.preventDefault()
    toggleTerminal()
    return
  }
  if (isTyping(e.target)) return
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
  <div class="app" :class="{ dragging, 'with-term': termOpen && isOpen }" data-drop-label="放開以開啟這個 repo">
    <header class="top">
      <div class="brand">
        <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#0f8a6c"/><path d="M11 8v16M11 13c0 4 10 2 10 7" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="11" cy="8.5" r="2.6" fill="#fff"/><circle cx="11" cy="23.5" r="2.6" fill="#fff"/><circle cx="21" cy="21" r="2.6" fill="#bfe8dc"/></svg>
        <div>
          <h1>Git 編輯器</h1>
          <p v-if="!isOpen">在瀏覽器裡看 .git 的歷史，用表單或 git 指令修改 commit 與檔案，還能用私鑰簽名。</p>
        </div>
      </div>
      <div v-if="isOpen && history" class="repo-info">
        <Icon name="repo" />
        <b>{{ repoName }}</b>
        <span class="stats">
          {{ history.commits.size.toLocaleString() }} 個 commit · {{ branchCount }} 個分支<template v-if="repo!.algo === 'sha256'"> · SHA-256</template>
        </span>
        <span v-if="changedCount" class="badge">{{ changedCount }} 個新的或改過的 commit，還沒寫入</span>
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
          <li><strong>看歷史</strong>：所有分支、標籤、遠端分支畫成樹狀的 commit 圖，可以搜尋訊息、作者、hash；也能找出沒有分支指著的 dangling commit。</li>
          <li><strong>切換</strong>：在頁面裡切到任何分支、標籤或 commit（包括 dangling commit），看它的檔案樹。不會動到你資料夾裡的 HEAD 和檔案。</li>
          <li><strong>看內容</strong>：每個 commit 的檔案樹、檔案內容與原始物件；也能直接瀏覽 .git 資料夾，loose 物件、pack 索引、暫存區都會解讀。</li>
          <li><strong>改 commit</strong>：訊息、作者、提交者，以及作者時間和提交者時間（含時區），還有 commit 裡的檔案內容。後面的 commit 會跟著改寫（檔案的修改像 rebase 那樣帶過去），分支與標籤一起移過去；遠端分支不動。</li>
          <li><strong>git 指令</strong>：內建終端機，可以 status、log、diff、add、commit --amend、rebase -i、cherry-pick、merge、reset、branch、tag……用 edit、echo 改檔案。</li>
          <li><strong>簽名（可選）</strong>：用 SSH（ed25519、RSA、ECDSA）或 GPG 私鑰簽名，有密碼的私鑰也可以。git <code>verify-commit</code> 驗得過。</li>
          <li><strong>寫回去</strong>：Chrome、Edge 可以直接寫回 .git，並留下 reflog（隨時能用 <code>git reflog</code> 退回）。其他瀏覽器下載一個 bundle，用 git 指令套用。</li>
          <li><strong>可以復原</strong>：寫入前的每一步都能復原（⌘Z）。寫入前會檢查分支有沒有在別處被改過，有就不寫。</li>
        </ul>
        <p class="caution">
          <Icon name="alert" />
          改 commit 就是改寫歷史：commit 的 hash 都會變。已經推上遠端的分支，要用 <code>git push --force-with-lease</code> 才能更新，和別人共用的分支請先講好。
        </p>
      </section>
    </template>

    <template v-else-if="history && state && snap">
      <div class="toolbar panel">
        <div class="tabs" role="tablist">
          <button type="button" role="tab" class="tab" :class="{ on: view === 'graph' }" :aria-selected="view === 'graph'"
                  @click="view = 'graph'"><Icon name="branch" /><span>提交歷史</span></button>
          <button type="button" role="tab" class="tab" :class="{ on: view === 'files' }" :aria-selected="view === 'files'"
                  @click="view = 'files'"><Icon name="folder" /><span>.git 檔案</span></button>
        </div>
        <label class="checkout" title="在這個頁面裡切換分支、標籤或 commit（不會動到 repo 的 HEAD 和工作目錄）">
          <Icon name="commit" />
          <select :value="checkoutValue" :disabled="termBusy || !!busy" aria-label="切換到" @change="onCheckoutPick">
            <option v-if="!snap.work.head.ref" :value="checkoutValue">HEAD（{{ snap.work.head.hash?.slice(0, 7) ?? '沒有 commit' }}）</option>
            <optgroup v-if="refOptions('refs/heads/').length" label="分支">
              <option v-for="b in refOptions('refs/heads/')" :key="b" :value="`branch:${b}`">{{ b }}</option>
            </optgroup>
            <optgroup v-if="refOptions('refs/tags/').length" label="標籤">
              <option v-for="t in refOptions('refs/tags/')" :key="t" :value="`rev:${t}`">{{ t }}</option>
            </optgroup>
            <optgroup v-if="refOptions('refs/remotes/').length" label="遠端分支">
              <option v-for="r in refOptions('refs/remotes/')" :key="r" :value="`rev:${r}`">{{ r }}</option>
            </optgroup>
            <optgroup v-if="danglingTips.length" label="Dangling commit">
              <option v-for="h in danglingTips" :key="h" :value="`rev:${h}`">
                {{ h.slice(0, 7) }} {{ history.commits.get(h)?.message.split('\n', 1)[0].slice(0, 40) }}
              </option>
            </optgroup>
          </select>
        </label>
        <div class="group">
          <button type="button" class="btn icon" :disabled="!past.length || !!busy || termBusy" title="復原（⌘Z）" @click="undo"><Icon name="undo" /></button>
          <button type="button" class="btn icon" :disabled="!future.length || !!busy || termBusy" title="重做（⌘⇧Z）" @click="redo"><Icon name="redo" /></button>
          <button type="button" class="btn" :class="{ on: termOpen }" title="git 指令（Ctrl+`）" @click="toggleTerminal">
            <Icon name="terminal" /><span>終端機</span>
          </button>
        </div>
        <div class="group end">
          <button type="button" class="btn" :class="{ primary: !canWrite }" :disabled="!updates.length || !!busy"
                  title="下載只含新 commit 的 git bundle，再用 git 指令套用" @click="downloadBundle">
            <Icon name="package" /><span>下載 bundle</span>
          </button>
          <button v-if="canWrite" type="button" class="btn primary" :disabled="!updates.length || !!busy"
                  title="把新的 commit 寫進 .git，並更新分支和標籤" @click="writeBack">
            <Icon name="save" /><span class="clip">{{ busy || '寫入 .git' }}</span>
          </button>
          <button type="button" class="btn icon" title="關閉這個 repo" @click="closeRepo"><Icon name="x" /></button>
        </div>
      </div>

      <div v-if="updates.length" class="banner">
        <Icon name="history" />
        <span class="grow">
          {{ changedCount ? `有 ${changedCount} 個新的或改過的 commit，` : '' }}會更新
          <b v-for="(u, i) in updates" :key="u.name">{{ i ? '、' : '' }}{{ updateText(u) }}</b>。
          還沒寫入：{{ canWrite ? '按「寫入 .git」，或' : '這個瀏覽器不能直接寫入資料夾，請' }}下載 bundle 用 git 套用。
        </span>
        <button type="button" class="btn small" :disabled="!!busy || termBusy" @click="discardAll">全部放棄</button>
      </div>
      <div v-if="written && !updates.length" class="banner">
        <Icon name="check" />
        <span class="grow">
          已寫入 .git，可以用 <code>git reflog</code> 退回。
          <template v-if="written.stale.length">repo 目前 checkout 的檔案還是舊的內容，要更新請在電腦的終端機執行：<code class="cmd">{{ restoreCommand(written.stale) }}</code></template>
          遠端的歷史還是舊的{{ pushHints.length ? '，要更新請執行：' : '。' }}
          <code v-for="c in pushHints" :key="c" class="cmd">{{ c }}</code>
        </span>
        <button type="button" class="btn small" @click="written = null">知道了</button>
      </div>
      <div v-if="!canWrite && !updates.length && !written" class="banner subtle">
        <Icon name="alert" />
        <span class="grow">這個瀏覽器只能讀取資料夾。改好之後可以下載 bundle，用 git 指令套用；在 Chrome 或 Edge 開啟則能直接寫回。</span>
      </div>

      <div v-show="view === 'graph'" class="work" :class="{ previewing: selected }">
        <CommitGraph ref="graph" v-model:remotes="showRemotes" v-model:dangling="showDangling" class="panel" :history="history"
                     :selected="selected" :mark="markOf" :has-remotes="hasRemotes" :scanning="scanning"
                     @select="(h) => (selected = h)" />
        <CommitPane v-if="selected && history.commits.has(selected)" v-model:signer="signer" :repo="repo!"
                    :history="history" :hash="selected" :origin="origin.get(selected) || null" :busy="!!busy || termBusy"
                    :locked="locked" :edit-text="editText" @close="selected = null" @select="(h) => (selected = h)"
                    @apply="apply" @open-file="openFile" @toast="toast" @checkout="checkoutCommit" @branch="branchAt" />
      </div>
      <GitDirView v-if="view === 'files'" :repo="repo!" />

      <Terminal v-if="termOpen" ref="term" :lines="termLines" :prompt="prompt" :busy="termBusy" :key-label="signer?.label ?? null"
                :complete="completeLine" @run="runCommand" @close="termOpen = false" @key="keyOpen = true" @clear="termLines = []" />
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

    <Modal v-if="bundleInfo" title="套用到 repo" @close="bundleInfo = null">
      <p v-if="bundleInfo.name">已下載 <b>{{ bundleInfo.name }}</b>（{{ fmtBytes(bundleInfo.size) }}），裡面只有新的 commit。把它放進 repo 資料夾。</p>
      <p>在 repo 資料夾裡打開終端機執行：</p>
      <pre class="code wrap">{{ bundleInfo.commands.join('\n') }}</pre>
      <div class="start-btns left">
        <button type="button" class="btn primary" @click="copyCommands(bundleInfo.commands)"><Icon name="copy" />複製指令</button>
      </div>
      <p class="small muted">
        {{ bundleInfo.name ? '第一行把新的 commit 放進 repo（git 會先確認它們和原本的歷史接得上），之後' : '' }}每一行更新一個分支或標籤；
        要是它在這之間被改過，git 會拒絕，不會蓋掉。套用後可以刪掉 bundle 檔。
      </p>
      <p class="small muted">套用之後這裡看到的還是套用前的狀態；要繼續改，請重新開啟 repo。</p>
    </Modal>

    <Modal v-if="keyOpen" title="簽名用的私鑰" @close="keyOpen = false">
      <KeyPanel v-model="signer" />
      <p class="small muted">終端機裡 <code>git commit -S</code>、<code>git tag -s</code>、<code>git rebase -S</code> 會用這把私鑰簽名；repo 設了 commit.gpgsign=true 時，commit 一律簽名。</p>
    </Modal>

    <EditorDialog v-if="editor" :title="editor.title" :text="editor.text" @done="closeEditor" />

    <input ref="dirInput" type="file" hidden @change="onPickDir" />
  </div>
</template>
