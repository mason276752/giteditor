import { binToText, decoder, enc, fromBin, textToBin, toBin } from './bytes'
import { isBinary } from './diff'
import { formatPerson, insertCommitSig, type Commit, type Person } from './objects'
import type { Repo } from './repo'
import { GitError, now, parseDate } from './revs'
import type { Signer } from './sign'
import { flatten, type Entry, type Files } from './tree'
import { GIT, GIT_HELP } from './gitcmd'
import { headCommit, headTree, type Snapshot, type Work } from './work'

export interface Line {
  kind: 'cmd' | 'out' | 'err' | 'hint'
  text: string
}

// What the page provides: editors for files, messages and rebase todo lists, and the dangling scan.
export interface Hooks {
  editText(title: string, text: string): Promise<string | null>
  dangling(): Promise<string[]>
}

export interface ShellEnv {
  repo: Repo
  snap: Snapshot
  signer: Signer | null
  config: Map<string, string> // `git config` set here; only for this page
  hooks: Hooks
  noted?: Set<string> // hints already shown this session
}

export interface RunResult {
  lines: Line[]
  snap: Snapshot
  rewritten: [string, string][] // new commit → the commit it replaces
  created: string[] // brand-new commits
  clear: boolean
}

// ---------- the context commands run in ----------
export class Ctx {
  lines: Line[] = []
  rewritten: [string, string][] = []
  created: string[] = []
  env: Record<string, string> = {}
  clear = false

  constructor(public sh: ShellEnv) {}

  get repo() {
    return this.sh.repo
  }
  get snap() {
    return this.sh.snap
  }
  set snap(s: Snapshot) {
    this.sh.snap = s
  }

  out(text: string) {
    this.lines.push({ kind: 'out', text })
  }
  err(text: string) {
    this.lines.push({ kind: 'err', text })
  }
  hint(text: string) {
    this.lines.push({ kind: 'hint', text })
  }
  // A hint shown only the first time in a session.
  note(key: string, text: string) {
    const seen = (this.sh.noted ??= new Set())
    if (seen.has(key)) return
    seen.add(key)
    this.hint(text)
  }
  fail(text: string): never {
    throw new GitError(text)
  }

  config(key: string): string | undefined {
    return this.sh.config.get(key) ?? this.repo.config.get(key)
  }

  head() {
    return headCommit(this.snap)
  }
  headTree() {
    return headTree(this.repo, this.snap)
  }
  branch() {
    const ref = this.snap.work.head.ref
    return ref?.startsWith('refs/heads/') ? ref.slice(11) : null
  }

  // The index and working tree as full file lists (HEAD's tree when nothing changed).
  async work(): Promise<{ head: Files; index: Files; files: Files }> {
    const head = await flatten(this.repo, await this.headTree())
    const index = new Map(this.snap.work.index ?? head)
    const files = new Map(this.snap.work.files ?? index)
    return { head, index, files }
  }

  // Stores them back, as "unchanged" where they match HEAD or the index.
  async setWork(index: Files, files: Files) {
    const head = await flatten(this.repo, await this.headTree())
    const same = (a: Files, b: Files) => a.size === b.size && [...a].every(([p, e]) => b.get(p)?.hash === e.hash && b.get(p)?.mode === e.mode)
    this.patchWork({ index: same(index, head) ? null : index, files: same(files, index) ? null : files })
  }

  patchWork(patch: Partial<Work>) {
    this.snap = { ...this.snap, work: { ...this.snap.work, ...patch } }
  }

  setRef(name: string, hash: string | null) {
    const refs = new Map(this.snap.refs.refs)
    if (hash) refs.set(name, hash)
    else refs.delete(name)
    const disk = this.snap.refs.head
    const head = disk.ref ? { ref: disk.ref, hash: refs.get(disk.ref) ?? null } : disk
    this.snap = { ...this.snap, refs: { refs, head } }
  }

  // Moves what the page has checked out: its branch, or HEAD itself when detached.
  moveHead(hash: string) {
    const ref = this.snap.work.head.ref
    if (ref) this.setRef(ref, hash)
    this.patchWork({ head: { ref, hash } })
  }

  ident(kind: 'author' | 'committer'): Person {
    const K = kind.toUpperCase()
    let name = this.env[`GIT_${K}_NAME`] ?? this.config('user.name')
    let email = this.env[`GIT_${K}_EMAIL`] ?? this.config('user.email')
    if (!name || !email) {
      const h = this.head()
      const c = h ? this.repo.cachedCommit(h) : undefined
      name ??= c?.committer.name ?? 'giteditor'
      email ??= c?.committer.email ?? 'giteditor@localhost'
      this.note('identity', `（repo 沒有設定 user.name／user.email，先用 ${name} <${email}>。要換的話：git config user.name "名字" 和 git config user.email "信箱"）`)
    }
    const raw = this.env[`GIT_${K}_DATE`]
    const date = raw ? parseDate(raw) : now()
    if (!date) this.fail(`fatal: invalid date format: ${raw}`)
    return { name, email, ...date }
  }

  wantSign(on: boolean, off: boolean): boolean {
    const sign = !off && (on || this.config('commit.gpgsign') === 'true')
    if (sign && !this.sh.signer) this.fail('error: 要簽名，請先按終端機上方的「私鑰」載入私鑰（或加 --no-gpg-sign）\nfatal: failed to write commit object')
    return sign
  }

  async sign(payload: string, tag = false): Promise<string> {
    const armor = await this.sh.signer!.sign(fromBin(payload))
    return tag ? payload + armor : insertCommitSig(payload, this.repo.algo === 'sha256' ? 'gpgsig-sha256' : 'gpgsig', armor)
  }

  async newCommit(o: { tree: string; parents: string[]; author: Person; committer: Person; message: string; sign: boolean }) {
    let payload = textToBin(
      `tree ${o.tree}\n${o.parents.map((p) => `parent ${p}\n`).join('')}author ${formatPerson(o.author)}\ncommitter ${formatPerson(o.committer)}\n\n${o.message}`,
    )
    if (o.sign) payload = await this.sign(payload)
    const hash = await this.repo.add('commit', fromBin(payload))
    this.created.push(hash)
    return hash
  }

  async text(hash: string): Promise<string> {
    return toBin((await this.repo.read(hash)).data)
  }
}

export const short = (h: string) => h.slice(0, 7)
export const subject = (c: Commit) => c.message.split('\n', 1)[0]
// Paths as typed (relative to the repo's top) to tree paths, and back.
export const toPath = (p: string) => textToBin(p.replace(/^(\.\/)+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/'))
export const showPath = (p: string) => binToText(p)

// git's message cleanup: no trailing spaces, no leading/trailing or doubled blank lines, and
// (for messages from an editor) no # comment lines.
export function cleanup(msg: string, comments: boolean): string {
  const lines = msg.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).filter((l) => !comments || !l.startsWith('#'))
  const out: string[] = []
  for (const l of lines) if (l || (out.length && out.at(-1))) out.push(l)
  while (out.length && !out.at(-1)) out.pop()
  return out.length ? `${out.join('\n')}\n` : ''
}

// Paths matching a pathspec: the path itself, anything under it, or a glob ('*' crosses '/').
export function matchPaths(spec: string, paths: Iterable<string>): string[] {
  const p = toPath(spec)
  if (!p || p === '.' || spec === ':/') return [...paths]
  if (/[*?]/.test(p)) {
    const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}(/.*)?$`)
    return [...paths].filter((x) => re.test(x))
  }
  return [...paths].filter((x) => x === p || x.startsWith(`${p}/`))
}

// ---------- options ----------
export interface OptSpec {
  [key: string]: [names: string[], takesValue?: boolean]
}
export interface Opts {
  has(key: string): boolean
  get(key: string): string | undefined
  all(key: string): string[]
  rest: string[]
  paths: string[] | null // after `--`
}

export function parseOpts(args: string[], spec: OptSpec, c: Ctx): Opts {
  const found = new Map<string, string[]>()
  const rest: string[] = []
  let paths: string[] | null = null
  const byName = new Map<string, [string, boolean]>()
  for (const [key, [names, value]] of Object.entries(spec)) for (const n of names) byName.set(n, [key, !!value])
  const add = (key: string, v: string) => found.set(key, [...(found.get(key) ?? []), v])
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      paths = args.slice(i + 1)
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq < 0 ? a : a.slice(0, eq)
      const opt = byName.get(name)
      if (!opt) c.fail(`error: unknown option '${name.slice(2)}'`)
      if (opt[1]) {
        const v = eq >= 0 ? a.slice(eq + 1) : args[++i]
        if (v === undefined) c.fail(`error: option '${name.slice(2)}' requires a value`)
        add(opt[0], v)
      } else {
        add(opt[0], '')
      }
    } else if (a.startsWith('-') && a.length > 1) {
      // Bundled short options: -am "message"
      for (let j = 1; j < a.length; j++) {
        const opt = byName.get(`-${a[j]}`)
        if (!opt) c.fail(`error: unknown switch '${a[j]}'`)
        if (opt[1]) {
          const v = a.slice(j + 1) || args[++i]
          if (v === undefined) c.fail(`error: switch '${a[j]}' requires a value`)
          add(opt[0], v)
          break
        }
        add(opt[0], '')
      }
    } else {
      rest.push(a)
    }
  }
  return {
    has: (k) => found.has(k),
    get: (k) => found.get(k)?.at(-1),
    all: (k) => found.get(k) ?? [],
    rest,
    paths,
  }
}

// ---------- tokenizing ----------
interface Tok {
  s: string
  op?: boolean
}

function tokenize(line: string): Tok[] {
  const toks: Tok[] = []
  let cur: string | null = null
  const end = () => {
    if (cur !== null) toks.push({ s: cur })
    cur = null
  }
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (/\s/.test(ch)) {
      end()
    } else if (ch === "'") {
      const close = line.indexOf("'", i + 1)
      if (close < 0) throw new GitError('syntax error: 引號沒有成對')
      cur = (cur ?? '') + line.slice(i + 1, close)
      i = close
    } else if (ch === '"') {
      let s = ''
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === '\\' && /["\\$`]/.test(line[i + 1] ?? '')) i++
        s += line[i]
      }
      if (i >= line.length) throw new GitError('syntax error: 引號沒有成對')
      cur = (cur ?? '') + s
    } else if (ch === '\\') {
      cur = (cur ?? '') + (line[++i] ?? '')
    } else if (ch === '#' && cur === null) {
      break
    } else if ('&|;>'.includes(ch)) {
      end()
      const two = line.slice(i, i + 2)
      const op = ['&&', '||', '>>'].includes(two) ? two : ch
      if (op === '|' || op === '&') throw new GitError(`這裡不支援 ${op === '|' ? '管線（|）' : '背景執行（&）'}`)
      toks.push({ s: op, op: true })
      i += op.length - 1
    } else {
      cur = (cur ?? '') + ch
    }
  }
  end()
  return toks
}

interface Segment {
  words: string[]
  redirect: { append: boolean; path: string } | null
  after: '&&' | '||' | ';' | null // how it's joined to the previous one
}

function segments(toks: Tok[]): Segment[] {
  const out: Segment[] = []
  let seg: Segment = { words: [], redirect: null, after: null }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (!t.op) {
      seg.words.push(t.s)
    } else if (t.s === '>' || t.s === '>>') {
      const target = toks[++i]
      if (!target || target.op) throw new GitError('syntax error: > 後面要接檔名')
      seg.redirect = { append: t.s === '>>', path: target.s }
    } else {
      out.push(seg)
      seg = { words: [], redirect: null, after: t.s as Segment['after'] }
    }
  }
  out.push(seg)
  return out.filter((s) => s.words.length)
}

// ---------- running ----------
export async function run(sh: ShellEnv, line: string): Promise<RunResult> {
  const c = new Ctx(sh)
  let segs: Segment[] = []
  try {
    segs = segments(tokenize(line))
  } catch (e) {
    c.err((e as Error).message)
  }
  let ok = true
  for (const seg of segs) {
    if ((seg.after === '&&' && !ok) || (seg.after === '||' && ok)) continue
    ok = await exec(c, seg)
  }
  return { lines: c.lines, snap: sh.snap, rewritten: c.rewritten, created: c.created, clear: c.clear }
}

// One command, all or nothing: if it fails, whatever it changed is undone.
async function exec(c: Ctx, seg: Segment): Promise<boolean> {
  const words = [...seg.words]
  while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) {
    const w = words.shift()!
    c.env[w.slice(0, w.indexOf('='))] = w.slice(w.indexOf('=') + 1)
  }
  const before = { snap: c.snap, rewritten: c.rewritten.length, created: c.created.length }
  try {
    if (!words.length) return true
    const [cmd, ...args] = words
    if (seg.redirect && cmd !== 'echo') c.fail('這裡只有 echo 可以用 > 或 >> 寫進檔案')
    if (cmd === 'git') {
      const [sub, ...rest] = args
      if (!sub || sub === '--help' || sub === 'help') return help(c), true
      const handler = GIT[sub]
      if (!handler) c.fail(UNSUPPORTED[sub] ?? `git: '${sub}' 在這個頁面不支援。輸入 help 看可以用的指令。`)
      await handler(c, rest)
    } else {
      const builtin = BUILTINS[cmd]
      if (!builtin) c.fail(`${cmd}: command not found（這裡只能用 git 指令和 help 列出的幾個檔案指令）`)
      await builtin(c, args, seg.redirect)
    }
    return true
  } catch (e) {
    c.snap = before.snap
    c.rewritten.length = before.rewritten
    c.created.length = before.created
    if (e instanceof GitError) c.err(e.message)
    else {
      console.warn(e)
      c.err(`error: ${(e as Error).message}`)
    }
    return false
  } finally {
    c.env = {}
  }
}

const UNSUPPORTED: Record<string, string> = {
  push: '這個頁面不連網路。寫入 .git 之後，在電腦的終端機執行 git push（改寫過的分支要加 --force-with-lease）。',
  pull: '這個頁面不連網路，沒辦法 pull。',
  fetch: '這個頁面不連網路，沒辦法 fetch。',
  clone: '這個頁面不連網路，沒辦法 clone。請在電腦上 clone 好再拖進來。',
  stash: 'git stash 還不支援。可以先 commit，之後再用 git reset --soft HEAD~ 拿回來。',
}

// ---------- file commands on the page's working tree ----------
type Builtin = (c: Ctx, args: string[], redirect: Segment['redirect']) => Promise<void> | void

async function readFile(c: Ctx, files: Files, path: string): Promise<Uint8Array | null> {
  const e = files.get(path)
  return e ? (await c.repo.read(e.hash)).data : null
}

async function writeFile(c: Ctx, path: string, data: Uint8Array) {
  if (!path) c.fail('需要檔名')
  const { index, files } = await c.work()
  if ([...files.keys()].some((p) => p.startsWith(`${path}/`))) c.fail(`${showPath(path)}: Is a directory`)
  files.set(path, { mode: files.get(path)?.mode ?? '100644', hash: await c.repo.add('blob', data) })
  await c.setWork(index, files)
}

function dirEntries(files: Files, dir: string): string[] {
  const prefix = dir ? `${dir}/` : ''
  const names = new Set<string>()
  for (const p of files.keys()) {
    if (!p.startsWith(prefix)) continue
    const rest = p.slice(prefix.length)
    const slash = rest.indexOf('/')
    names.add(slash < 0 ? rest : `${rest.slice(0, slash)}/`)
  }
  return [...names].sort()
}

// Text for the editor: a UTF-8 BOM and CRLF line endings are put back on save.
export function fileToText(data: Uint8Array) {
  const bom = data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf
  const text = decoder().decode(bom ? data.subarray(3) : data)
  const crlf = text.includes('\r\n')
  return { text: crlf ? text.replace(/\r\n/g, '\n') : text, save: (t: string) => enc.encode((bom ? '\ufeff' : '') + (crlf ? t.replace(/\n/g, '\r\n') : t)) }
}

const BUILTINS: Record<string, Builtin> = {
  help: (c) => help(c),
  clear: (c) => {
    c.clear = true
  },
  pwd: (c) => c.out('/'),
  async ls(c, args) {
    const { files } = await c.work()
    const targets = args.filter((a) => !a.startsWith('-'))
    for (const t of targets.length ? targets : ['']) {
      const p = toPath(t)
      if (files.has(p)) {
        c.out(showPath(p))
        continue
      }
      const names = dirEntries(files, p)
      if (!names.length && p) return c.fail(`ls: ${t}: No such file or directory`)
      if (targets.length > 1) c.out(`${t}:`)
      c.out(names.map(showPath).join('  '))
    }
  },
  async cat(c, args) {
    if (!args.length) return c.fail('cat: 需要檔名')
    const { files } = await c.work()
    for (const a of args) {
      const data = await readFile(c, files, toPath(a))
      if (!data) return c.fail(`cat: ${a}: No such file or directory`)
      if (isBinary(data)) c.hint(`（${a} 是二進位檔案，${data.length.toLocaleString()} bytes）`)
      else c.out(decoder().decode(data).replace(/\n$/, ''))
    }
  },
  async echo(c, args, redirect) {
    let newline = true
    let escapes = false
    while (args[0] === '-n' || args[0] === '-e') {
      if (args.shift() === '-n') newline = false
      else escapes = true
    }
    let text = args.join(' ')
    if (escapes) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\')
    if (newline) text += '\n'
    if (!redirect) return c.out(text.replace(/\n$/, ''))
    const path = toPath(redirect.path)
    const { files } = await c.work()
    const old = redirect.append ? await readFile(c, files, path) : null
    await writeFile(c, path, old ? new Uint8Array([...old, ...enc.encode(text)]) : enc.encode(text))
  },
  async touch(c, args) {
    for (const a of args) {
      const { files } = await c.work()
      if (!files.has(toPath(a))) await writeFile(c, toPath(a), new Uint8Array())
    }
  },
  async edit(c, args) {
    if (args.length !== 1) return c.fail('用法：edit <檔名>')
    const path = toPath(args[0])
    const { files } = await c.work()
    if ([...files.keys()].some((p) => p.startsWith(`${path}/`))) return c.fail(`${args[0]}: Is a directory`)
    const data = (await readFile(c, files, path)) ?? new Uint8Array()
    if (isBinary(data)) return c.fail(`${args[0]} 是二進位檔案，這裡的編輯器只能改文字檔`)
    if (data.length > 2 << 20) return c.fail(`${args[0]} 太大了（超過 2 MB），這裡的編輯器打不開`)
    const f = fileToText(data)
    const result = await c.sh.hooks.editText(args[0], f.text)
    if (result === null || (result === f.text && files.has(path))) return c.hint('（沒有修改）')
    await writeFile(c, path, f.save(result))
  },
  async rm(c, args) {
    const recursive = args.some((a) => /^-\w*r/i.test(a))
    const force = args.some((a) => /^-\w*f/.test(a))
    const { index, files } = await c.work()
    for (const a of args.filter((x) => !x.startsWith('-'))) {
      const p = toPath(a)
      const under = [...files.keys()].filter((x) => x.startsWith(`${p}/`))
      if (files.has(p)) files.delete(p)
      else if (under.length && recursive) for (const x of under) files.delete(x)
      else if (under.length) return c.fail(`rm: ${a}: is a directory`)
      else if (!force) return c.fail(`rm: ${a}: No such file or directory`)
    }
    await c.setWork(index, files)
  },
  async mv(c, args) {
    const [from, to] = args.filter((a) => !a.startsWith('-'))
    if (!from || !to) return c.fail('用法：mv <來源> <目的>')
    const { index, files } = await c.work()
    const src = toPath(from)
    let dst = toPath(to)
    if (dirEntries(files, dst).length && !files.has(dst)) dst = `${dst}/${src.split('/').pop()}`
    const moving = [...files].filter(([p]) => p === src || p.startsWith(`${src}/`))
    if (!moving.length) return c.fail(`mv: ${from}: No such file or directory`)
    for (const [p] of moving) files.delete(p)
    for (const [p, e] of moving) files.set(dst + p.slice(src.length), e as Entry)
    await c.setWork(index, files)
  },
}
for (const alias of ['vim', 'vi', 'nano', 'code', 'open', 'notepad']) BUILTINS[alias] = BUILTINS.edit

// ---------- help & completion ----------
function help(c: Ctx) {
  c.out(
    [
      '這是頁面裡的虛擬終端機：指令只改這個頁面記住的狀態，可以復原（⌘Z），按「寫入 .git」或下載 bundle 才會進 repo。',
      '工作區從目前 checkout 的 commit 開始，是虛擬的，不會讀寫你資料夾裡的檔案。',
      '',
      'git 指令：',
      ...GIT_HELP.map(([cmd, what]) => `  ${cmd.padEnd(34)}${what}`),
      '',
      '檔案指令（作用在工作區）：',
      '  ls [路徑]  cat <檔案>  edit <檔案>（或 vim、nano、code）  echo 文字 > 檔案  echo 文字 >> 檔案',
      '  touch <檔案>  rm [-r] <路徑>  mv <來源> <目的>  clear',
      '',
      '可以用 && 、|| 、; 串接，用 GIT_COMMITTER_DATE="…" git commit … 這樣設定環境變數。',
      'Tab 補完指令、分支和檔名，↑／↓ 叫出之前的指令。',
    ].join('\n'),
  )
}

const COMMANDS = ['git', ...Object.keys(BUILTINS)]

// Candidates for the word being typed at the end of `line`.
export async function complete(sh: ShellEnv, line: string): Promise<{ start: number; options: string[] }> {
  const start = line.search(/\S*$/)
  const word = line.slice(start)
  const before = line.slice(0, start).trim().split(/\s+/).filter(Boolean)
  let pool: string[]
  if (!before.length) pool = COMMANDS
  else if (before.length === 1 && before[0] === 'git') pool = Object.keys(GIT)
  else if (word.startsWith('-')) pool = []
  else {
    const refs = [...sh.snap.refs.refs.keys()].filter((r) => /^refs\/(heads|tags|remotes)\//.test(r)).map((r) => r.replace(/^refs\/(heads|tags|remotes)\//, ''))
    const c = new Ctx(sh)
    const { files } = await c.work()
    const dirs = new Set<string>()
    for (const p of files.keys()) {
      const segs = p.split('/')
      for (let i = 1; i < segs.length; i++) dirs.add(`${segs.slice(0, i).join('/')}/`)
    }
    pool = [...new Set([...refs, ...[...files.keys(), ...dirs].map(showPath)])]
  }
  return { start, options: pool.filter((p) => p.startsWith(word)).sort() }
}

