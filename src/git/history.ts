import type { Commit } from './objects'
import { MissingObjectError, type Head, type Repo } from './repo'

// Where the refs point. The repo's copy is what's on disk; edits make new ones (undo keeps the old).
export interface RefState {
  refs: Map<string, string>
  head: Head
}

export type RefKind = 'head' | 'branch' | 'remote' | 'tag' | 'dangling'

export interface RefLabel {
  name: string // full ref name; HEAD (the page's, when detached), REPO_HEAD (the repo's, detached), DANGLING
  short: string
  kind: RefKind
  current?: boolean // the branch the page has checked out
}

// One line of the graph. `lines` is flat: x1, y1, x2, y2, colour per segment, with x in lanes and
// y in half rows (0 top, 1 the commit's dot, 2 bottom).
export interface Row {
  hash: string
  col: number
  color: number
  lines: number[]
}

export interface History {
  commits: Map<string, Commit>
  rows: Row[]
  index: Map<string, number> // commit → row
  children: Map<string, string[]>
  labels: Map<string, RefLabel[]> // commit → refs pointing at it
  peeled: Map<string, string> // ref (or HEAD, REPO_HEAD) → the commit it ends up at
  lanes: number
  missing: number // parents that aren't in the repo (shallow clone)
}

const COLORS = 8

export function refKind(name: string): RefKind | null {
  if (name === 'HEAD' || name === 'REPO_HEAD') return 'head'
  if (name.startsWith('refs/heads/')) return 'branch'
  if (name.startsWith('refs/remotes/')) return 'remote'
  if (name.startsWith('refs/tags/')) return 'tag'
  return null
}

export const shortRef = (name: string) => name.replace(/^refs\/(heads|remotes|tags)\//, '')

interface LoadOptions {
  remotes?: boolean
  checkout?: Head // the page's HEAD (defaults to the repo's)
  dangling?: string[] // unreachable commits to show too
  onProgress?: (n: number) => void
}

const LABEL_NAMES: Record<string, string> = { HEAD: 'HEAD', REPO_HEAD: 'repo 的 HEAD', DANGLING: 'dangling' }

export async function loadHistory(
  repo: Repo,
  state: RefState,
  { remotes = true, checkout = state.head, dangling = [], onProgress }: LoadOptions = {},
): Promise<History> {
  // Branches, remote branches, tags and HEAD, like `git log --all` without stash or notes.
  const shown: [string, string][] = [...state.refs].filter(([name]) => refKind(name) && (remotes || refKind(name) !== 'remote'))
  if (!checkout.ref && checkout.hash) shown.push(['HEAD', checkout.hash])
  if (!state.head.ref && state.head.hash && state.head.hash !== checkout.hash) shown.push(['REPO_HEAD', state.head.hash])
  const peeled = new Map<string, string>()
  const labels = new Map<string, RefLabel[]>()
  const label = (hash: string, l: RefLabel) => labels.set(hash, [...(labels.get(hash) ?? []), l])
  for (const h of dangling) label(h, { name: 'DANGLING', short: LABEL_NAMES.DANGLING, kind: 'dangling' })
  await Promise.all(
    shown.map(async ([name, hash]) => {
      try {
        const p = await repo.peel(hash)
        if (p.type !== 'commit') return
        peeled.set(name, p.hash)
        label(p.hash, { name, short: LABEL_NAMES[name] ?? shortRef(name), kind: refKind(name)!, current: name === checkout.ref })
      } catch (e) {
        if (!(e instanceof MissingObjectError)) throw e
      }
    }),
  )
  const order: RefKind[] = ['head', 'branch', 'tag', 'remote', 'dangling']
  for (const l of labels.values()) l.sort((a, b) => +!!b.current - +!!a.current || order.indexOf(a.kind) - order.indexOf(b.kind))

  // Every commit reachable from them.
  const commits = new Map<string, Commit>()
  const seen = new Set([...peeled.values(), ...dangling])
  let queue = [...seen]
  let missing = 0
  while (queue.length) {
    const batch = queue
    queue = []
    for (let i = 0; i < batch.length; i += 64) {
      const loaded = await Promise.all(
        batch.slice(i, i + 64).map((h) =>
          repo.commit(h).catch((e) => {
            if (e instanceof MissingObjectError) return null
            throw e
          }),
        ),
      )
      for (const c of loaded) {
        if (!c) {
          missing++
          continue
        }
        commits.set(c.hash, c)
        for (const p of c.parents) {
          if (!seen.has(p)) {
            seen.add(p)
            queue.push(p)
          }
        }
      }
      onProgress?.(commits.size)
    }
  }

  const children = new Map<string, string[]>()
  for (const c of commits.values()) {
    for (const p of c.parents) {
      if (commits.has(p)) children.set(p, [...(children.get(p) ?? []), c.hash])
    }
  }
  const rows = layout(dateOrder(commits, children), commits)
  return {
    commits,
    rows,
    index: new Map(rows.map((r, i) => [r.hash, i])),
    children,
    labels,
    peeled,
    lanes: rows.reduce((m, r) => Math.max(m, r.col + 1, ...lanesOf(r)), 0),
    missing,
  }
}

function lanesOf(r: Row): number[] {
  const out: number[] = []
  for (let i = 0; i < r.lines.length; i += 5) out.push(r.lines[i] + 1, r.lines[i + 2] + 1)
  return out
}

// Newest first, but never a parent before its children (`git log --date-order`).
function dateOrder(commits: Map<string, Commit>, children: Map<string, string[]>): string[] {
  const pending = new Map<string, number>()
  const heap: Commit[] = []
  const newer = (a: Commit, b: Commit) => a.committer.time > b.committer.time
  const push = (c: Commit) => {
    heap.push(c)
    for (let i = heap.length - 1; i > 0; ) {
      const up = (i - 1) >> 1
      if (!newer(heap[i], heap[up])) break
      ;[heap[i], heap[up]] = [heap[up], heap[i]]
      i = up
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      for (let i = 0; ; ) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < heap.length && newer(heap[l], heap[m])) m = l
        if (r < heap.length && newer(heap[r], heap[m])) m = r
        if (m === i) break
        ;[heap[i], heap[m]] = [heap[m], heap[i]]
        i = m
      }
    }
    return top
  }
  for (const c of commits.values()) {
    const n = children.get(c.hash)?.length ?? 0
    if (n) pending.set(c.hash, n)
    else push(c)
  }
  const out: string[] = []
  while (heap.length) {
    const c = pop()
    out.push(c.hash)
    for (const p of new Set(c.parents)) {
      const left = pending.get(p)
      if (left === undefined) continue
      if (left > 1) pending.set(p, left - 1)
      else {
        pending.delete(p)
        push(commits.get(p)!)
      }
    }
  }
  return out
}

// Lanes: each one waits for a commit. A commit takes the first lane waiting for it (or a free one if
// nothing is, a branch tip), other lanes waiting for it end there, and its parents get lanes below.
function layout(order: string[], commits: Map<string, Commit>): Row[] {
  const lanes: (string | null)[] = []
  const colors: number[] = []
  let nextColor = 0
  const open = (hash: string) => {
    let j = lanes.indexOf(null)
    if (j < 0) j = lanes.length
    lanes[j] = hash
    colors[j] = nextColor++ % COLORS
    return j
  }
  return order.map((hash) => {
    const lines: number[] = []
    let col = lanes.indexOf(hash)
    const tip = col < 0
    if (tip) col = open(hash)
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null || (tip && i === col)) continue
      if (lanes[i] === hash) {
        lines.push(i, 0, col, 1, colors[i])
        if (i !== col) lanes[i] = null
      } else {
        lines.push(i, 0, i, 2, colors[i])
      }
    }
    const color = colors[col]
    const parents = [...new Set(commits.get(hash)!.parents)].filter((p) => commits.has(p))
    lanes[col] = null
    parents.forEach((p, k) => {
      let j = lanes.indexOf(p)
      if (j < 0) {
        if (k === 0) {
          lanes[col] = p
          j = col
        } else {
          j = open(p)
        }
      }
      lines.push(col, 1, j, 2, colors[j])
    })
    while (lanes.length && lanes.at(-1) === null) lanes.pop()
    return { hash, col, color, lines }
  })
}
