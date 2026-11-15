import { binToText, fromBin, textToBin, toBin } from './bytes'
import { diffHunks, isBinary, splitLines, unifiedDiff } from './diff'
import { shortRef } from './history'
import { commitPayload, formatPerson, type Commit, type Person } from './objects'
import {
  ancestors, findRef, formatDate, GitError, isAncestor, mergeBase, now, parseDate, peel, resolve, resolveCommit, validRefName, walk,
} from './revs'
import { cleanup, matchPaths, parseOpts, short, showPath, subject, toPath, type Ctx, type OptSpec } from './shell'
import { buildTree, diffFiles, diffTrees, flatten, mergeTrees, readTree, TREE, type Change, type Entry, type Files } from './tree'
import { status as workStatus, type RebaseState, type TodoAction, type TodoItem } from './work'

type Handler = (c: Ctx, args: string[]) => Promise<void>

const MAX_LINES = 4000

// ---------- shared bits ----------
async function requireClean(c: Ctx, what: string) {
  const st = await workStatus(c.repo, c.snap)
  if (st.staged.length || st.unstaged.length) {
    c.fail(`error: cannot ${what}: You have uncommitted changes.\nPlease commit them first (or git reset --hard to throw them away).`)
  }
}

function noRebase(c: Ctx) {
  if (c.snap.work.rebase) c.fail('fatal: rebase 進行中：先 git rebase --continue 做完，或 git rebase --abort 回到開始前。')
}

async function commitOf(c: Ctx, hash: string) {
  return c.repo.commit(hash)
}

// "HEAD -> main, tag: v1.0, origin/main" for each commit.
function decorations(c: Ctx): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (h: string, s: string, first = false) => out.set(h, first ? [s, ...(out.get(h) ?? [])] : [...(out.get(h) ?? []), s])
  const head = c.snap.work.head
  for (const [name, hash] of c.snap.refs.refs) {
    if (!/^refs\/(heads|tags|remotes)\//.test(name)) continue
    const label = name.startsWith('refs/tags/') ? `tag: ${shortRef(name)}` : shortRef(name)
    if (name === head.ref) add(hash, `HEAD -> ${label}`, true)
    else add(hash, label)
  }
  if (!head.ref && head.hash) add(head.hash, 'HEAD', true)
  return out
}

// Annotated tags point at tag objects; decorate the commit.
async function peeledDecorations(c: Ctx) {
  const raw = decorations(c)
  const out = new Map<string, string[]>()
  for (const [h, names] of raw) {
    let commit = h
    try {
      commit = (await c.repo.peel(h)).hash
    } catch {
      /* keep */
    }
    out.set(commit, [...(out.get(commit) ?? []), ...names])
  }
  return out
}

// `--format=%h %s` means the same as `--format=tformat:%h %s`.
const normFormat = (fmt: string) => (fmt.includes('%') && !/^t?format:/.test(fmt) ? `tformat:${fmt}` : fmt)

function formatCommit(c: Commit, fmt: string, deco: string[], dateStyle: string): string {
  const d = deco.length ? ` (${deco.join(', ')})` : ''
  if (fmt === 'oneline-short') return `${short(c.hash)}${d} ${subject(c)}`
  if (fmt === 'oneline') return `${c.hash}${d} ${subject(c)}`
  const body = c.message.replace(/\n$/, '').split('\n').map((l) => (l ? `    ${l}` : '')).join('\n')
  const merge = c.parents.length > 1 ? [`Merge: ${c.parents.map(short).join(' ')}`] : []
  const who = (p: Person) => `${p.name} <${p.email}>`
  if (fmt === 'fuller') {
    return [
      `commit ${c.hash}${d}`, ...merge,
      `Author:     ${who(c.author)}`, `AuthorDate: ${formatDate(c.author, dateStyle)}`,
      `Commit:     ${who(c.committer)}`, `CommitDate: ${formatDate(c.committer, dateStyle)}`, '', body,
    ].join('\n')
  }
  if (fmt === 'full') return [`commit ${c.hash}${d}`, ...merge, `Author: ${who(c.author)}`, `Commit: ${who(c.committer)}`, '', body].join('\n')
  if (fmt === 'short') return [`commit ${c.hash}${d}`, ...merge, `Author: ${who(c.author)}`, '', `    ${subject(c)}`].join('\n')
  if (fmt.startsWith('format:') || fmt.startsWith('tformat:')) return placeholders(c, fmt.slice(fmt.indexOf(':') + 1), deco, dateStyle)
  return [`commit ${c.hash}${d}`, ...merge, `Author: ${who(c.author)}`, `Date:   ${formatDate(c.author, dateStyle)}`, '', body].join('\n')
}

function placeholders(c: Commit, f: string, deco: string[], dateStyle: string): string {
  const body = c.message.split('\n').slice(1).join('\n').replace(/^\n+/, '').replace(/\n$/, '')
  const map: Record<string, () => string> = {
    H: () => c.hash, h: () => short(c.hash), T: () => c.tree, t: () => short(c.tree),
    P: () => c.parents.join(' '), p: () => c.parents.map(short).join(' '),
    an: () => c.author.name, ae: () => c.author.email, ad: () => formatDate(c.author, dateStyle),
    at: () => String(c.author.time), ai: () => formatDate(c.author, 'iso'), aI: () => formatDate(c.author, 'iso-strict'),
    cn: () => c.committer.name, ce: () => c.committer.email, cd: () => formatDate(c.committer, dateStyle),
    ct: () => String(c.committer.time), ci: () => formatDate(c.committer, 'iso'), cI: () => formatDate(c.committer, 'iso-strict'),
    s: () => subject(c), b: () => body, B: () => c.message.replace(/\n$/, ''),
    d: () => (deco.length ? ` (${deco.join(', ')})` : ''), D: () => deco.join(', '),
    'G?': () => (c.sig ? 'E' : 'N'), n: () => '\n', '%': () => '%',
  }
  return f.replace(/%(G\?|a[nedtiI]|c[nedtiI]|[HhTtPpsbBdDn%])/g, (_, k: string) => map[k]())
}

// Patch, --stat, --name-only or --name-status output for a list of changes.
async function printChanges(c: Ctx, changes: Change[], mode: 'patch' | 'stat' | 'name-only' | 'name-status') {
  if (mode === 'name-only') return changes.forEach((ch) => c.out(showPath(ch.path)))
  if (mode === 'name-status') return changes.forEach((ch) => c.out(`${ch.a ? (ch.b ? 'M' : 'D') : 'A'}\t${showPath(ch.path)}`))
  const read = async (e: Entry | null) => (e && e.mode !== '160000' ? (await c.repo.read(e.hash)).data : new Uint8Array())
  if (mode === 'stat') {
    let ins = 0
    let del = 0
    const rows: [string, string][] = []
    for (const ch of changes) {
      const [a, b] = await Promise.all([read(ch.a), read(ch.b)])
      if (isBinary(a) || isBinary(b)) {
        rows.push([showPath(ch.path), 'Bin'])
        continue
      }
      let n1 = 0
      let n2 = 0
      for (const h of diffHunks(splitLines(toBin(a)), splitLines(toBin(b)))) {
        n1 += h.aEnd - h.a
        n2 += h.bEnd - h.b
      }
      ins += n2
      del += n1
      rows.push([showPath(ch.path), `${n1 + n2} ${'+'.repeat(Math.min(n2, 40))}${'-'.repeat(Math.min(n1, 40))}`])
    }
    const w = Math.max(0, ...rows.map(([p]) => p.length))
    for (const [p, s] of rows) c.out(` ${p.padEnd(w)} | ${s}`)
    const parts = [`${changes.length} file${changes.length === 1 ? '' : 's'} changed`]
    if (ins) parts.push(`${ins} insertion${ins === 1 ? '' : 's'}(+)`)
    if (del) parts.push(`${del} deletion${del === 1 ? '' : 's'}(-)`)
    c.out(` ${parts.join(', ')}`)
    return
  }
  let lines = 0
  for (const ch of changes) {
    if (lines > MAX_LINES) {
      c.hint(`（差異太長，只顯示前 ${MAX_LINES} 行。可以加 -- <路徑> 只看某些檔案，或用 --stat）`)
      return
    }
    const p = showPath(ch.path)
    const out = [`diff --git a/${p} b/${p}`]
    if (!ch.a) out.push(`new file mode ${ch.b!.mode}`)
    else if (!ch.b) out.push(`deleted file mode ${ch.a.mode}`)
    else if (ch.a.mode !== ch.b.mode) out.push(`old mode ${ch.a.mode}`, `new mode ${ch.b.mode}`)
    const same = ch.a && ch.b && ch.a.mode === ch.b.mode ? ` ${ch.a.mode}` : ''
    const zero = '0000000'
    out.push(`index ${ch.a ? short(ch.a.hash) : zero}..${ch.b ? short(ch.b.hash) : zero}${same}`)
    const [a, b] = await Promise.all([read(ch.a), read(ch.b)])
    if (ch.a?.hash !== ch.b?.hash) {
      if (isBinary(a) || isBinary(b)) out.push(`Binary files ${ch.a ? `a/${p}` : '/dev/null'} and ${ch.b ? `b/${p}` : '/dev/null'} differ`)
      else out.push(`--- ${ch.a ? `a/${p}` : '/dev/null'}`, `+++ ${ch.b ? `b/${p}` : '/dev/null'}`, ...unifiedDiff(splitLines(toBin(a)), splitLines(toBin(b)), binToText))
    }
    lines += out.length
    c.out(out.join('\n'))
  }
}

const diffMode = (o: { has(k: string): boolean }) => (o.has('stat') ? 'stat' : o.has('nameOnly') ? 'name-only' : o.has('nameStatus') ? 'name-status' : 'patch')
const DIFF_OPTS: OptSpec = { stat: [['--stat']], nameOnly: [['--name-only']], nameStatus: [['--name-status']] }

const filterPaths = (changes: Change[], specs: string[] | null) =>
  specs?.length ? changes.filter((ch) => specs.some((s) => matchPaths(s, [ch.path]).length)) : changes

// "a..b" and "^a" in a list of revisions.
async function revRange(c: Ctx, args: string[]) {
  const tips: string[] = []
  const hide: string[] = []
  for (const a of args) {
    if (a.includes('..')) {
      const [x, y] = a.split('..')
      hide.push(await resolveCommit(c.repo, c.snap, x || 'HEAD'))
      tips.push(await resolveCommit(c.repo, c.snap, y || 'HEAD'))
    } else if (a.startsWith('^')) {
      hide.push(await resolveCommit(c.repo, c.snap, a.slice(1)))
    } else {
      tips.push(await resolveCommit(c.repo, c.snap, a))
    }
  }
  return { tips, hide }
}

function describeHead(c: Ctx) {
  const b = c.branch()
  const h = c.head()
  return b ? `On branch ${b}` : `HEAD detached at ${h ? short(h) : '(nothing)'}`
}

// ---------- status ----------
async function status(c: Ctx, args: string[]) {
  const o = parseOpts(args, { short: [['-s', '--short']], branch: [['-b', '--branch']] }, c)
  const st = await workStatus(c.repo, c.snap)
  const code = (ch: Change) => (!ch.a ? 'A' : !ch.b ? 'D' : 'M')
  if (o.has('short')) {
    if (o.has('branch')) c.out(`## ${c.branch() ?? 'HEAD (no branch)'}`)
    const paths = new Map<string, [string, string]>()
    for (const ch of st.staged) paths.set(ch.path, [code(ch), ' '])
    for (const ch of st.unstaged) paths.set(ch.path, [paths.get(ch.path)?.[0] ?? ' ', code(ch)])
    for (const [p, [x, y]] of [...paths].sort()) c.out(`${x}${y} ${showPath(p)}`)
    for (const p of st.untracked) c.out(`?? ${showPath(p)}`)
    return
  }
  const lines = [describeHead(c)]
  const rb = c.snap.work.rebase
  if (rb) {
    lines.push(
      `interactive rebase in progress; onto ${rb.onto ? short(rb.onto) : '(root)'}`,
      `（還有 ${rb.todo.length} 個步驟。改好之後 git rebase --continue，或 git rebase --abort 回到開始前）`,
    )
  }
  if (!c.head()) lines.push('', 'No commits yet')
  const name = (ch: Change) => `\t${(!ch.a ? 'new file:' : !ch.b ? 'deleted:' : 'modified:').padEnd(12)}${showPath(ch.path)}`
  if (st.staged.length) lines.push('', 'Changes to be committed:', ...st.staged.map(name))
  if (st.unstaged.length) lines.push('', 'Changes not staged for commit:', ...st.unstaged.map(name))
  if (st.untracked.length) lines.push('', 'Untracked files:', ...st.untracked.map((p) => `\t${showPath(p)}`))
  if (!st.staged.length && !st.unstaged.length) {
    lines.push('', st.untracked.length ? 'nothing added to commit but untracked files present (use "git add" to track)' : 'nothing to commit, working tree clean')
  } else if (!st.staged.length) {
    lines.push('', 'no changes added to commit (use "git add" and/or "git commit -a")')
  }
  c.out(lines.join('\n'))
}

// ---------- log & show ----------
async function log(c: Ctx, args: string[]) {
  const pre = args.flatMap((a) => (/^-\d+$/.test(a) ? ['-n', a.slice(1)] : [a]))
  const o = parseOpts(
    pre,
    {
      n: [['-n', '--max-count'], true], oneline: [['--oneline']], all: [['--all']], format: [['--format', '--pretty'], true],
      date: [['--date'], true], graph: [['--graph']], decorate: [['--decorate']], reverse: [['--reverse']],
    },
    c,
  )
  if (o.has('graph')) c.hint('（這裡的 log 不畫圖：樹狀圖在上面的「提交歷史」）')
  let { tips, hide } = await revRange(c, o.rest)
  if (o.has('all')) {
    for (const [name, h] of c.snap.refs.refs) if (/^refs\/(heads|tags|remotes)\//.test(name)) tips.push((await c.repo.peel(h)).hash)
    if (c.head()) tips.push(c.head()!)
  }
  if (!tips.length) {
    if (!c.head()) c.fail(`fatal: your current branch '${c.branch() ?? 'HEAD'}' does not have any commits yet`)
    tips = [c.head()!]
  }
  const asked = o.get('n')
  const limit = asked ? Number(asked) : 30
  if (!Number.isFinite(limit)) c.fail(`fatal: '${asked}': not an integer`)
  const commits = await walk(c.repo, tips, hide, limit + 1)
  const more = commits.length > limit
  const shown = commits.slice(0, limit)
  if (o.has('reverse')) shown.reverse()
  const deco = await peeledDecorations(c)
  const fmt = o.has('oneline') ? 'oneline-short' : normFormat(o.get('format') ?? 'medium')
  const multiline = !/^(oneline|format:|tformat:)/.test(fmt)
  c.out(shown.map((x) => formatCommit(x, fmt, deco.get(x.hash) ?? [], o.get('date') ?? 'default')).join(multiline ? '\n\n' : '\n'))
  if (more && !asked) c.hint(`（只列出前 ${limit} 個，用 -n <數量> 看更多）`)
}

async function show(c: Ctx, args: string[]) {
  const o = parseOpts(
    args,
    {
      ...DIFF_OPTS, noPatch: [['-s', '--no-patch']], format: [['--format', '--pretty'], true], oneline: [['--oneline']], date: [['--date'], true],
    },
    c,
  )
  const deco = await peeledDecorations(c)
  for (const spec of o.rest.length ? o.rest : ['HEAD']) {
    const hash = await resolve(c.repo, c.snap, spec)
    const type = await c.repo.typeOf(hash)
    if (type === 'blob') {
      const data = (await c.repo.read(hash)).data
      if (isBinary(data)) c.hint(`（二進位檔案，${data.length.toLocaleString()} bytes）`)
      else c.out(binToText(toBin(data)).replace(/\n$/, ''))
      continue
    }
    if (type === 'tree') {
      c.out(`tree ${spec}\n\n${(await readTree(c.repo, hash)).map((e) => e.name + (e.mode === TREE ? '/' : '')).join('\n')}`)
      continue
    }
    let commitHash = hash
    if (type === 'tag') {
      const t = await c.repo.tag(hash)
      c.out([`tag ${t.name}`, ...(t.tagger ? [`Tagger: ${t.tagger.name} <${t.tagger.email}>`, `Date:   ${formatDate(t.tagger)}`] : []), '', t.message.replace(/\n$/, ''), ''].join('\n'))
      commitHash = (await c.repo.peel(hash)).hash
      if ((await c.repo.typeOf(commitHash)) !== 'commit') continue
    }
    const cm = await commitOf(c, commitHash)
    const fmt = o.has('oneline') ? 'oneline-short' : normFormat(o.get('format') ?? 'medium')
    c.out(formatCommit(cm, fmt, deco.get(cm.hash) ?? [], o.get('date') ?? 'default'))
    if (o.has('noPatch')) continue
    if (cm.parents.length > 1) {
      c.hint('（merge commit 的差異這裡不顯示；可以用 git diff <parent> <commit> 比較）')
      continue
    }
    const base = cm.parents[0] ? (await commitOf(c, cm.parents[0])).tree : null
    const changes = await diffTrees(c.repo, base, cm.tree)
    if (changes.length) {
      c.out('')
      await printChanges(c, filterPaths(changes, o.paths), diffMode(o))
    }
  }
}

async function diff(c: Ctx, args: string[]) {
  const o = parseOpts(args, { ...DIFF_OPTS, staged: [['--staged', '--cached']] }, c)
  const { index, files } = await c.work()
  let a: Files
  let b: Files
  const revs = o.rest
  if (o.has('staged')) {
    a = await flatten(c.repo, revs[0] ? await peel(c.repo, await resolve(c.repo, c.snap, revs[0]), 'tree') : await c.headTree())
    b = index
  } else if (revs.length === 2 || revs[0]?.includes('..')) {
    const [x, y] = revs.length === 2 ? revs : revs[0].split('..')
    const tx = await peel(c.repo, await resolve(c.repo, c.snap, x || 'HEAD'), 'tree')
    const ty = await peel(c.repo, await resolve(c.repo, c.snap, y || 'HEAD'), 'tree')
    return printChanges(c, filterPaths(await diffTrees(c.repo, tx, ty), o.paths), diffMode(o))
  } else if (revs.length === 1) {
    a = await flatten(c.repo, await peel(c.repo, await resolve(c.repo, c.snap, revs[0]), 'tree'))
    b = files
  } else {
    a = index
    b = files
  }
  // Untracked files aren't part of a diff.
  const changes = diffFiles(a, b).filter((ch) => o.has('staged') || index.has(ch.path) || (ch.a && !ch.b))
  await printChanges(c, filterPaths(changes, o.paths), diffMode(o))
}

// ---------- the index ----------
async function add(c: Ctx, args: string[]) {
  const o = parseOpts(args, { all: [['-A', '--all']], update: [['-u', '--update']], force: [['-f', '--force']], verbose: [['-v', '--verbose']] }, c)
  const specs = [...o.rest, ...(o.paths ?? [])]
  if (!specs.length && (o.has('all') || o.has('update'))) specs.push('.')
  if (!specs.length) c.fail("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?")
  const { index, files } = await c.work()
  const pool = o.has('update') ? [...index.keys()] : [...new Set([...index.keys(), ...files.keys()])]
  for (const spec of specs) {
    const matched = matchPaths(spec, pool)
    if (!matched.length) c.fail(`fatal: pathspec '${spec}' did not match any files`)
    for (const p of matched) {
      const f = files.get(p)
      if (f) index.set(p, f)
      else index.delete(p)
      if (o.has('verbose')) c.out(`add '${showPath(p)}'`)
    }
  }
  await c.setWork(index, files)
}

async function rm(c: Ctx, args: string[]) {
  const o = parseOpts(args, { cached: [['--cached']], r: [['-r']], force: [['-f', '--force']], quiet: [['-q', '--quiet']] }, c)
  const specs = [...o.rest, ...(o.paths ?? [])]
  if (!specs.length) c.fail('usage: git rm [--cached] [-r] <file>...')
  const { index, files } = await c.work()
  for (const spec of specs) {
    const matched = matchPaths(spec, index.keys())
    if (!matched.length) c.fail(`fatal: pathspec '${spec}' did not match any files`)
    if (!o.has('r') && !index.has(toPath(spec)) && !/[*?]/.test(spec)) c.fail(`fatal: not removing '${spec}' recursively without -r`)
    for (const p of matched) {
      index.delete(p)
      if (!o.has('cached')) files.delete(p)
      if (!o.has('quiet')) c.out(`rm '${showPath(p)}'`)
    }
  }
  await c.setWork(index, files)
}

async function mv(c: Ctx, args: string[]) {
  const o = parseOpts(args, { force: [['-f', '--force']] }, c)
  const [from, to] = o.rest
  if (!from || !to || o.rest.length > 2) c.fail('usage: git mv <source> <destination>')
  const { index, files } = await c.work()
  const src = toPath(from)
  let dst = toPath(to)
  const moving = [...index.keys()].filter((p) => p === src || p.startsWith(`${src}/`))
  if (!moving.length) c.fail(`fatal: not under version control, source=${from}, destination=${to}`)
  if ([...index.keys()].some((p) => p.startsWith(`${dst}/`))) dst = `${dst}/${src.split('/').pop()}`
  for (const p of moving) {
    const np = dst + p.slice(src.length)
    if ((index.has(np) || files.has(np)) && !o.has('force')) c.fail(`fatal: destination exists, source=${from}, destination=${showPath(np)}`)
    index.set(np, index.get(p)!)
    index.delete(p)
    const f = files.get(p)
    files.delete(p)
    if (f) files.set(np, f)
  }
  await c.setWork(index, files)
}

async function restore(c: Ctx, args: string[]) {
  const o = parseOpts(args, { staged: [['-S', '--staged']], worktree: [['-W', '--worktree']], source: [['-s', '--source'], true] }, c)
  const specs = [...o.rest, ...(o.paths ?? [])]
  if (!specs.length) c.fail('fatal: you must specify path(s) to restore')
  const staged = o.has('staged')
  const worktree = o.has('worktree') || !staged
  await restorePaths(c, specs, o.get('source') ?? (staged ? 'HEAD' : null), staged, worktree)
}

// Paths from a commit (or, with no source, from the index) into the index and/or working tree.
async function restorePaths(c: Ctx, specs: string[], source: string | null, toIndex: boolean, toFiles: boolean) {
  const { index, files } = await c.work()
  const from = source ? await flatten(c.repo, await peel(c.repo, await resolve(c.repo, c.snap, source), 'tree')) : index
  const pool = new Set([...from.keys(), ...index.keys(), ...(toFiles ? files.keys() : [])])
  for (const spec of specs) {
    const matched = matchPaths(spec, pool)
    if (!matched.length) c.fail(`error: pathspec '${spec}' did not match any file(s) known to git`)
    for (const p of matched) {
      const e = from.get(p)
      // Untracked files are left alone by a restore from the index.
      if (!source && !index.has(p)) continue
      for (const [want, map] of [[toIndex, index], [toFiles, files]] as const) {
        if (!want) continue
        if (e) map.set(p, e)
        else map.delete(p)
      }
    }
  }
  await c.setWork(index, files)
}

// ---------- moving around ----------
async function switchTo(c: Ctx, target: { ref: string | null; hash: string | null }, force: boolean) {
  noRebase(c)
  const st = await workStatus(c.repo, c.snap)
  if (!force && (st.staged.length || st.unstaged.length)) {
    c.fail('error: Your local changes would be overwritten by checkout.\nPlease commit your changes or stash them before you switch branches.\n（或加 -f 丟掉這些修改）\nAborting')
  }
  const untracked = force ? [] : st.untracked
  const keep = untracked.length ? (await c.work()).files : null
  c.patchWork({ head: target, index: null, files: null })
  if (keep) {
    const { index, files } = await c.work()
    for (const p of untracked) {
      if (files.has(p)) {
        c.fail(`error: The following untracked working tree files would be overwritten by checkout:\n\t${showPath(p)}\nPlease move or remove them before you switch branches.\nAborting`)
      }
      files.set(p, keep.get(p)!)
    }
    await c.setWork(index, files)
  }
}

async function headLine(c: Ctx, hash: string) {
  return `HEAD is now at ${short(hash)} ${subject(await commitOf(c, hash))}`
}

// A local branch to switch to, or (git's "DWIM") a new one for a remote branch of that name.
async function branchTarget(c: Ctx, name: string): Promise<string | null> {
  if (c.snap.refs.refs.has(`refs/heads/${name}`)) return `refs/heads/${name}`
  const remotes = [...c.snap.refs.refs.keys()].filter((r) => r.startsWith('refs/remotes/') && r.split('/').slice(3).join('/') === name)
  if (remotes.length !== 1) return null
  const ref = `refs/heads/${name}`
  c.setRef(ref, c.snap.refs.refs.get(remotes[0])!)
  c.out(`branch '${name}' set up to track '${shortRef(remotes[0])}'.`)
  return ref
}

async function checkout(c: Ctx, args: string[]) {
  const o = parseOpts(args, { b: [['-b'], true], B: [['-B'], true], force: [['-f', '--force']], detach: [['--detach']], quiet: [['-q', '--quiet']] }, c)
  const force = o.has('force')
  if (o.paths) return restorePaths(c, o.paths, o.rest[0] ?? null, !!o.rest[0], true)
  const newBranch = o.get('b') ?? o.get('B')
  if (newBranch) return createAndSwitch(c, newBranch, o.rest[0], o.has('B'), force)
  const [what, ...more] = o.rest
  if (!what) c.fail('fatal: 要切換到哪裡？例如 git checkout main')
  if (more.length) return restorePaths(c, more, what, true, true)
  if (!o.has('detach')) {
    const ref = await branchTarget(c, what)
    if (ref) {
      if (ref === c.snap.work.head.ref) return c.out(`Already on '${what}'`)
      await switchTo(c, { ref, hash: c.snap.refs.refs.get(ref)! }, force)
      return c.out(`Switched to branch '${what}'`)
    }
  }
  let hash: string
  try {
    hash = await resolveCommit(c.repo, c.snap, what)
  } catch (e) {
    // Not a revision: maybe a path.
    const { index } = await c.work()
    if (e instanceof GitError && matchPaths(what, index.keys()).length) return restorePaths(c, [what], null, false, true)
    throw new GitError(`error: pathspec '${what}' did not match any file(s) known to git`)
  }
  await switchTo(c, { ref: null, hash }, force)
  if (!o.has('quiet')) {
    c.out(`Note: switching to '${what}'.\n\nYou are in 'detached HEAD' state. 想留下在這裡做的 commit，就建一個分支：git switch -c <新分支>\n\n${await headLine(c, hash)}`)
  }
}

async function createAndSwitch(c: Ctx, name: string, start: string | undefined, reset: boolean, force: boolean) {
  if (!validRefName(name)) c.fail(`fatal: '${name}' is not a valid branch name`)
  const ref = `refs/heads/${name}`
  if (c.snap.refs.refs.has(ref) && !reset) c.fail(`fatal: a branch named '${name}' already exists`)
  const hash = start ? await resolveCommit(c.repo, c.snap, start) : c.head()
  noRebase(c)
  if (!hash) {
    // No commits yet: just name the branch that the first commit will create.
    c.patchWork({ head: { ref, hash: null } })
    return c.out(`Switched to a new branch '${name}'`)
  }
  if (start && hash !== c.head()) await switchTo(c, { ref: null, hash }, force)
  c.setRef(ref, hash)
  c.patchWork({ head: { ref, hash } })
  c.out(`Switched to a new branch '${name}'`)
}

async function switchCmd(c: Ctx, args: string[]) {
  const o = parseOpts(
    args,
    { create: [['-c', '--create'], true], force: [['-C', '--force-create'], true], detach: [['-d', '--detach']], discard: [['-f', '--discard-changes', '--force']] },
    c,
  )
  const name = o.get('create') ?? o.get('force')
  if (name) return createAndSwitch(c, name, o.rest[0], o.has('force'), o.has('discard'))
  const [what] = o.rest
  if (!what) c.fail('fatal: missing branch or commit argument')
  if (o.has('detach')) {
    const hash = await resolveCommit(c.repo, c.snap, what)
    await switchTo(c, { ref: null, hash }, o.has('discard'))
    return c.out(await headLine(c, hash))
  }
  const ref = await branchTarget(c, what)
  if (!ref) {
    let kind = 'commit'
    try {
      await resolveCommit(c.repo, c.snap, what)
      if (findRef(c.repo, c.snap, what)?.startsWith('refs/tags/')) kind = 'tag'
    } catch {
      c.fail(`fatal: invalid reference: ${what}`)
    }
    c.fail(`fatal: a branch is expected, got ${kind} '${what}'\nhint: 要看不在分支上的 commit，用 git switch --detach ${what}`)
  }
  if (ref === c.snap.work.head.ref) return c.out(`Already on '${what}'`)
  await switchTo(c, { ref, hash: c.snap.refs.refs.get(ref)! }, o.has('discard'))
  c.out(`Switched to branch '${what}'`)
}

// ---------- branches & tags ----------
function protectRepoHead(c: Ctx, ref: string, what: string) {
  if (c.snap.refs.head.ref === ref) c.fail(`error: '${shortRef(ref)}' 是 repo 目前 checkout 的分支（磁碟上的 HEAD），這裡不能${what}。請在電腦的終端機做。`)
}

async function branch(c: Ctx, args: string[]) {
  const o = parseOpts(
    args,
    {
      del: [['-d', '--delete']], D: [['-D']], move: [['-m', '--move']], M: [['-M']], force: [['-f', '--force']], all: [['-a', '--all']],
      remotes: [['-r', '--remotes']], verbose: [['-v', '-vv', '--verbose']], current: [['--show-current']], list: [['-l', '--list']],
    },
    c,
  )
  const refs = c.snap.refs.refs
  if (o.has('current')) return c.out(c.branch() ?? '')
  if (o.has('del') || o.has('D')) {
    if (!o.rest.length) c.fail('fatal: branch name required')
    for (const name of o.rest) {
      const ref = `refs/heads/${name}`
      const hash = refs.get(ref)
      if (!hash) c.fail(`error: branch '${name}' not found`)
      if (ref === c.snap.work.head.ref) c.fail(`error: cannot delete branch '${name}' used by worktree at '/'`)
      protectRepoHead(c, ref, '刪除')
      const h = c.head()
      if (!o.has('D') && !o.has('force') && (!h || !(await isAncestor(c.repo, hash, h)))) {
        c.fail(`error: the branch '${name}' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D ${name}'`)
      }
      c.setRef(ref, null)
      c.out(`Deleted branch ${name} (was ${short(hash)}).`)
    }
    return
  }
  if (o.has('move') || o.has('M')) {
    const [a, b] = o.rest
    const [from, to] = b ? [a, b] : [c.branch(), a]
    if (!from || !to) c.fail('fatal: branch name required')
    const src = `refs/heads/${from}`
    const dst = `refs/heads/${to}`
    if (!refs.has(src)) c.fail(`error: refname refs/heads/${from} not found`)
    if (!validRefName(to)) c.fail(`fatal: '${to}' is not a valid branch name`)
    if (refs.has(dst) && !o.has('M')) c.fail(`fatal: a branch named '${to}' already exists`)
    protectRepoHead(c, src, '改名')
    const hash = refs.get(src)!
    c.setRef(src, null)
    c.setRef(dst, hash)
    if (c.snap.work.head.ref === src) c.patchWork({ head: { ref: dst, hash } })
    return
  }
  if (o.rest.length && !o.has('list')) {
    const [name, start] = o.rest
    if (!validRefName(name)) c.fail(`fatal: '${name}' is not a valid branch name`)
    const ref = `refs/heads/${name}`
    if (refs.has(ref) && !o.has('force')) c.fail(`fatal: a branch named '${name}' already exists`)
    if (ref === c.snap.work.head.ref) c.fail(`fatal: cannot force update the branch '${name}' used by worktree at '/'`)
    const hash = start ? await resolveCommit(c.repo, c.snap, start) : c.head()
    if (!hash) c.fail(`fatal: not a valid object name: '${c.branch() ?? 'HEAD'}'`)
    c.setRef(ref, hash)
    return
  }
  const prefixes = o.has('all') ? ['refs/heads/', 'refs/remotes/'] : o.has('remotes') ? ['refs/remotes/'] : ['refs/heads/']
  const names = [...refs.keys()].filter((r) => prefixes.some((p) => r.startsWith(p))).sort()
  const lines: string[] = []
  if (!c.snap.work.head.ref && c.head()) lines.push(`* (HEAD detached at ${short(c.head()!)})`)
  for (const r of names) {
    const mark = r === c.snap.work.head.ref ? '* ' : '  '
    const label = o.has('all') && r.startsWith('refs/remotes/') ? r.slice(5) : shortRef(r)
    if (!o.has('verbose')) {
      lines.push(mark + label)
      continue
    }
    const cm = await commitOf(c, (await c.repo.peel(refs.get(r)!)).hash)
    lines.push(`${mark}${label} ${short(cm.hash)} ${subject(cm)}`)
  }
  if (lines.length) c.out(lines.join('\n'))
}

async function tag(c: Ctx, args: string[]) {
  const o = parseOpts(
    args,
    {
      annotate: [['-a', '--annotate']], sign: [['-s', '--sign']], msg: [['-m', '--message'], true], del: [['-d', '--delete']],
      force: [['-f', '--force']], list: [['-l', '--list']], noSign: [['--no-sign']],
    },
    c,
  )
  const refs = c.snap.refs.refs
  if (o.has('del')) {
    for (const name of o.rest) {
      const hash = refs.get(`refs/tags/${name}`)
      if (!hash) c.fail(`error: tag '${name}' not found.`)
      c.setRef(`refs/tags/${name}`, null)
      c.out(`Deleted tag '${name}' (was ${short(hash)})`)
    }
    return
  }
  if (!o.rest.length || o.has('list')) {
    const pattern = o.rest[0] ? new RegExp(`^${o.rest[0].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`) : null
    const names = [...refs.keys()].filter((r) => r.startsWith('refs/tags/')).map((r) => r.slice(10)).filter((n) => !pattern || pattern.test(n)).sort()
    if (names.length) c.out(names.join('\n'))
    return
  }
  const [name, target] = o.rest
  if (!validRefName(name)) c.fail(`fatal: '${name}' is not a valid tag name.`)
  const ref = `refs/tags/${name}`
  if (refs.has(ref) && !o.has('force')) c.fail(`fatal: tag '${name}' already exists`)
  const object = await resolve(c.repo, c.snap, target ?? 'HEAD')
  const sign = o.has('sign') || (!o.has('noSign') && c.config('tag.gpgsign') === 'true')
  if (sign && !c.sh.signer) c.fail('error: 要簽名，請先按終端機上方的「私鑰」載入私鑰')
  if (!o.has('annotate') && !sign && !o.has('msg')) return c.setRef(ref, object)
  let message = o.all('msg').join('\n\n')
  if (!o.has('msg')) {
    const edited = await c.sh.hooks.editText(`標籤 ${name} 的說明`, `\n#\n# 寫下標籤 ${name} 的說明。以 # 開頭的行會被忽略。\n`)
    message = edited ?? ''
  }
  message = cleanup(message, !o.has('msg'))
  if (!message) c.fail('fatal: no tag message?')
  const type = await c.repo.typeOf(object)
  let payload = textToBin(`object ${object}\ntype ${type}\ntag ${name}\ntagger ${formatPerson(c.ident('committer'))}\n\n${message}`)
  if (sign) payload = await c.sign(payload, true)
  c.setRef(ref, await c.repo.add('tag', fromBin(payload)))
}

// ---------- reset ----------
async function reset(c: Ctx, args: string[]) {
  const o = parseOpts(args, { soft: [['--soft']], mixed: [['--mixed']], hard: [['--hard']], quiet: [['-q', '--quiet']] }, c)
  let paths = o.paths
  let rev = o.rest[0]
  if (!paths && rev) {
    try {
      await resolveCommit(c.repo, c.snap, rev)
    } catch (e) {
      if (!(e instanceof GitError)) throw e
      paths = o.rest
      rev = 'HEAD'
    }
  }
  if (paths) {
    if (o.has('soft') || o.has('hard')) c.fail(`fatal: Cannot do ${o.has('soft') ? 'soft' : 'hard'} reset with paths.`)
    return restorePaths(c, paths, rev ?? 'HEAD', true, false)
  }
  const target = await resolveCommit(c.repo, c.snap, rev ?? 'HEAD')
  const { index, files } = await c.work()
  c.moveHead(target)
  if (o.has('soft')) return c.setWork(index, files)
  const fresh = await flatten(c.repo, (await commitOf(c, target)).tree)
  if (o.has('hard')) {
    // Untracked files survive, as in git.
    const keep = new Map(fresh)
    for (const [p, e] of files) if (!index.has(p) && !fresh.has(p)) keep.set(p, e)
    await c.setWork(fresh, keep)
    if (!o.has('quiet')) c.out(await headLine(c, target))
    return
  }
  await c.setWork(fresh, files)
  const unstaged = diffFiles(fresh, files).filter((ch) => ch.a)
  if (unstaged.length && !o.has('quiet')) c.out(['Unstaged changes after reset:', ...unstaged.map((ch) => `${ch.b ? 'M' : 'D'}\t${showPath(ch.path)}`)].join('\n'))
}

// ---------- commit ----------
async function commit(c: Ctx, args: string[]) {
  const o = parseOpts(
    args,
    {
      msg: [['-m', '--message'], true], all: [['-a', '--all']], amend: [['--amend']], noEdit: [['--no-edit']], allowEmpty: [['--allow-empty']],
      allowEmptyMsg: [['--allow-empty-message']], author: [['--author'], true], date: [['--date'], true], S: [['-S', '--gpg-sign']],
      noS: [['--no-gpg-sign']], resetAuthor: [['--reset-author']], quiet: [['-q', '--quiet']], verbose: [['-v', '--verbose']],
    },
    c,
  )
  if (o.rest.length || o.paths) c.fail('error: 這裡的 git commit 不接受路徑：先用 git add 加進暫存區，再 git commit')
  const amend = o.has('amend')
  const old = amend ? c.head() : null
  if (amend && !old) c.fail('fatal: You have nothing to amend.')
  const prev = old ? await commitOf(c, old) : null

  let { index, files } = await c.work()
  if (o.has('all')) {
    for (const p of [...index.keys()]) {
      const f = files.get(p)
      if (f) index.set(p, f)
      else index.delete(p)
    }
    await c.setWork(index, files)
    ;({ index, files } = await c.work())
  }
  const tree = await buildTree(c.repo, index)
  const parentTree = prev ? (prev.parents[0] ? (await commitOf(c, prev.parents[0])).tree : null) : await c.headTree()
  const emptyTree = await buildTree(c.repo, new Map())
  if (!amend && !o.has('allowEmpty') && tree === (parentTree ?? emptyTree)) {
    const st = await workStatus(c.repo, c.snap)
    c.fail(st.unstaged.length || st.untracked.length ? 'no changes added to commit (use "git add" and/or "git commit -a")' : 'nothing to commit, working tree clean')
  }

  // The message: -m, kept (--amend --no-edit), or from the editor.
  let message: string
  if (o.has('msg')) {
    message = cleanup(o.all('msg').join('\n\n'), false)
  } else if (amend && o.has('noEdit')) {
    message = prev!.message
  } else {
    const st = await workStatus(c.repo, c.snap)
    const listed = st.staged.map((ch) => `#\t${(!ch.a ? 'new file:' : !ch.b ? 'deleted:' : 'modified:').padEnd(12)}${showPath(ch.path)}`)
    const template = `${prev ? prev.message : ''}\n# 請寫 commit 訊息。以 # 開頭的行會被忽略，留空就不 commit。\n#\n# ${describeHead(c)}\n${listed.length ? `# Changes to be committed:\n${listed.join('\n')}\n` : ''}`
    const edited = await c.sh.hooks.editText(amend ? '修改 commit 訊息' : 'Commit 訊息', template)
    message = cleanup(edited ?? '', true)
  }
  if (!message && !o.has('allowEmptyMsg')) c.fail('Aborting commit due to empty commit message.')

  let author: Person
  const authorArg = o.get('author')
  if (authorArg) {
    const m = authorArg.match(/^(.*?)\s*<(.*)>$/)
    if (!m) c.fail(`fatal: --author '${authorArg}' is not 'Name <email>'`)
    author = { ...c.ident('author'), name: m[1], email: m[2] }
  } else if (prev && !o.has('resetAuthor')) {
    // Like git: amending keeps the original author (and date) unless told otherwise.
    author = prev.author
  } else {
    author = c.ident('author')
  }
  const dateArg = o.get('date')
  if (dateArg) {
    const d = parseDate(dateArg)
    if (!d) c.fail(`fatal: invalid date format: ${dateArg}`)
    author = { ...author, ...d }
  }
  const sign = c.wantSign(o.has('S'), o.has('noS'))
  const hash = await c.newCommit({
    tree, parents: prev ? prev.parents : c.head() ? [c.head()!] : [], author, committer: c.ident('committer'), message, sign,
  })
  if (old) {
    c.created.pop()
    c.rewritten.push([hash, old])
  }
  c.moveHead(hash)
  await c.setWork(index, files)
  if (!o.has('quiet')) {
    const where = c.branch() ?? 'detached HEAD'
    const root = !(prev ? prev.parents.length : (await commitOf(c, hash)).parents.length) ? ' (root-commit)' : ''
    const changed = await diffTrees(c.repo, parentTree, tree)
    c.out(`[${where}${root} ${short(hash)}] ${message.split('\n', 1)[0]}\n ${changed.length} file${changed.length === 1 ? '' : 's'} changed`)
  }
  if (old) await descendantHint(c, old)
}

// After amending (or rewriting) a commit that has descendants on other branches: those still sit
// on the old commit.
async function descendantHint(c: Ctx, old: string) {
  const stuck: string[] = []
  for (const [name, hash] of c.snap.refs.refs) {
    if (!name.startsWith('refs/heads/') || name === c.snap.work.head.ref || hash === old) continue
    if (await isAncestor(c.repo, old, hash)) stuck.push(name.slice(11))
  }
  for (const b of stuck) {
    c.hint(`提示：分支 ${b} 還接在原本的 ${short(old)} 後面。要把後面的 commit 接到新的 commit 上：git rebase --onto ${short(c.head()!)} ${short(old)} ${b}`)
  }
}

// ---------- cherry-pick, revert, merge ----------
async function conflictFail(c: Ctx, what: string, cm: Commit | null, conflicts: string[]): Promise<never> {
  c.fail(
    [
      ...(cm ? [`error: could not ${what} ${short(cm.hash)}... ${subject(cm)}`] : []),
      ...conflicts.map((p) => `CONFLICT (content): Merge conflict in ${showPath(p)}`),
      `兩邊改到同一段，這個頁面沒辦法手動解決衝突，所以 ${what === 'apply' ? '整個指令' : what} 已經取消，什麼都沒改。`,
    ].join('\n'),
  )
}

async function cherryPick(c: Ctx, args: string[]) {
  const o = parseOpts(args, { x: [['-x']], mainline: [['-m', '--mainline'], true], S: [['-S', '--gpg-sign']], noS: [['--no-gpg-sign']] }, c)
  noRebase(c)
  await requireClean(c, 'cherry-pick')
  if (!o.rest.length) c.fail('usage: git cherry-pick <commit>...')
  const picks: Commit[] = []
  for (const a of o.rest) {
    if (a.includes('..')) {
      const { tips, hide } = await revRange(c, [a])
      picks.push(...(await walk(c.repo, tips, hide)).reverse())
    } else {
      picks.push(await commitOf(c, await resolveCommit(c.repo, c.snap, a)))
    }
  }
  const sign = c.wantSign(o.has('S'), o.has('noS'))
  for (const cm of picks) {
    const m = Number(o.get('mainline') ?? 0)
    if (cm.parents.length > 1 && !m) c.fail(`error: commit ${cm.hash} is a merge but no -m option was given.`)
    const parent = cm.parents[m ? m - 1 : 0]
    const base = parent ? (await commitOf(c, parent)).tree : null
    const ours = await c.headTree()
    const merged = await mergeTrees(c.repo, base, ours, cm.tree)
    if (merged.conflicts.length) await conflictFail(c, 'apply', cm, merged.conflicts)
    if (merged.tree === (ours ?? (await buildTree(c.repo, new Map()))) && cm.tree !== base) {
      c.hint(`（${short(cm.hash)} ${subject(cm)} 的修改這裡已經有了，跳過）`)
      continue
    }
    const message = o.has('x') ? `${cm.message.replace(/\n?$/, '\n')}\n(cherry picked from commit ${cm.hash})\n` : cm.message
    const hash = await c.newCommit({ tree: merged.tree, parents: c.head() ? [c.head()!] : [], author: cm.author, committer: c.ident('committer'), message, sign })
    c.moveHead(hash)
    c.out(`[${c.branch() ?? 'detached HEAD'} ${short(hash)}] ${subject(cm)}`)
  }
}

async function revert(c: Ctx, args: string[]) {
  const o = parseOpts(args, { noEdit: [['--no-edit']], edit: [['-e', '--edit']], S: [['-S', '--gpg-sign']], noS: [['--no-gpg-sign']] }, c)
  noRebase(c)
  await requireClean(c, 'revert')
  if (!o.rest.length) c.fail('usage: git revert <commit>...')
  const sign = c.wantSign(o.has('S'), o.has('noS'))
  for (const a of o.rest) {
    const cm = await commitOf(c, await resolveCommit(c.repo, c.snap, a))
    if (cm.parents.length > 1) c.fail(`error: commit ${cm.hash} is a merge; 這裡不支援 revert merge commit。`)
    const parentTree = cm.parents[0] ? (await commitOf(c, cm.parents[0])).tree : null
    const merged = await mergeTrees(c.repo, cm.tree, await c.headTree(), parentTree)
    if (merged.conflicts.length) await conflictFail(c, 'revert', cm, merged.conflicts)
    let message = `Revert "${subject(cm)}"\n\nThis reverts commit ${cm.hash}.\n`
    if (o.has('edit')) message = cleanup((await c.sh.hooks.editText('Revert 的訊息', message)) ?? '', true)
    if (!message) c.fail('Aborting commit due to empty commit message.')
    const hash = await c.newCommit({ tree: merged.tree, parents: c.head() ? [c.head()!] : [], author: c.ident('author'), committer: c.ident('committer'), message, sign })
    c.moveHead(hash)
    c.out(`[${c.branch() ?? 'detached HEAD'} ${short(hash)}] ${message.split('\n', 1)[0]}`)
  }
}

async function merge(c: Ctx, args: string[]) {
  const o = parseOpts(
    args,
    {
      noFf: [['--no-ff']], ffOnly: [['--ff-only']], ff: [['--ff']], msg: [['-m', '--message'], true], noEdit: [['--no-edit']],
      S: [['-S', '--gpg-sign']], noS: [['--no-gpg-sign']], abort: [['--abort']],
    },
    c,
  )
  if (o.has('abort')) c.fail('fatal: There is no merge to abort (這裡的 merge 遇到衝突會直接取消).')
  noRebase(c)
  if (o.rest.length !== 1) c.fail('usage: git merge <branch>（這裡一次合併一個）')
  await requireClean(c, 'merge')
  const spec = o.rest[0]
  const theirs = await resolveCommit(c.repo, c.snap, spec)
  const ours = c.head()
  if (!ours) {
    c.moveHead(theirs)
    return c.out(`Fast-forward to ${short(theirs)}`)
  }
  if (await isAncestor(c.repo, theirs, ours)) return c.out('Already up to date.')
  if (!o.has('noFf') && (await isAncestor(c.repo, ours, theirs))) {
    const changed = await diffTrees(c.repo, (await commitOf(c, ours)).tree, (await commitOf(c, theirs)).tree)
    c.moveHead(theirs)
    return c.out(`Updating ${short(ours)}..${short(theirs)}\nFast-forward\n ${changed.length} file${changed.length === 1 ? '' : 's'} changed`)
  }
  if (o.has('ffOnly')) c.fail('fatal: Not possible to fast-forward, aborting.')
  const base = await mergeBase(c.repo, ours, theirs)
  const [oc, tc] = await Promise.all([commitOf(c, ours), commitOf(c, theirs)])
  const merged = await mergeTrees(c.repo, base ? (await commitOf(c, base)).tree : null, oc.tree, tc.tree)
  if (merged.conflicts.length) await conflictFail(c, 'merge', null, merged.conflicts)
  const ref = findRef(c.repo, c.snap, spec)
  const what = ref?.startsWith('refs/heads/') ? `branch '${shortRef(ref)}'` : ref?.startsWith('refs/remotes/') ? `remote-tracking branch '${shortRef(ref)}'` : ref?.startsWith('refs/tags/') ? `tag '${shortRef(ref)}'` : `commit '${spec}'`
  const message = o.has('msg') ? cleanup(o.all('msg').join('\n\n'), false) : `Merge ${what}\n`
  const hash = await c.newCommit({
    tree: merged.tree, parents: [ours, theirs], author: c.ident('author'), committer: c.ident('committer'), message, sign: c.wantSign(o.has('S'), o.has('noS')),
  })
  c.moveHead(hash)
  c.out("Merge made by the 'ort' strategy.")
}

// ---------- rebase ----------
const ACTIONS: Record<string, TodoAction> = {
  p: 'pick', pick: 'pick', r: 'reword', reword: 'reword', e: 'edit', edit: 'edit', s: 'squash', squash: 'squash',
  f: 'fixup', fixup: 'fixup', d: 'drop', drop: 'drop', b: 'break', break: 'break',
}

async function rebase(c: Ctx, args: string[]) {
  const o = parseOpts(
    args,
    {
      i: [['-i', '--interactive']], onto: [['--onto'], true], root: [['--root']], cont: [['--continue']], abort: [['--abort']], skip: [['--skip']],
      cdia: [['--committer-date-is-author-date']], ignoreDate: [['--ignore-date', '--reset-author-date']], S: [['-S', '--gpg-sign']],
      noS: [['--no-gpg-sign']], force: [['-f', '--force-rebase', '--no-ff']], quiet: [['-q', '--quiet']],
    },
    c,
  )
  const st = c.snap.work.rebase
  if (o.has('cont')) {
    if (!st) c.fail('fatal: No rebase in progress?')
    return continueRebase(c)
  }
  if (o.has('abort')) {
    if (!st) c.fail('fatal: No rebase in progress?')
    if (st.headName) c.setRef(st.headName, st.origHead)
    c.patchWork({ head: { ref: st.headName, hash: st.origHead }, index: null, files: null, rebase: null })
    return
  }
  if (o.has('skip')) c.fail('fatal: 這裡的 rebase 遇到衝突會直接取消，沒有可以 --skip 的步驟。')
  if (st) c.fail('fatal: rebase 已經在進行中：git rebase --continue 繼續，或 git rebase --abort 取消。')
  await requireClean(c, 'rebase')

  const [upstreamSpec, branchName] = o.rest
  if (branchName) {
    const ref = await branchTarget(c, branchName)
    if (!ref) c.fail(`fatal: invalid upstream '${branchName}'`)
    if (ref !== c.snap.work.head.ref) await switchTo(c, { ref, hash: c.snap.refs.refs.get(ref)! }, false)
  }
  const head = c.head()
  if (!head) c.fail('fatal: 還沒有任何 commit，沒有東西可以 rebase。')
  let upstream: string | null = null
  if (!o.has('root')) {
    let spec = upstreamSpec
    const b = c.branch()
    if (!spec && b) {
      const remote = c.config(`branch.${b}.remote`)
      const merge = c.config(`branch.${b}.merge`)
      if (remote && merge) spec = `${remote}/${merge.replace(/^refs\/heads\//, '')}`
    }
    if (!spec) c.fail('There is no tracking information for the current branch.\nPlease specify which branch you want to rebase against.\n例如：git rebase main，或 git rebase -i HEAD~3')
    upstream = await resolveCommit(c.repo, c.snap, spec)
  }
  const onto = o.get('onto') ? await resolveCommit(c.repo, c.snap, o.get('onto')!) : upstream

  // HEAD's commits that upstream doesn't have, parents first, without merges (like git).
  const hide = upstream ? await ancestors(c.repo, [upstream]) : new Set<string>()
  const list: string[] = []
  const seen = new Set<string>()
  const visit = async (h: string): Promise<void> => {
    if (seen.has(h) || hide.has(h)) return
    seen.add(h)
    const cm = await commitOf(c, h)
    for (const p of cm.parents) await visit(p)
    if (cm.parents.length < 2) list.push(h)
  }
  await visit(head)
  let todo: TodoItem[] = list.map((hash) => ({ action: 'pick', hash }))
  if (o.has('i')) {
    const lines = await Promise.all(list.map(async (h) => `pick ${short(h)} ${subject(await commitOf(c, h))}`))
    const text = [
      ...lines, '',
      `# Rebase ${upstream ? short(upstream) : '(root)'}..${short(head)} onto ${onto ? short(onto) : '(root)'} (${lines.length} commands)`,
      '#', '# Commands:',
      '# p, pick <commit> = 照原樣保留', '# r, reword <commit> = 保留，但改 commit 訊息', '# e, edit <commit> = 保留，然後停下來讓你修改（改檔案、git commit --amend），再 git rebase --continue',
      '# s, squash <commit> = 併進前一個 commit，訊息合在一起', '# f, fixup <commit> = 併進前一個 commit，只留前一個的訊息', '# d, drop <commit> = 丟掉', '# b, break = 停在這裡',
      '#', '# 可以調整順序；刪掉一行等於丟掉那個 commit。全部刪掉就取消。',
    ].join('\n')
    const edited = await c.sh.hooks.editText('git rebase -i', text)
    if (edited === null) c.fail('（已取消，什麼都沒改）')
    todo = []
    for (const line of edited.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const [word, ref] = t.split(/\s+/)
      const action = ACTIONS[word]
      if (!action) c.fail(`error: invalid line: ${t}`)
      if (action === 'break') {
        todo.push({ action, hash: '' })
        continue
      }
      if (!ref) c.fail(`error: missing commit in line: ${t}`)
      todo.push({ action, hash: await resolveCommit(c.repo, c.snap, ref) })
    }
    if (!todo.length) return c.out('Nothing to do')
  }
  const sign = c.wantSign(o.has('S'), o.has('noS'))
  const state: RebaseState = {
    headName: c.snap.work.head.ref, origHead: head, onto, todo, done: 0, total: todo.length, picked: 0, sign,
    ignoreDate: o.has('ignoreDate'), committerDateIsAuthorDate: o.has('cdia'),
    force: o.has('force') || sign || o.has('ignoreDate') || o.has('cdia'),
  }
  c.patchWork({ head: { ref: null, hash: onto }, index: null, files: null, rebase: state })
  await runTodo(c)
}

async function continueRebase(c: Ctx) {
  const st = c.snap.work.rebase!
  const s = await workStatus(c.repo, c.snap)
  if (s.unstaged.length) c.fail('error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.（先 git add，或 git restore 丟掉）')
  if (s.staged.length) {
    // Staged changes after an "edit" stop go into the commit being edited.
    const head = c.head()!
    const prev = await commitOf(c, head)
    let payload = commitPayload(prev, prev.parents, { tree: await buildTree(c.repo, (await c.work()).index), committer: c.ident('committer') })
    if (st.sign) payload = await c.sign(payload)
    const hash = await c.repo.add('commit', fromBin(payload))
    c.rewritten.push([hash, head])
    c.patchWork({ head: { ref: null, hash }, index: null, files: null })
  }
  await runTodo(c)
}

async function runTodo(c: Ctx) {
  for (;;) {
    const st = c.snap.work.rebase!
    const [item, ...todo] = st.todo
    if (!item) break
    c.patchWork({ rebase: { ...st, todo, done: st.done + 1 } })
    if (item.action === 'break') {
      c.out('Stopped at HEAD（git rebase --continue 繼續）')
      return
    }
    if (item.action === 'drop') continue
    const cur = c.head()
    const cm = await commitOf(c, item.hash)
    const squashing = item.action === 'squash' || item.action === 'fixup'
    if (squashing && !st.picked) c.fail(`error: cannot '${item.action}' without a previous commit`)
    const parentTree = cm.parents[0] ? (await commitOf(c, cm.parents[0])).tree : null
    // Unchanged commits on an unchanged parent are kept as they are (git fast-forwards over them).
    if (item.action === 'pick' && !st.force && cm.parents.length <= 1 && (cm.parents[0] ?? null) === cur) {
      c.patchWork({ head: { ref: null, hash: cm.hash }, rebase: { ...c.snap.work.rebase!, picked: st.picked + 1 } })
      continue
    }
    const curTree = cur ? (await commitOf(c, cur)).tree : null
    const merged = await mergeTrees(c.repo, parentTree, curTree, cm.tree)
    if (merged.conflicts.length) {
      c.fail(
        [
          `error: could not apply ${short(cm.hash)}... ${subject(cm)}`,
          ...merged.conflicts.map((p) => `CONFLICT (content): Merge conflict in ${showPath(p)}`),
          '兩邊改到同一段，這個頁面沒辦法手動解決衝突，這一步已經取消。',
          st.done ? '可以 git rebase --abort 回到 rebase 開始前。' : '',
        ].filter(Boolean).join('\n'),
      )
    }
    let hash: string
    if (squashing) {
      const prev = await commitOf(c, cur!)
      let message = prev.message
      if (item.action === 'squash') {
        const text = `# 這是 2 個 commit 合在一起的訊息。\n# 第 1 個 commit 的訊息：\n\n${prev.message}\n# 第 2 個 commit 的訊息：\n\n${cm.message}`
        const edited = await c.sh.hooks.editText('squash 的 commit 訊息', text)
        if (edited === null) c.fail('（已取消，這一步沒有做）')
        message = cleanup(edited, true)
      }
      let payload = commitPayload(prev, prev.parents, { tree: merged.tree, committer: c.ident('committer'), message })
      if (st.sign) payload = await c.sign(payload)
      hash = await c.repo.add('commit', fromBin(payload))
      c.rewritten.push([hash, cur!])
    } else {
      if (merged.tree === curTree && cm.tree !== parentTree) {
        c.hint(`dropping ${short(cm.hash)} ${subject(cm)} -- patch contents already upstream`)
        continue
      }
      let message: string | undefined
      if (item.action === 'reword') {
        const edited = await c.sh.hooks.editText(`改 ${short(cm.hash)} 的訊息`, cm.message)
        if (edited === null) c.fail('（已取消，這一步沒有做）')
        message = cleanup(edited, true)
      }
      const author = st.ignoreDate ? { ...cm.author, ...now() } : undefined
      const who = c.ident('committer')
      const committer = st.committerDateIsAuthorDate ? { ...who, time: (author ?? cm.author).time, tz: (author ?? cm.author).tz } : who
      let payload = commitPayload(cm, cur ? [cur] : [], { tree: merged.tree, author, committer, message })
      if (st.sign) payload = await c.sign(payload)
      hash = await c.repo.add('commit', fromBin(payload))
      c.rewritten.push([hash, cm.hash])
    }
    c.patchWork({ head: { ref: null, hash }, rebase: { ...c.snap.work.rebase!, picked: st.picked + 1 } })
    if (item.action === 'edit') {
      c.out(
        `Stopped at ${short(cm.hash)}...  ${subject(cm)}\nYou can amend the commit now, with\n\n  git commit --amend\n\n` +
          'Once you are satisfied with your changes, run\n\n  git rebase --continue\n（可以用 edit <檔案>、echo … > <檔案> 改檔案，再 git add）',
      )
      return
    }
  }
  const st = c.snap.work.rebase!
  const final = c.head()!
  if (st.headName) c.setRef(st.headName, final)
  c.patchWork({ head: { ref: st.headName, hash: final }, index: null, files: null, rebase: null })
  c.out(`Successfully rebased and updated ${st.headName ?? 'detached HEAD'}.`)
}

// ---------- plumbing & misc ----------
async function revParse(c: Ctx, args: string[]) {
  const o = parseOpts(args, { short: [['--short']], abbrev: [['--abbrev-ref']], verify: [['--verify']], quiet: [['-q', '--quiet']], gitDir: [['--git-dir']], top: [['--show-toplevel']] }, c)
  if (o.has('gitDir')) c.out('.git')
  if (o.has('top')) c.out('/')
  for (const a of o.rest) {
    if (o.has('abbrev')) {
      if (a === 'HEAD' || a === '@') c.out(c.branch() ?? 'HEAD')
      else {
        const r = findRef(c.repo, c.snap, a)
        c.out(r ? shortRef(r) : a)
      }
      continue
    }
    const h = await resolve(c.repo, c.snap, a)
    c.out(o.has('short') ? short(h) : h)
  }
}

async function catFile(c: Ctx, args: string[]) {
  const o = parseOpts(args, { t: [['-t']], s: [['-s']], p: [['-p']], e: [['-e']] }, c)
  const spec = o.rest.at(-1)
  if (!spec) c.fail('usage: git cat-file (-t | -s | -e | -p | <type>) <object>')
  const hash = await resolve(c.repo, c.snap, spec)
  const obj = await c.repo.read(hash)
  if (o.has('e')) return
  if (o.has('t')) return c.out(obj.type)
  if (o.has('s')) return c.out(String(obj.data.length))
  if (obj.type === 'tree' && o.has('p')) {
    return c.out((await readTree(c.repo, hash)).map((e) => `${e.mode.padStart(6, '0')} ${e.mode === TREE ? 'tree' : e.mode === '160000' ? 'commit' : 'blob'} ${e.hash}\t${e.name}`).join('\n'))
  }
  if (isBinary(obj.data)) return c.hint(`（二進位內容，${obj.data.length.toLocaleString()} bytes）`)
  c.out(binToText(toBin(obj.data)).replace(/\n$/, ''))
}

async function lsTree(c: Ctx, args: string[]) {
  const o = parseOpts(args, { r: [['-r']], t: [['-t']], d: [['-d']], nameOnly: [['--name-only', '--name-status']] }, c)
  const [spec, ...paths] = o.rest
  if (!spec) c.fail('usage: git ls-tree [-r] [--name-only] <tree-ish> [<path>...]')
  const lines: string[] = []
  const wanted = paths.map(toPath)
  const walkTree = async (tree: string, prefix: string) => {
    for (const e of await readTree(c.repo, tree)) {
      const path = prefix + e.raw
      const isTree = e.mode === TREE
      if (wanted.length && !wanted.some((q) => path === q || path.startsWith(`${q}/`) || q.startsWith(`${path}/`))) continue
      // Go into a tree with -r, or when a path asked for lies inside it.
      if (isTree && (o.has('r') || wanted.some((q) => q.startsWith(`${path}/`)))) {
        if (o.has('t')) lines.push(line(e.mode, 'tree', e.hash, path))
        await walkTree(e.hash, `${path}/`)
        continue
      }
      if (o.has('d') && !isTree) continue
      lines.push(line(e.mode, isTree ? 'tree' : e.mode === '160000' ? 'commit' : 'blob', e.hash, path))
    }
  }
  const line = (mode: string, type: string, hash: string, path: string) => (o.has('nameOnly') ? showPath(path) : `${mode.padStart(6, '0')} ${type} ${hash}\t${showPath(path)}`)
  await walkTree(await peel(c.repo, await resolve(c.repo, c.snap, spec), 'tree'), '')
  if (lines.length) c.out(lines.join('\n'))
}

async function lsFiles(c: Ctx, args: string[]) {
  const o = parseOpts(args, { s: [['-s', '--stage']], others: [['-o', '--others']], modified: [['-m', '--modified']] }, c)
  const { index, files } = await c.work()
  let paths = [...index.keys()]
  if (o.has('others')) paths = [...files.keys()].filter((p) => !index.has(p))
  if (o.has('modified')) paths = paths.filter((p) => files.get(p)?.hash !== index.get(p)?.hash)
  const lines = paths.sort().map((p) => (o.has('s') && index.has(p) ? `${index.get(p)!.mode} ${index.get(p)!.hash} 0\t${showPath(p)}` : showPath(p)))
  if (lines.length) c.out(lines.join('\n'))
}

async function showRef(c: Ctx, args: string[]) {
  const o = parseOpts(args, { heads: [['--heads', '--branches']], tags: [['--tags']] }, c)
  const lines = [...c.snap.refs.refs]
    .filter(([n]) => (!o.has('heads') && !o.has('tags')) || (o.has('heads') && n.startsWith('refs/heads/')) || (o.has('tags') && n.startsWith('refs/tags/')))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([n, h]) => `${h} ${n}`)
  if (lines.length) c.out(lines.join('\n'))
}

async function reflog(c: Ctx, args: string[]) {
  const rest = args[0] === 'show' ? args.slice(1) : args
  const o = parseOpts(rest, { n: [['-n', '--max-count'], true] }, c)
  const name = o.rest[0] ?? 'HEAD'
  const ref = name === 'HEAD' ? 'HEAD' : (findRef(c.repo, c.snap, name) ?? c.fail(`fatal: ambiguous argument '${name}': unknown revision`))
  const file = await c.repo.fs.file(`logs/${ref}`)
  if (!file) return c.hint(`（${name} 沒有 reflog）`)
  const entries = (await file.text()).split('\n').filter(Boolean).reverse()
  const limit = Number(o.get('n') ?? 30)
  const label = name === 'HEAD' ? 'HEAD' : shortRef(ref)
  c.out(
    entries
      .slice(0, limit)
      .map((l, i) => {
        const tab = l.indexOf('\t')
        const hash = l.split(' ')[1] ?? ''
        return `${short(hash)} ${label}@{${i}}: ${tab >= 0 ? l.slice(tab + 1) : ''}`
      })
      .join('\n'),
  )
  c.hint('（這是 repo 磁碟上的 reflog；這個頁面裡做的修改要寫入後才會出現）')
}

async function fsck(c: Ctx, args: string[]) {
  parseOpts(args, { lost: [['--lost-found']], unreachable: [['--unreachable']], dangling: [['--dangling']], noReflogs: [['--no-reflogs']], full: [['--full']], strict: [['--strict']] }, c)
  const tips = await c.sh.hooks.dangling()
  if (!tips.length) return c.hint('（沒有 dangling commit：每個 commit 都有分支、標籤或 HEAD 指著）')
  c.out(tips.map((h) => `dangling commit ${h}`).join('\n'))
  c.hint('提示：git show <hash> 看內容，git switch --detach <hash> 切過去，git branch <名字> <hash> 把它救回來。勾選樹狀圖上方的「dangling」可以在圖上看到它們。')
}

async function config(c: Ctx, args: string[]) {
  const o = parseOpts(args, { get: [['--get']], unset: [['--unset']], list: [['-l', '--list']], global: [['--global']], local: [['--local']] }, c)
  if (o.has('list')) {
    const all = new Map([...c.repo.config, ...c.sh.config])
    return c.out([...all].map(([k, v]) => `${k}=${v}`).join('\n'))
  }
  const [key, value] = o.rest
  if (!key) c.fail('usage: git config <key> [<value>]')
  // Section and key names are case-insensitive; a subsection (remote.<name>.url) isn't.
  const parts = key.split('.')
  const k = parts.length < 2 ? key : [parts[0].toLowerCase(), ...parts.slice(1, -1), parts.at(-1)!.toLowerCase()].join('.')
  if (o.has('unset')) {
    c.sh.config.delete(k)
    return
  }
  if (value === undefined) {
    const v = c.config(k)
    if (v === undefined) c.fail('')
    return c.out(v)
  }
  c.sh.config.set(k, value)
  c.hint('（只在這個頁面有效，不會寫進 .git/config）')
}

export const GIT: Record<string, Handler> = {
  status, log, show, diff, add, rm, mv, restore, checkout, switch: switchCmd, branch, tag, reset, commit,
  'cherry-pick': cherryPick, revert, merge, rebase, 'rev-parse': revParse, 'cat-file': catFile, 'ls-tree': lsTree,
  'ls-files': lsFiles, 'show-ref': showRef, reflog, fsck, config,
  version: async (c) => c.out('git version 2.x (giteditor，頁面裡的 git)'),
}

export const GIT_HELP: [string, string][] = [
  ['git status / log / show / diff', '看狀態、歷史（log --oneline、--format、--all）、內容和差異'],
  ['git switch <分支> / checkout <分支|commit>', '切換（只在頁面裡）；switch -c 建分支，--detach 切到任何 commit'],
  ['git add / rm / mv / restore', '暫存區'],
  ['git commit [-m] [-a] [--amend] [--date] [-S]', '建立或修改 commit；--author、--no-edit、GIT_COMMITTER_DATE=…'],
  ['git reset [--soft|--mixed|--hard] <rev>', '移動目前的分支'],
  ['git branch / tag', '列出、建立、刪除、改名（-d、-D、-m、tag -a、tag -s）'],
  ['git rebase [-i] [--onto] [--root] <upstream>', '重排、改訊息、合併、丟掉、停下來修改 commit'],
  ['git cherry-pick / revert / merge', '套用或撤銷 commit、合併分支（有衝突就取消）'],
  ['git fsck', '列出 dangling commit'],
  ['git reflog / rev-parse / cat-file / ls-tree / ls-files / show-ref / config', '其他'],
]
