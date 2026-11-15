import { textToBin } from './bytes'
import type { Commit, Person } from './objects'
import { MissingObjectError, type Repo } from './repo'
import { entryAt } from './tree'
import { headCommit, type Snapshot } from './work'

// Errors printed as they are, in git's words.
export class GitError extends Error {}

// ---------- refs ----------
// The order git tries a short name in (gitrevisions(7)).
export function findRef(repo: Repo, snap: Snapshot, name: string): string | null {
  const refs = snap.refs.refs
  for (const full of [name, `refs/${name}`, `refs/tags/${name}`, `refs/heads/${name}`, `refs/remotes/${name}`, `refs/remotes/${name}/HEAD`]) {
    if (!full.startsWith('refs/')) continue
    if (refs.has(full)) return full
    const target = repo.symrefs.get(full)
    if (target && refs.has(target)) return target
  }
  return null
}

// git check-ref-format, for branch and tag names.
export function validRefName(name: string): boolean {
  return !(
    !name ||
    name === '@' ||
    name.startsWith('-') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.endsWith('.lock') ||
    name.includes('..') ||
    name.includes('//') ||
    name.includes('@{') ||
    /[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) ||
    name.split('/').some((s) => s.startsWith('.'))
  )
}

// ---------- revisions ----------
export async function resolve(repo: Repo, snap: Snapshot, spec: string): Promise<string> {
  const colon = spec.indexOf(':')
  if (colon >= 0) {
    const path = textToBin(spec.slice(colon + 1).replace(/^\.?\//, '').replace(/\/$/, ''))
    if (colon === 0) {
      const e = snap.work.index?.get(path) ?? (await entryAt(repo, await treeOf(repo, headCommit(snap)), path))
      if (!e) throw new GitError(`fatal: path '${spec.slice(1)}' does not exist in the index`)
      return e.hash
    }
    const tree = await peel(repo, await resolve(repo, snap, spec.slice(0, colon)), 'tree')
    const e = path ? await entryAt(repo, tree, path) : { hash: tree }
    if (!e) throw new GitError(`fatal: path '${spec.slice(colon + 1)}' does not exist in '${spec.slice(0, colon)}'`)
    return e.hash
  }
  const m = spec.match(/^(.*?)((?:\^\{\w*\}|[~^]\d*)*)$/)!
  let hash = await resolveName(repo, snap, m[1], spec)
  for (const op of m[2].match(/\^\{\w*\}|[~^]\d*/g) ?? []) {
    if (op.startsWith('^{')) {
      const want = op.slice(2, -1)
      if (want === 'tree' || want === 'commit') hash = await peel(repo, hash, want)
      else if (want === '') hash = (await repo.peel(hash)).hash
      else throw new GitError(`fatal: unknown peel '${op}'`)
    } else if (op[0] === '^') {
      const n = op.length > 1 ? Number(op.slice(1)) : 1
      const c = await repo.commit(await peel(repo, hash, 'commit'))
      if (n === 0) hash = c.hash
      else if (!c.parents[n - 1]) throw new GitError(`fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.`)
      else hash = c.parents[n - 1]
    } else {
      const n = op.length > 1 ? Number(op.slice(1)) : 1
      hash = await peel(repo, hash, 'commit')
      for (let i = 0; i < n; i++) {
        const p = (await repo.commit(hash)).parents[0]
        if (!p) throw new GitError(`fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.`)
        hash = p
      }
    }
  }
  return hash
}

async function resolveName(repo: Repo, snap: Snapshot, name: string, spec: string): Promise<string> {
  if (name === 'HEAD' || name === '@' || name === '') {
    const h = headCommit(snap)
    if (!h) throw new GitError(`fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.`)
    return h
  }
  const ref = findRef(repo, snap, name)
  if (ref) return snap.refs.refs.get(ref)!
  if (/^[0-9a-f]{4,64}$/i.test(name)) {
    const found = await repo.findPrefix(name.toLowerCase())
    if (found.length === 1) return found[0]
    if (found.length > 1) throw new GitError(`error: short object ID ${name} is ambiguous\nfatal: ambiguous argument '${spec}'`)
  }
  throw new GitError(`fatal: ambiguous argument '${spec}': unknown revision or path not in the working tree.`)
}

export async function peel(repo: Repo, hash: string, want: 'commit' | 'tree'): Promise<string> {
  const p = await repo.peel(hash)
  if (p.type === want) return p.hash
  if (want === 'tree' && p.type === 'commit') return (await repo.commit(p.hash)).tree
  throw new GitError(`fatal: ${hash.slice(0, 7)} is a ${p.type}, not a ${want}`)
}

export const resolveCommit = async (repo: Repo, snap: Snapshot, spec: string) => peel(repo, await resolve(repo, snap, spec), 'commit')

async function treeOf(repo: Repo, commit: string | null) {
  return commit ? (await repo.commit(commit)).tree : null
}

// ---------- walking ----------
// Commits reachable from `tips` but not from `hide`, newest first (like `git log a ^b`).
export async function walk(repo: Repo, tips: string[], hide: string[] = [], limit = Infinity): Promise<Commit[]> {
  const hidden = hide.length ? await ancestors(repo, hide) : new Set<string>()
  const seen = new Set<string>()
  const queue: Commit[] = []
  const push = async (h: string) => {
    if (seen.has(h) || hidden.has(h)) return
    seen.add(h)
    try {
      const c = await repo.commit(h)
      let i = queue.length
      while (i > 0 && queue[i - 1].committer.time < c.committer.time) i--
      queue.splice(i, 0, c)
    } catch (e) {
      if (!(e instanceof MissingObjectError)) throw e
    }
  }
  for (const t of tips) await push(t)
  const out: Commit[] = []
  while (queue.length && out.length < limit) {
    const c = queue.shift()!
    out.push(c)
    for (const p of c.parents) await push(p)
  }
  return out
}

export async function ancestors(repo: Repo, tips: string[]): Promise<Set<string>> {
  const seen = new Set<string>()
  const stack = [...tips]
  while (stack.length) {
    const h = stack.pop()!
    if (seen.has(h)) continue
    seen.add(h)
    try {
      stack.push(...(await repo.commit(h)).parents)
    } catch (e) {
      if (!(e instanceof MissingObjectError)) throw e
    }
  }
  return seen
}

export async function isAncestor(repo: Repo, a: string, b: string) {
  return (await ancestors(repo, [b])).has(a)
}

// Commits nothing points at any more (no branch, tag, remote branch or HEAD, the repo's or the
// page's), as the tips of their little histories, newest first. `all` is every commit there is.
export async function danglingCommits(repo: Repo, snap: Snapshot, all: Iterable<string>): Promise<string[]> {
  const roots: string[] = []
  for (const h of [...snap.refs.refs.values(), snap.refs.head.hash, headCommit(snap)]) {
    if (!h) continue
    try {
      const p = await repo.peel(h)
      if (p.type === 'commit') roots.push(p.hash)
    } catch (e) {
      if (!(e instanceof MissingObjectError)) throw e
    }
  }
  const reach = await ancestors(repo, roots)
  const lost = [...new Set(all)].filter((h) => !reach.has(h))
  const parents = new Set<string>()
  for (const h of lost) for (const p of (await repo.commit(h)).parents) parents.add(p)
  const tips = await Promise.all(lost.filter((h) => !parents.has(h)).map((h) => repo.commit(h)))
  return tips.sort((a, b) => b.committer.time - a.committer.time).map((c) => c.hash)
}

// The best common ancestor: common ancestors that aren't ancestors of another one, newest first.
export async function mergeBase(repo: Repo, a: string, b: string): Promise<string | null> {
  const fromA = await ancestors(repo, [a])
  const found: string[] = []
  const seen = new Set<string>()
  const stack = [b]
  while (stack.length) {
    const h = stack.pop()!
    if (seen.has(h)) continue
    seen.add(h)
    if (fromA.has(h)) {
      found.push(h)
      continue
    }
    try {
      stack.push(...(await repo.commit(h)).parents)
    } catch (e) {
      if (!(e instanceof MissingObjectError)) throw e
    }
  }
  const best: Commit[] = []
  for (const h of found) {
    const others = found.filter((x) => x !== h)
    if (!others.length || !(await ancestors(repo, others)).has(h)) best.push(await repo.commit(h))
  }
  best.sort((x, y) => y.committer.time - x.committer.time)
  return best[0]?.hash ?? null
}

// ---------- dates ----------
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')
const tzMin = (tz: string) => (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)))
const wall = (time: number, tz: string) => new Date((time + tzMin(tz) * 60) * 1000)

export function localTz(at = Date.now()): string {
  const m = -new Date(at).getTimezoneOffset()
  const a = Math.abs(m)
  return `${m < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}${pad(a % 60)}`
}

export function now(): { time: number; tz: string } {
  return { time: Math.floor(Date.now() / 1000), tz: localTz() }
}

// git's default: "Thu Nov 16 05:13:20 2023 +0800"
export function gitDate(time: number, tz: string): string {
  const d = wall(time, tz)
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()} ${tz}`
}

export function isoDate(time: number, tz: string): string {
  return `${wall(time, tz).toISOString().slice(0, 19).replace('T', ' ')} ${tz}`
}

export function formatDate(p: Person, style = 'default'): string {
  if (style === 'iso' || style === 'iso8601') return isoDate(p.time, p.tz)
  if (style === 'iso-strict') return `${wall(p.time, p.tz).toISOString().slice(0, 19)}${p.tz.slice(0, 3)}:${p.tz.slice(3)}`
  if (style === 'short') return isoDate(p.time, p.tz).slice(0, 10)
  if (style === 'unix') return String(p.time)
  if (style === 'raw') return `${p.time} ${p.tz}`
  return gitDate(p.time, p.tz)
}

const normTz = (z: string | undefined, fallback: string) => {
  if (!z) return fallback
  if (z === 'Z' || z === 'UTC' || z === 'GMT') return '+0000'
  const m = z.match(/^([+-])(\d\d):?(\d\d)$/)
  return m ? `${m[1]}${m[2]}${m[3]}` : null
}

// The date formats people pass to --date and GIT_*_DATE: git's own, ISO 8601, RFC 2822, raw
// "<seconds> <zone>", "@<seconds>" and "now". Without a zone, local time is meant (like git).
export function parseDate(input: string): { time: number; tz: string } | null {
  const s = input.trim()
  if (s === 'now') return now()
  let m = s.match(/^@?(\d{9,11})(?:\s+([+-]\d{4}))?$/)
  if (m) return { time: Number(m[1]), tz: m[2] ?? '+0000' }
  const at = (y: number, mo: number, d: number, h: number, mi: number, se: number, z: string | undefined) => {
    const utc = Date.UTC(y, mo, d, h, mi, se) / 1000
    if (Number.isNaN(utc)) return null
    let tz = normTz(z, '')
    if (tz === null) return null
    // No zone: local time on that day.
    if (!tz) tz = localTz((utc - tzMin(localTz(utc * 1000)) * 60) * 1000)
    return { time: utc - tzMin(tz) * 60, tz }
  }
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d\d:?\d\d)?$/i)
  if (m) return at(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7]?.toUpperCase())
  // "Thu, 16 Nov 2023 05:13:20 +0800" and "Thu Nov 16 05:13:20 2023 +0800"
  m = s.match(/^(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|Z|UTC|GMT)?$/)
  if (m && MONTHS.includes(cap(m[2]))) return at(+m[3], MONTHS.indexOf(cap(m[2])), +m[1], +m[4], +m[5], +(m[6] ?? 0), m[7])
  m = s.match(/^(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(\d{4})\s*([+-]\d{4}|Z|UTC|GMT)?$/)
  if (m && MONTHS.includes(cap(m[1]))) return at(+m[6], MONTHS.indexOf(cap(m[1])), +m[2], +m[3], +m[4], +(m[5] ?? 0), m[7])
  return null
}
const cap = (s: string) => s[0].toUpperCase() + s.slice(1).toLowerCase()
