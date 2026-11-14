import { zlibSync } from 'fflate'
import { concat, digest, enc, type HashAlgo } from './bytes'
import type { RefState } from './history'
import { shortRef } from './history'
import type { ObjType } from './objects'
import { PACK_CODES, type Repo } from './repo'

export interface RefUpdate {
  name: string // 'HEAD' when HEAD is detached
  old: string | null
  new: string
}

export function refUpdates(base: RefState, cur: RefState): RefUpdate[] {
  const out: RefUpdate[] = []
  for (const [name, hash] of cur.refs) {
    const old = base.refs.get(name) ?? null
    if (old !== hash) out.push({ name, old, new: hash })
  }
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
  const stack = updates.map((u) => u.new)
  while (stack.length) {
    const hash = stack.pop()!
    if (seen.has(hash)) continue
    seen.add(hash)
    const o = repo.mem.get(hash)
    if (!o) continue
    out.push({ hash, ...o })
    if (o.type === 'commit') stack.push(...(await repo.commit(hash)).parents)
    else if (o.type === 'tag') stack.push((await repo.tag(hash)).object)
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
    await write(u.name, enc.encode(`${u.new}\n`))
    await log(`logs/${u.name}`, u)
    if (u.name !== 'HEAD' && u.name === base.head.ref) await log('logs/HEAD', u)
  }
  for (const o of objects) repo.mem.delete(o.hash)
  for (const u of updates) if (u.name !== 'HEAD') repo.refs.set(u.name, u.new)
  repo.head = { ...cur.head }
  return updates
}

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
  const prereqs = new Set<string>()
  for (const u of updates) {
    if (!u.old) continue
    const p = await repo.peel(u.old)
    if (p.type === 'commit') prereqs.add(p.hash)
  }
  const header =
    (repo.algo === 'sha256' ? '# v3 git bundle\n@object-format=sha256\n' : '# v2 git bundle\n') +
    [...prereqs].map((h) => `-${h}\n`).join('') +
    updates.map((u) => `${u.new} ${u.name}\n`).join('') +
    '\n'
  const data = concat([enc.encode(header), await pack(repo.algo, await newObjects(repo, updates))])
  const commands = [
    `git bundle unbundle ${fileName}`,
    ...updates.map(
      (u) => `git update-ref -m "giteditor: ${note}"${u.name === 'HEAD' ? ' --no-deref' : ''} ${u.name} ${u.new} ${u.old ?? ''}`.trimEnd(),
    ),
  ]
  return { data, commands }
}
