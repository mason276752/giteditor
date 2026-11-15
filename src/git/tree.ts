import { concat, enc, fromBin, toBin, unhex } from './bytes'
import { isBinary, merge3, splitLines } from './diff'
import { parseTree, type TreeEntry } from './objects'
import type { Repo } from './repo'

// Paths are binary strings ('/'-separated tree entry names as stored), so names in any encoding
// survive a tree being rebuilt.
export interface Entry {
  mode: string
  hash: string
}
export type Files = Map<string, Entry> // path → blob, symlink or submodule (no trees)

export const TREE = '40000'
const isFile = (e: Entry) => e.mode === '100644' || e.mode === '100755'
export const sameEntry = (a?: Entry | null, b?: Entry | null) =>
  (!a && !b) || (!!a && !!b && a.mode === b.mode && a.hash === b.hash)

const trees = new Map<string, TreeEntry[]>()
export async function readTree(repo: Repo, hash: string): Promise<TreeEntry[]> {
  let t = trees.get(hash)
  if (!t) {
    const o = await repo.read(hash)
    if (o.type !== 'tree') throw new Error(`${hash.slice(0, 7)} 不是 tree`)
    t = parseTree(o.data, repo.hashLen)
    if (trees.size > 20000) trees.clear()
    trees.set(hash, t)
  }
  return t
}

// git orders entries by name, comparing a directory as if its name ended in '/'.
const sortKey = (name: string, mode: string) => (mode === TREE ? `${name}/` : name)

export async function writeTree(repo: Repo, entries: { name: string; mode: string; hash: string }[]): Promise<string> {
  const sorted = [...entries].sort((a, b) => {
    const x = sortKey(a.name, a.mode)
    const y = sortKey(b.name, b.mode)
    return x < y ? -1 : x > y ? 1 : 0
  })
  return repo.add('tree', concat(sorted.flatMap((e) => [fromBin(`${e.mode} ${e.name}\0`), unhex(e.hash)])))
}

export const emptyTree = (repo: Repo) => writeTree(repo, [])

export async function flatten(repo: Repo, tree: string | null, prefix = '', out: Files = new Map()): Promise<Files> {
  if (!tree) return out
  for (const e of await readTree(repo, tree)) {
    const path = prefix + e.raw
    if (e.mode === TREE) await flatten(repo, e.hash, `${path}/`, out)
    else out.set(path, { mode: e.mode, hash: e.hash })
  }
  return out
}

export async function buildTree(repo: Repo, files: Files): Promise<string> {
  type Dir = Map<string, Entry | Dir>
  const root: Dir = new Map()
  for (const [path, entry] of files) {
    const segs = path.split('/')
    let d = root
    for (const s of segs.slice(0, -1)) {
      let sub = d.get(s)
      if (!(sub instanceof Map)) d.set(s, (sub = new Map()))
      d = sub
    }
    d.set(segs.at(-1)!, entry)
  }
  const write = async (d: Dir): Promise<string> =>
    writeTree(
      repo,
      await Promise.all([...d].map(async ([name, v]) => (v instanceof Map ? { name, mode: TREE, hash: await write(v) } : { name, ...v }))),
    )
  return write(root)
}

export async function entryAt(repo: Repo, tree: string | null, path: string): Promise<Entry | null> {
  let cur: Entry | null = tree ? { mode: TREE, hash: tree } : null
  for (const seg of path.split('/').filter(Boolean)) {
    if (!cur || cur.mode !== TREE) return null
    const e: TreeEntry | undefined = (await readTree(repo, cur.hash)).find((x) => x.raw === seg)
    cur = e ? { mode: e.mode, hash: e.hash } : null
  }
  return cur
}

// The tree with some paths set (or removed, null), rebuilding only the trees on the way to them.
export async function updateTree(repo: Repo, tree: string | null, changes: Map<string, Entry | null>): Promise<string> {
  const rec = async (t: string | null, ch: Map<string, Entry | null>): Promise<string | null> => {
    const entries = new Map<string, Entry>()
    if (t) for (const e of await readTree(repo, t)) entries.set(e.raw, { mode: e.mode, hash: e.hash })
    const nested = new Map<string, Map<string, Entry | null>>()
    for (const [path, e] of ch) {
      const slash = path.indexOf('/')
      if (slash < 0) {
        if (e) entries.set(path, e)
        else entries.delete(path)
      } else {
        const name = path.slice(0, slash)
        if (!nested.has(name)) nested.set(name, new Map())
        nested.get(name)!.set(path.slice(slash + 1), e)
      }
    }
    for (const [name, sub] of nested) {
      const cur = entries.get(name)
      const h = await rec(cur?.mode === TREE ? cur.hash : null, sub)
      if (h) entries.set(name, { mode: TREE, hash: h })
      else entries.delete(name)
    }
    return entries.size ? writeTree(repo, [...entries].map(([name, e]) => ({ name, ...e }))) : null
  }
  return (await rec(tree, changes)) ?? emptyTree(repo)
}

// ---------- three-way merge ----------
// Applies the changes base → theirs on top of ours, the way cherry-pick and rebase do. Subtrees that
// are the same on two sides aren't even read. Paths changed differently on both sides end up in
// `conflicts`.
export async function mergeTrees(repo: Repo, base: string | null, ours: string | null, theirs: string | null) {
  const conflicts: string[] = []
  const tree = (await mergeRec(repo, base, ours, theirs, '', conflicts)) ?? (await emptyTree(repo))
  return { tree, conflicts }
}

async function mergeRec(repo: Repo, b: string | null, o: string | null, t: string | null, path: string, conflicts: string[]) {
  if (o === t) return o
  if (b === o) return t
  if (b === t) return o
  const read = async (h: string | null) => new Map(h ? (await readTree(repo, h)).map((e) => [e.raw, e as Entry]) : [])
  const [mb, mo, mt] = await Promise.all([read(b), read(o), read(t)])
  const out: { name: string; mode: string; hash: string }[] = []
  for (const name of new Set([...mb.keys(), ...mo.keys(), ...mt.keys()])) {
    const e = await mergeEntry(repo, mb.get(name), mo.get(name), mt.get(name), path + name, conflicts)
    if (e) out.push({ name, ...e })
  }
  return out.length ? writeTree(repo, out) : null
}

async function mergeEntry(repo: Repo, B: Entry | undefined, O: Entry | undefined, T: Entry | undefined, path: string, conflicts: string[]): Promise<Entry | null> {
  if (sameEntry(O, T)) return O ?? null
  if (sameEntry(B, O)) return T ?? null
  if (sameEntry(B, T)) return O ?? null
  if (O?.mode === TREE && T?.mode === TREE && (!B || B.mode === TREE)) {
    const h = await mergeRec(repo, B?.hash ?? null, O.hash, T.hash, `${path}/`, conflicts)
    return h ? { mode: TREE, hash: h } : null
  }
  if (O && T && isFile(O) && isFile(T) && (!B || isFile(B))) {
    const mode = O.mode === T.mode ? O.mode : B && O.mode === B.mode ? T.mode : B && T.mode === B.mode ? O.mode : null
    const [bd, od, td] = await Promise.all([B, O, T].map(async (e) => (e ? (await repo.read(e.hash)).data : new Uint8Array())))
    const merged = mode && ![bd, od, td].some(isBinary) ? merge3(splitLines(toBin(bd)), splitLines(toBin(od)), splitLines(toBin(td))) : null
    if (mode && merged) return { mode, hash: await repo.add('blob', fromBin(merged.join(''))) }
  }
  conflicts.push(path)
  return O ?? null
}

// ---------- diff ----------
export interface Change {
  path: string
  a: Entry | null
  b: Entry | null
}

export async function diffTrees(repo: Repo, a: string | null, b: string | null): Promise<Change[]> {
  const out: Change[] = []
  const rec = async (x: string | null, y: string | null, prefix: string) => {
    if (x === y) return
    const read = async (h: string | null) => new Map(h ? (await readTree(repo, h)).map((e) => [e.raw, e as Entry]) : [])
    const [mx, my] = await Promise.all([read(x), read(y)])
    for (const name of [...new Set([...mx.keys(), ...my.keys()])].sort()) {
      const A = mx.get(name)
      const B = my.get(name)
      if (sameEntry(A, B)) continue
      const path = prefix + name
      if (A?.mode === TREE || B?.mode === TREE) {
        if (A && A.mode !== TREE) out.push({ path, a: A, b: null })
        await rec(A?.mode === TREE ? A.hash : null, B?.mode === TREE ? B.hash : null, `${path}/`)
        if (B && B.mode !== TREE) out.push({ path, a: null, b: B })
      } else {
        out.push({ path, a: A ?? null, b: B ?? null })
      }
    }
  }
  await rec(a, b, '')
  return out
}

// Differences between two flat file lists (index, working tree).
export function diffFiles(a: Files, b: Files): Change[] {
  const out: Change[] = []
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(path) ?? null
    const y = b.get(path) ?? null
    if (!sameEntry(x, y)) out.push({ path, a: x, b: y })
  }
  return out
}

export const blobFromText = (repo: Repo, text: string) => repo.add('blob', enc.encode(text))
