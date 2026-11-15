<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { binToText, decoder } from '../git/bytes'
import { isBinary } from '../git/diff'
import { readError } from '../git/fs'
import { fileToText } from '../git/shell'
import { shortRef, type History } from '../git/history'
import { parseTree, type CommitEdit, type Person, type SigKind } from '../git/objects'
import type { Repo } from '../git/repo'
import { affected, movable, type DescendantSigs, type RewriteRequest } from '../git/rewrite'
import type { Signer } from '../git/sign'
import { copyText, fmtTime, fromInput, nowSeconds, toInput, validTz } from '../util'
import Icon from './Icon.vue'
import KeyPanel from './KeyPanel.vue'
import TreeNode, { type TNode } from './TreeNode.vue'

const props = defineProps<{
  repo: Repo
  history: History
  hash: string
  origin: string | null // the commit's hash before it was rewritten here
  busy: boolean
  locked: string // why editing isn't possible right now (a rebase in the terminal), or ''
  editText: (title: string, text: string) => Promise<string | null>
}>()
const signer = defineModel<Signer | null>('signer', { required: true })
const emit = defineEmits<{
  close: []
  select: [hash: string]
  apply: [req: RewriteRequest]
  openFile: [path: string, hash: string]
  toast: [msg: string]
  checkout: [hash: string]
  branch: [hash: string]
}>()

const commit = computed(() => props.history.commits.get(props.hash)!)
const subjectOf = (h: string) => props.history.commits.get(h)?.message.split('\n', 1)[0] ?? ''

// ---------- the form ----------
type SigChoice = 'keep' | 'none' | 'sign'
const form = reactive({
  message: '',
  aName: '', aEmail: '', aDate: '', aTz: '',
  same: true, // committer follows the author
  cName: '', cEmail: '', cDate: '', cTz: '',
  sig: 'none' as SigChoice,
  // These two carry over from commit to commit.
  descendants: 'drop' as DescendantSigs,
  moveTags: true,
})

const samePerson = (a: Person, b: Person) => a.name === b.name && a.email === b.email && a.time === b.time && a.tz === b.tz
const shownMessage = (m: string) => m.replace(/\n$/, '')

// Files changed here (raw path → new content), applied with the rest of the form.
const fileEdits = shallowRef(new Map<string, Uint8Array>())
const editedPaths = computed(() => new Set(fileEdits.value.keys()))

async function editFile(node: TNode, rawPath: string, path: string) {
  try {
    const current = fileEdits.value.get(rawPath) ?? (await props.repo.read(node.id)).data
    if (isBinary(current)) return emit('toast', `${path} 是二進位檔案，這裡只能改文字檔`)
    if (current.length > 2 << 20) return emit('toast', `${path} 超過 2 MB，這裡的編輯器打不開`)
    const f = fileToText(current)
    const text = await props.editText(`${path}（${commit.value.hash.slice(0, 7)}）`, f.text)
    if (text === null || text === f.text) return
    const next = new Map(fileEdits.value)
    const original = (await props.repo.read(node.id)).data
    const data = f.save(text)
    if (data.length === original.length && data.every((b, i) => b === original[i])) next.delete(rawPath)
    else next.set(rawPath, data)
    fileEdits.value = next
  } catch (e) {
    emit('toast', readError(e))
  }
}

function revertFile(rawPath: string) {
  const next = new Map(fileEdits.value)
  next.delete(rawPath)
  fileEdits.value = next
}

function reset() {
  fileEdits.value = new Map()
  const c = commit.value
  Object.assign(form, {
    message: shownMessage(c.message),
    aName: c.author.name, aEmail: c.author.email, aDate: toInput(c.author.time, c.author.tz), aTz: c.author.tz,
    same: samePerson(c.author, c.committer),
    cName: c.committer.name, cEmail: c.committer.email, cDate: toInput(c.committer.time, c.committer.tz), cTz: c.committer.tz,
    sig: c.sig ? 'keep' : 'none',
  })
}
watch(() => props.hash, reset, { immediate: true })

function onSameToggle() {
  if (form.same) return
  Object.assign(form, { cName: form.aName, cEmail: form.aEmail, cDate: form.aDate, cTz: form.aTz })
}

function setNow(who: 'a' | 'c') {
  const tz = who === 'a' ? form.aTz : form.cTz
  const value = toInput(nowSeconds(), validTz(tz) ? tz : '+0000')
  if (who === 'a') form.aDate = value
  else form.cDate = value
}

const person = (name: string, email: string, date: string, tz: string): Person => ({
  name: name.trim(), email: email.trim(), time: validTz(tz) ? fromInput(date, tz) : NaN, tz,
})
const author = computed(() => person(form.aName, form.aEmail, form.aDate, form.aTz))
const committer = computed(() => (form.same ? author.value : person(form.cName, form.cEmail, form.cDate, form.cTz)))

const problems = computed(() => {
  const out: string[] = []
  const check = (p: Person, who: string) => {
    if (/[<>\n]/.test(p.name + p.email)) out.push(`${who}的名字和 email 不能有 <、> 或換行。`)
    if (!validTz(p.tz)) out.push(`${who}的時區要寫成 +0800、-0500 這樣。`)
    else if (!Number.isFinite(p.time)) out.push(`${who}的時間不完整。`)
    else if (p.time < 0) out.push(`${who}的時間不能早於 1970 年。`)
  }
  check(author.value, '作者')
  if (!form.same) check(committer.value, '提交者')
  return out
})

const edit = computed<CommitEdit>(() => {
  const c = commit.value
  const e: CommitEdit = {}
  if (!samePerson(author.value, c.author)) e.author = author.value
  if (!samePerson(committer.value, c.committer)) e.committer = committer.value
  if (form.message !== shownMessage(c.message)) e.message = form.message
  return e
})
const edited = computed(() => Object.keys(edit.value).length > 0 || fileEdits.value.size > 0)
const formDirty = computed(() => edited.value || form.same !== samePerson(commit.value.author, commit.value.committer) || form.sig !== (commit.value.sig ? 'keep' : 'none'))

// ---------- what else gets rewritten ----------
const affectedWithTags = computed(() => affected(props.history, props.hash, true))
const affectedList = computed(() => (form.moveTags ? affectedWithTags.value : affected(props.history, props.hash, false)))
const reachable = computed(() => affectedList.value.length > 0)
const descendants = computed(() => affectedList.value.slice(1))
const signedDescendants = computed(() => descendants.value.filter((h) => props.history.commits.get(h)!.sig).length)
const tagsHere = computed(() => {
  const set = new Set(affectedWithTags.value)
  return [...props.history.peeled].filter(([n, h]) => n.startsWith('refs/tags/') && set.has(h)).map(([n]) => shortRef(n))
})
const movingRefs = computed(() => {
  const set = new Set(affectedList.value)
  return [...props.history.peeled].filter(([n, h]) => (movable(n, form.moveTags) || n === 'HEAD') && set.has(h)).map(([n]) => shortRef(n))
})
watch(signedDescendants, (n) => {
  if (!n && form.descendants === 'resign') form.descendants = 'drop'
})

const willSign = computed(() => form.sig === 'sign')
const needsKey = computed(() => willSign.value || (form.descendants !== 'drop' && descendants.value.length > 0))
const changes = computed(() => edited.value || willSign.value || (form.sig === 'none' && !!commit.value.sig))
const canApply = computed(
  () => reachable.value && !props.locked && !problems.value.length && !props.busy && changes.value && (!needsKey.value || !!signer.value),
)
const blocker = computed(() => {
  if (!reachable.value || props.busy || props.locked) return ''
  if (problems.value.length) return ''
  if (!changes.value) return '改一下欄位，或選擇簽名，就能套用。'
  if (needsKey.value && !signer.value) return '要簽名，請先在上面載入私鑰。'
  return `會改寫 ${affectedList.value.length} 個 commit${movingRefs.value.length ? `，移動 ${movingRefs.value.join('、')}` : ''}。`
})

function apply() {
  if (!canApply.value) return
  emit('apply', {
    target: props.hash,
    edit: edit.value,
    sign: willSign.value,
    descendants: descendants.value.length ? form.descendants : 'drop',
    signer: signer.value,
    moveTags: form.moveTags,
    files: fileEdits.value.size ? fileEdits.value : undefined,
  })
}

// ---------- details ----------
const SIG_NAMES: Record<SigKind, string> = { pgp: 'GPG 簽名', ssh: 'SSH 簽名', x509: 'X.509 簽名', other: '有簽名' }
const labels = computed(() => props.history.labels.get(props.hash) ?? [])
const children = computed(() => props.history.children.get(props.hash) ?? [])

async function copyHash() {
  emit('toast', (await copyText(props.hash)) ? '已複製 commit hash' : '無法複製')
}

const treeRoots = shallowRef<TNode[]>([])
const treeError = ref('')
async function loadTree(node: TNode): Promise<TNode[]> {
  const o = await props.repo.read(node.id)
  return parseTree(o.data, props.repo.hashLen)
    .map((e) => ({
      name: e.name,
      raw: e.raw,
      id: e.hash,
      dir: e.mode === '40000',
      note: e.mode === '160000' ? 'submodule' : e.mode === '120000' ? '連結' : undefined,
    }))
    .sort((a, b) => +b.dir - +a.dir || a.name.localeCompare(b.name))
}
let treeToken = 0
watch(
  () => commit.value.tree,
  async (tree) => {
    const token = ++treeToken
    treeRoots.value = []
    treeError.value = ''
    try {
      const nodes = await loadTree({ name: '', id: tree, dir: true })
      if (token === treeToken) treeRoots.value = nodes
    } catch (e) {
      if (token === treeToken) treeError.value = readError(e)
    }
  },
  { immediate: true },
)

const rawText = ref('')
const rawOpen = ref(false)
async function loadRaw() {
  rawText.value = decoder().decode((await props.repo.read(props.hash)).data)
}
watch(() => props.hash, () => rawOpen.value && loadRaw())
function onRawToggle(e: Event) {
  rawOpen.value = (e.target as HTMLDetailsElement).open
  if (rawOpen.value) loadRaw()
}

const TZS = ['+0000', '+0100', '+0200', '+0300', '+0400', '+0530', '+0700', '+0800', '+0900', '+1000', '+1200', '-0300', '-0400', '-0500', '-0600', '-0700', '-0800', '-1000']
</script>

<template>
  <section class="panel pane">
    <header class="pane-head">
      <Icon name="commit" />
      <b>commit</b>
      <code class="clip grow" :title="hash">{{ hash.slice(0, 12) }}</code>
      <button type="button" class="btn icon small" title="複製完整 hash" @click="copyHash"><Icon name="copy" /></button>
      <button type="button" class="btn small" title="在這個頁面裡 checkout 這個 commit（不會動到 repo 的 HEAD）" @click="emit('checkout', hash)">
        <Icon name="branch" />切換到這裡
      </button>
      <button type="button" class="btn icon small" title="在這個 commit 建立新分支" @click="emit('branch', hash)"><Icon name="plus" /></button>
      <button type="button" class="btn icon small" title="關閉（Esc）" @click="emit('close')"><Icon name="x" /></button>
    </header>

    <div class="pane-body">
      <div v-if="labels.length" class="pane-refs">
        <span v-for="l in labels" :key="l.name" class="chip" :class="`chip-${l.kind}`">
          <Icon :name="l.kind === 'tag' ? 'tag' : l.kind === 'dangling' ? 'alert' : l.kind === 'head' ? 'commit' : 'branch'" />{{ l.short }}{{ l.current ? '（目前）' : '' }}
        </span>
      </div>
      <p v-if="origin" class="note changed-note">改寫過、還沒寫入。原本是 <code>{{ origin.slice(0, 10) }}</code>。</p>
      <p v-if="!reachable" class="note warn-note">
        <Icon name="alert" />
        <span>
          沒有本地分支{{ form.moveTags ? '' : '或標籤' }}包含這個 commit，改了也不會有分支指向它，所以不能在這裡改。
          要改它，先按 <Icon name="plus" class="inline" /> 在這裡建一個分支（或按「切換到這裡」再到終端機 git switch -c 新分支）。
        </span>
      </p>

      <p v-if="locked" class="note warn-note"><Icon name="alert" />{{ locked }}</p>

      <fieldset class="form" :disabled="!reachable || busy || !!locked">
        <label class="field">
          <span class="label">訊息</span>
          <textarea v-model="form.message" rows="5" spellcheck="false"></textarea>
        </label>

        <div class="group">
          <span class="label">作者</span>
          <div class="pair">
            <input v-model="form.aName" placeholder="名字" aria-label="作者名字" autocomplete="off" />
            <input v-model="form.aEmail" placeholder="email" aria-label="作者 email" autocomplete="off" />
          </div>
          <div class="when-row">
            <input v-model="form.aDate" type="datetime-local" step="1" aria-label="作者時間" />
            <input v-model="form.aTz" class="tz" list="tz-list" maxlength="5" aria-label="作者時區" title="時區（和 UTC 差幾小時幾分）" />
            <button type="button" class="btn small" @click="setNow('a')"><Icon name="clock" />現在</button>
          </div>
        </div>

        <div class="group">
          <div class="label-row">
            <span class="label">提交者</span>
            <label class="check"><input v-model="form.same" type="checkbox" @change="onSameToggle" />和作者一樣</label>
          </div>
          <template v-if="!form.same">
            <div class="pair">
              <input v-model="form.cName" placeholder="名字" aria-label="提交者名字" autocomplete="off" />
              <input v-model="form.cEmail" placeholder="email" aria-label="提交者 email" autocomplete="off" />
            </div>
            <div class="when-row">
              <input v-model="form.cDate" type="datetime-local" step="1" aria-label="提交者時間" />
              <input v-model="form.cTz" class="tz" list="tz-list" maxlength="5" aria-label="提交者時區" />
              <button type="button" class="btn small" @click="setNow('c')"><Icon name="clock" />現在</button>
            </div>
          </template>
          <p v-else class="hint">跟著作者一起改。git log 預設顯示作者時間；commit 的排序和 GitHub 的「committed」看提交者時間。</p>
        </div>

        <div class="group">
          <div class="label-row">
            <span class="label">簽名</span>
            <span class="hint">目前{{ commit.sig ? `：${SIG_NAMES[commit.sig]}（這裡不驗證）` : '沒有簽名' }}</span>
          </div>
          <select v-model="form.sig" aria-label="簽名">
            <option v-if="commit.sig" value="keep">保留原本的簽名</option>
            <option value="none">{{ commit.sig ? '移除簽名' : '不簽名' }}</option>
            <option value="sign">{{ commit.sig ? '用私鑰重新簽名' : '用私鑰簽名' }}</option>
          </select>
          <p v-if="form.sig === 'keep' && edited" class="note warn-note">
            一改內容，原本的簽名就對不上了，會被移除。要保留簽名請選「用私鑰重新簽名」。
          </p>
        </div>

        <div v-if="descendants.length" class="group">
          <span class="label">後面的 {{ descendants.length }} 個 commit</span>
          <p class="hint">
            它們的 parent 換了，所以也會改寫：內容、作者、時間都不變，只有 hash 會變。
            {{ signedDescendants ? `其中 ${signedDescendants} 個原本有簽名，簽名會失效。` : '' }}
          </p>
          <select v-model="form.descendants" aria-label="後面 commit 的簽名">
            <option value="drop">{{ signedDescendants ? '移除失效的簽名' : '不簽名' }}</option>
            <option v-if="signedDescendants" value="resign">原本有簽名的，用私鑰重新簽名</option>
            <option value="all">全部用私鑰簽名</option>
          </select>
        </div>

        <div v-if="fileEdits.size" class="group">
          <span class="label">修改的檔案</span>
          <ul class="edited">
            <li v-for="[path] in fileEdits" :key="path">
              <code>{{ binToText(path) }}</code>
              <button type="button" class="btn small" @click="revertFile(path)">還原</button>
            </li>
          </ul>
          <p class="hint">{{ descendants.length ? `後面的 ${descendants.length} 個 commit 也會帶入同樣的修改（像 rebase 那樣合併）；有 commit 改到同一段的話會取消，什麼都不改。` : '' }}</p>
        </div>

        <div v-if="needsKey || signer" class="group">
          <span class="label">私鑰</span>
          <KeyPanel v-model="signer" />
        </div>

        <label v-if="tagsHere.length" class="check">
          <input v-model="form.moveTags" type="checkbox" />
          標籤也移到改寫後的 commit（{{ tagsHere.join('、') }}）
        </label>

        <ul v-if="problems.length" class="problems">
          <li v-for="p in problems" :key="p">{{ p }}</li>
        </ul>

        <div class="apply-row">
          <button type="button" class="btn primary" :disabled="!canApply" @click="apply"><Icon name="check" />套用修改</button>
          <button type="button" class="btn" :disabled="!formDirty" @click="reset">還原欄位</button>
          <span class="hint grow">{{ blocker }}</span>
        </div>
      </fieldset>

      <dl class="info">
        <dt>parent</dt>
        <dd>
          <span v-if="!commit.parents.length" class="muted">沒有（第一個 commit）</span>
          <button v-for="p in commit.parents" :key="p" type="button" class="link" :disabled="!history.commits.has(p)"
                  :title="history.commits.has(p) ? subjectOf(p) : '不在這個 repo 裡（淺層複製）'" @click="emit('select', p)">
            <code>{{ p.slice(0, 7) }}</code> {{ subjectOf(p) }}
          </button>
        </dd>
        <template v-if="children.length">
          <dt>child</dt>
          <dd>
            <button v-for="ch in children" :key="ch" type="button" class="link" @click="emit('select', ch)">
              <code>{{ ch.slice(0, 7) }}</code> {{ subjectOf(ch) }}
            </button>
          </dd>
        </template>
        <dt>作者</dt>
        <dd>{{ commit.author.name }} &lt;{{ commit.author.email }}&gt; · {{ fmtTime(commit.author.time, commit.author.tz) }} {{ commit.author.tz }}</dd>
        <dt>提交者</dt>
        <dd>{{ commit.committer.name }} &lt;{{ commit.committer.email }}&gt; · {{ fmtTime(commit.committer.time, commit.committer.tz) }} {{ commit.committer.tz }}</dd>
        <dt>tree</dt>
        <dd><code>{{ commit.tree }}</code></dd>
      </dl>

      <details class="block" open>
        <summary>檔案</summary>
        <p class="hint">點檔名看內容；按 <Icon name="pencil" class="inline" /> 修改這個 commit 裡的檔案，改好再按「套用修改」。</p>
        <p v-if="treeError" class="error">{{ treeError }}</p>
        <ul class="tree">
          <TreeNode v-for="n in treeRoots" :key="n.name" :node="n" :path="n.name" :raw-path="n.raw" :depth="0" :load="loadTree"
                    :active="null" :editable="reachable && !locked" :edited="editedPaths"
                    @open="(node, path) => emit('openFile', path, node.id)" @edit="editFile" />
        </ul>
      </details>
      <details class="block" @toggle="onRawToggle">
        <summary>原始內容</summary>
        <pre class="code">{{ rawText }}</pre>
      </details>
    </div>

    <datalist id="tz-list">
      <option v-for="tz in TZS" :key="tz" :value="tz" />
    </datalist>
  </section>
</template>

<style scoped>
.pane-refs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.note { display: flex; align-items: flex-start; gap: 6px; margin: 0 0 12px; padding: 8px 10px; border-radius: 10px; font-size: 13.5px; }
.note .icon { margin-top: 2px; }
.changed-note { background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--warn); display: block; }
.warn-note { background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--warn); }
.form { display: grid; gap: 14px; margin: 0; padding: 0; border: 0; min-width: 0; }
.form:disabled { opacity: .6; }
.field, .group { display: grid; gap: 6px; min-width: 0; }
.label { font-size: 13px; font-weight: 600; color: var(--muted); }
.label-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.pair { display: grid; grid-template-columns: 1fr 1.3fr; gap: 6px; }
.when-row { display: flex; flex-wrap: wrap; gap: 6px; }
.when-row input[type='datetime-local'] { flex: 1; min-width: 13.5em; }
.tz { width: 6.6em; font-variant-numeric: tabular-nums; }
textarea { width: 100%; resize: vertical; min-height: 6em; }
.hint { margin: 0; color: var(--muted); font-size: 12.5px; }
.edited { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.edited li { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.edited code { color: var(--warn); overflow-wrap: anywhere; }
.inline { width: 13px; height: 13px; vertical-align: -2px; }
.problems { margin: 0; padding-left: 1.2em; color: var(--danger); font-size: 13px; }
.apply-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 2px; }
.info { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 14px; margin: 20px 0 6px; padding-top: 14px; border-top: 1px solid var(--line); font-size: 13.5px; }
.info dt { color: var(--muted); }
.info dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.info code { font-size: 12.5px; }
.link {
  display: block; max-width: 100%; padding: 0; border: 0; background: none; color: var(--text); font: inherit; text-align: left;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer;
}
.link code { color: var(--accent); }
.link:hover code { text-decoration: underline; }
.link:disabled { cursor: default; color: var(--muted); }
.block { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
.block summary { cursor: pointer; font-weight: 600; font-size: 14px; margin-bottom: 6px; }
.tree { margin: 0; padding: 0; list-style: none; }
.error { color: var(--danger); font-size: 13px; }
@media (max-width: 520px) {
  .pair { grid-template-columns: 1fr; }
}
</style>
