// Line diffs and three-way merges, on binary strings split after each '\n' (so the bytes, line
// endings and a missing final newline all survive).

export interface Hunk {
  a: number // a[a, aEnd) is replaced by b[b, bEnd)
  aEnd: number
  b: number
  bEnd: number
}

const MAX_EDITS = 4000

export const splitLines = (s: string) => (s ? s.split(/(?<=\n)/) : [])

// Myers' algorithm on what's left after the common start and end are cut off. Past MAX_EDITS edits
// it gives up looking and calls the whole middle one change.
export function diffHunks(a: string[], b: string[]): Hunk[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  if (!A.length && !B.length) return []
  const matches = myers(A, B) ?? []
  const out: Hunk[] = []
  let x = 0
  let y = 0
  for (const [mx, my] of [...matches, [A.length, B.length]]) {
    if (mx > x || my > y) out.push({ a: pre + x, aEnd: pre + mx, b: pre + y, bEnd: pre + my })
    x = mx + 1
    y = my + 1
  }
  return out
}

// Matching line pairs, in order; null when there are too many edits.
function myers(A: string[], B: string[]): [number, number][] | null {
  const N = A.length
  const M = B.length
  if (!N || !M) return []
  const max = N + M
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDITS) return null
    trace.push(v.slice(off - d, off + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < N && y < M && A[x] === B[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= N && y >= M) return backtrack(trace, N, M)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], N: number, M: number): [number, number][] {
  const out: [number, number][] = []
  let x = N
  let y = M
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d] // the values after step d - 1, indexed by k + d
    const at = (k: number) => prev[k + d]
    const k = x - y
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const px = at(pk)
    const py = px - pk
    while (x > px && y > py) out.push([--x, --y])
    x = px
    y = py
  }
  while (x > 0 && y > 0) out.push([--x, --y])
  return out.reverse()
}

// ---------- three-way merge ----------
// Changes from both sides are applied when they don't touch; changes that overlap or sit next to each
// other must be identical, otherwise it's a conflict (null).
export function merge3(base: string[], ours: string[], theirs: string[]): string[] | null {
  const tagged = [
    ...diffHunks(base, ours).map((h) => ({ ...h, side: 0 })),
    ...diffHunks(base, theirs).map((h) => ({ ...h, side: 1 })),
  ].sort((p, q) => p.a - q.a || p.aEnd - q.aEnd)
  const sides = [ours, theirs]
  const out: string[] = []
  let pos = 0
  for (let i = 0; i < tagged.length; ) {
    const group = [tagged[i]]
    const start = tagged[i].a
    let end = tagged[i].aEnd
    for (i++; i < tagged.length && tagged[i].a <= end; i++) {
      group.push(tagged[i])
      end = Math.max(end, tagged[i].aEnd)
    }
    // What each side made of base[start, end).
    const version = (side: number) => {
      const res: string[] = []
      let p = start
      for (const h of group.filter((g) => g.side === side)) {
        res.push(...base.slice(p, h.a), ...sides[side].slice(h.b, h.bEnd))
        p = h.aEnd
      }
      return [...res, ...base.slice(p, end)]
    }
    out.push(...base.slice(pos, start))
    if (group.every((g) => g.side === group[0].side)) {
      out.push(...version(group[0].side))
    } else {
      const v0 = version(0)
      const v1 = version(1)
      if (v0.length !== v1.length || v0.some((l, k) => l !== v1[k])) return null
      out.push(...v0)
    }
    pos = end
  }
  out.push(...base.slice(pos))
  return out
}

// ---------- unified diff ----------
const CONTEXT = 3

// `diff -u` style lines (without the ---/+++ header). Lines are binary strings; `show` turns one
// into displayable text.
export function unifiedDiff(a: string[], b: string[], show: (line: string) => string): string[] {
  const hunks = diffHunks(a, b)
  const out: string[] = []
  const strip = (l: string) => show(l.endsWith('\n') ? l.slice(0, -1) : l)
  const noEol = (l: string) => (l.endsWith('\n') ? [] : ['\\ No newline at end of file'])
  for (let i = 0; i < hunks.length; ) {
    let j = i
    while (j + 1 < hunks.length && hunks[j + 1].a - hunks[j].aEnd <= CONTEXT * 2) j++
    const aStart = Math.max(0, hunks[i].a - CONTEXT)
    const aEnd = Math.min(a.length, hunks[j].aEnd + CONTEXT)
    const bStart = hunks[i].b - (hunks[i].a - aStart)
    const bEnd = hunks[j].bEnd + (aEnd - hunks[j].aEnd)
    const range = (s: number, n: number) => (n === 1 ? `${s + 1}` : `${n ? s + 1 : s},${n}`)
    out.push(`@@ -${range(aStart, aEnd - aStart)} +${range(bStart, bEnd - bStart)} @@`)
    let p = aStart
    for (const h of hunks.slice(i, j + 1)) {
      for (const l of a.slice(p, h.a)) out.push(` ${strip(l)}`, ...noEol(l))
      for (const l of a.slice(h.a, h.aEnd)) out.push(`-${strip(l)}`, ...noEol(l))
      for (const l of b.slice(h.b, h.bEnd)) out.push(`+${strip(l)}`, ...noEol(l))
      p = h.aEnd
    }
    for (const l of a.slice(p, aEnd)) out.push(` ${strip(l)}`, ...noEol(l))
    i = j + 1
  }
  return out
}

export const isBinary = (data: Uint8Array) => data.subarray(0, 8000).includes(0)
