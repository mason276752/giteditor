import { zlibSync } from 'fflate'
import { binToText, concat, digest, enc, type HashAlgo } from './bytes'
import type { RefState } from './history'
import { shortRef } from './history'
import { parseTree, type ObjType } from './objects'
import { PACK_CODES, type Repo } from './repo'
import { diffTrees } from './tree'

export interface RefUpdate {
  name: string // 'HEAD' when HEAD is detached
  old: string | null // null: a new ref
  new: string | null // null: deleted
}

export function refUpdates(base: RefState, cur: RefState): RefUpdate[] {
  const out: RefUpdate[] = []
  for (const [name, hash] of cur.refs) {
    const old = base.refs.get(name) ?? null
    if (old !== hash) out.push({ name, old, new: hash })
  }
  for (const [name, old] of base.refs) if (!cur.refs.has(name)) out.push({ name, old, new: null })
  if (!cur.head.ref && cur.head.hash && cur.head.hash !== base.head.hash) {
    out.push({ name: 'HEAD', old: base.head.hash, new: cur.head.hash })
  }
  return out
}

interface NewObject {
  hash: string
  type: ObjType
  data: Uint8Array
}

// Objects made here that the updated refs need (the rest are already in the repo).
export async function newObjects(repo: Repo, updates: RefUpdate[]): Promise<NewObject[]> {
  const out: NewObject[] = []
  const seen = new Set<string>()
  const stack = updates.flatMap((u) => (u.new ? [u.new] : []))
  while (stack.length) {
    const hash = stack.pop()!
    if (seen.has(hash)) continue
    seen.add(hash)
    const o = repo.mem.get(hash)
    if (!o) continue
    out.push({ hash, ...o })
    if (o.type === 'commit') {
      const c = await repo.commit(hash)
      stack.push(...c.parents, c.tree)
    } else if (o.type === 'tag') {
      stack.push((await repo.tag(hash)).object)
    } else if (o.type === 'tree') {
      for (const e of parseTree(o.data, repo.hashLen)) if (e.mode !== '160000') stack.push(e.hash)
    }
  }
  return out
}

const tzOffset = () => {
  const m = -new Date().getTimezoneOffset()
  const a = Math.abs(m)
  return `${m < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`
}

// Writes the new objects and moves the refs, with reflog entries so `git reflog` can undo it.
// Refs are checked first: if something changed them on disk since opening, nothing is written.
export async function writeToRepo(
  repo: Repo,
  base: RefState,
  cur: RefState,
  who: { name: string; email: string },
  note: string,
): Promise<RefUpdate[]> {
  const fs = repo.fs
  if (!fs.write) throw new Error('這個來源不能寫入')
  const write = fs.write.bind(fs)
  const updates = refUpdates(base, cur)
  for (const u of updates) {
    if ((await repo.refOnDisk(u.name)) !== u.old) {
      throw new Error(`「${shortRef(u.name)}」在開啟之後被改過了（例如在終端機又 commit 過）。請重新開啟 repo 再改。`)
    }
  }
  const objects = await newObjects(repo, updates)
  for (const o of objects) {
    const path = `objects/${o.hash.slice(0, 2)}/${o.hash.slice(2)}`
    if (await fs.file(path)) continue
    await write(path, zlibSync(concat([enc.encode(`${o.type} ${o.data.length}\0`), o.data])))
  }

  const zero = '0'.repeat(repo.hashLen * 2)
  const ident = repo.identity() ?? who
  const stamp = `${ident.name} <${ident.email}> ${Math.floor(Date.now() / 1000)} ${tzOffset()}`
  const logs = !!(await fs.list('logs'))
  const log = async (path: string, u: RefUpdate) => {
    if (logs) await write(path, enc.encode(`${u.old ?? zero} ${u.new} ${stamp}\tgiteditor: ${note}\n`), true)
  }
  if (base.head.hash && cur.head.hash !== base.head.hash) await write('ORIG_HEAD', enc.encode(`${base.head.hash}\n`))
  for (const u of updates) {
    if (!u.new) {
      await deleteRef(repo, u.name)
      continue
    }
    await write(u.name, enc.encode(`${u.new}\n`))
    await log(`logs/${u.name}`, u)
    if (u.name !== 'HEAD' && u.name === base.head.ref) await log('logs/HEAD', u)
  }
  for (const o of objects) repo.mem.delete(o.hash)
  for (const u of updates) {
    if (u.name === 'HEAD') continue
    if (u.new) repo.refs.set(u.name, u.new)
    else repo.refs.delete(u.name)
  }
  repo.head = { ...cur.head }
  return updates
}

// A ref may be a loose file, a line in packed-refs (with a ^peeled line after it), or both.
async function deleteRef(repo: Repo, name: string) {
  const fs = repo.fs
  await fs.remove!(name)
  await fs.remove!(`logs/${name}`)
  const packed = await fs.file('packed-refs')
  if (!packed) return
  const lines = (await packed.text()).split('\n')
  const at = lines.findIndex((l) => l.endsWith(` ${name}`) && !l.startsWith('#'))
  if (at < 0) return
  lines.splice(at, lines[at + 1]?.startsWith('^') ? 2 : 1)
  await fs.write!('packed-refs', enc.encode(lines.join('\n')))
}

// Files that change in the repo's checked-out commit: the repo's index and working tree still have
// the old versions after writing, so `git status` would show the edits reversed until these are
// restored.
export async function staleFiles(repo: Repo, base: RefState, cur: RefState): Promise<string[]> {
  const from = base.head.hash
  const to = cur.head.ref ? cur.refs.get(cur.head.ref) : cur.head.hash
  if (!from || !to || from === to) return []
  const [a, b] = await Promise.all([repo.commit(from), repo.commit(to)])
  return (await diffTrees(repo, a.tree, b.tree)).map((c) => binToText(c.path))
}

const shellQuote = (s: string) => (/^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)
export const restoreCommand = (paths: string[]) => `git restore --source=HEAD --staged --worktree -- ${paths.map(shellQuote).join(' ')}`

// ---------- bundle: for browsers that can't write to the folder ----------
async function pack(algo: HashAlgo, objects: NewObject[]): Promise<Uint8Array> {
  const head = new Uint8Array(12)
  head.set(enc.encode('PACK'))
  new DataView(head.buffer).setUint32(4, 2)
  new DataView(head.buffer).setUint32(8, objects.length)
  const parts: Uint8Array[] = [head]
  for (const o of objects) {
    const h: number[] = []
    let size = o.data.length
    let b = (PACK_CODES[o.type] << 4) | (size & 15)
    size = Math.floor(size / 16)
    while (size > 0) {
      h.push(b | 0x80)
      b = size & 0x7f
      size = Math.floor(size / 128)
    }
    h.push(b)
    parts.push(Uint8Array.from(h), zlibSync(o.data))
  }
  const body = concat(parts)
  return concat([body, await digest(algo, body)])
}

// A bundle holding just the new objects. Its prerequisites are the refs' old commits, which the repo
// has, so git checks everything is connected when unbundling. The refs are then moved with
// update-ref, which refuses if a ref is no longer at its old value and writes the reflog.
export async function makeBundle(repo: Repo, base: RefState, cur: RefState, fileName: string, note: string) {
  const updates = refUpdates(base, cur)
  const moved = updates.filter((u) => u.new)
  const prereqs = new Set<string>()
  for (const u of moved) {
    if (!u.old) continue
    const p = await repo.peel(u.old)
    if (p.type === 'commit') prereqs.add(p.hash)
  }
  const objects = await newObjects(repo, updates)
  const header =
    (repo.algo === 'sha256' ? '# v3 git bundle\n@object-format=sha256\n' : '# v2 git bundle\n') +
    [...prereqs].map((h) => `-${h}\n`).join('') +
    moved.map((u) => `${u.new} ${u.name}\n`).join('') +
    '\n'
  // Only deleting refs: nothing to carry over, just the commands.
  const data = moved.length ? concat([enc.encode(header), await pack(repo.algo, objects)]) : null
  const commands = [
    ...(data ? [`git bundle unbundle ${fileName}`] : []),
    ...updates.map((u) =>
      u.new
        ? `git update-ref -m "giteditor: ${note}"${u.name === 'HEAD' ? ' --no-deref' : ''} ${u.name} ${u.new} ${u.old ?? ''}`.trimEnd()
        : `git update-ref -d ${u.name} ${u.old}`,
    ),
  ]
  const stale = await staleFiles(repo, base, cur)
  if (stale.length) commands.push(restoreCommand(stale))
  return { data, commands }
}
