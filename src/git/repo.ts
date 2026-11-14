import { unzlibSync } from 'fflate'
import { concat, digest, enc, hex, toBin, unhex, type HashAlgo } from './bytes'
import { readBytes, readText, type GitFs } from './fs'
import { parseCommit, parseTag, type Commit, type ObjType, type Tag } from './objects'

export interface GitObject {
  type: ObjType
  data: Uint8Array
}

export class MissingObjectError extends Error {
  constructor(public hash: string) {
    super(`找不到物件 ${hash}`)
  }
}

// HEAD is either a branch (`ref`) or a commit on its own (detached).
export interface Head {
  ref: string | null
  hash: string | null
}

const TYPES: ObjType[] = ['commit', 'tree', 'blob', 'tag']
const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' }
export const PACK_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 }

// ---------- config ----------
// Just enough of git-config: `section.sub.key` (section and key lower-cased) → last value.
export function parseConfig(text: string): Map<string, string> {
  const out = new Map<string, string>()
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)[#;].*$/, '').trim()
    const sec = line.match(/^\[\s*([^\s\]"]+)(?:\s+"(.*)")?\s*\]$/)
    if (sec) {
      section = sec[1].toLowerCase() + (sec[2] !== undefined ? `.${sec[2]}` : '')
      continue
    }
    const kv = line.match(/^([A-Za-z][\w-]*)\s*(?:=\s*(.*))?$/)
    if (kv && section) out.set(`${section}.${kv[1].toLowerCase()}`, (kv[2] ?? 'true').replace(/^"(.*)"$/, '$1'))
  }
  return out
}

// ---------- packs ----------
const WINDOW = 8 << 20

class Pack {
  private windows = new Map<number, Promise<Uint8Array>>()
  private cache = new Map<number, GitObject>()
  private cacheBytes = 0
  private ends: number[] // object offsets, ascending, then where the object data ends

  constructor(
    private repo: Repo,
    readonly name: string,
    private blob: Blob,
    private hashes: Uint8Array,
    private offsets: number[],
    private fanout: Uint32Array,
  ) {
    this.ends = [...offsets].sort((a, b) => a - b)
    this.ends.push(blob.size - repo.hashLen)
  }

  get count() {
    return this.offsets.length
  }

  static async open(repo: Repo, name: string): Promise<Pack | null> {
    const [idx, blob] = await Promise.all([
      readBytes(repo.fs, `objects/pack/${name}.idx`),
      repo.fs.file(`objects/pack/${name}.pack`),
    ])
    if (!idx || !blob) return null
    const v = new DataView(idx.buffer, idx.byteOffset, idx.byteLength)
    const n = repo.hashLen
    const v2 = v.getUint32(0) === 0xff744f63
    const fanAt = v2 ? 8 : 0
    const fanout = new Uint32Array(256)
    for (let i = 0; i < 256; i++) fanout[i] = v.getUint32(fanAt + i * 4)
    const count = fanout[255]
    const hashes = new Uint8Array(count * n)
    const offsets: number[] = new Array(count)
    if (v2) {
      const hashAt = fanAt + 1024
      hashes.set(idx.subarray(hashAt, hashAt + count * n))
      const offAt = hashAt + count * n + count * 4
      const bigAt = offAt + count * 4
      for (let i = 0; i < count; i++) {
        const o = v.getUint32(offAt + i * 4)
        // MSB set: index into the table of 64-bit offsets (packs over 2 GB).
        offsets[i] = o & 0x80000000 ? Number(v.getBigUint64(bigAt + (o & 0x7fffffff) * 8)) : o
      }
    } else {
      for (let i = 0; i < count; i++) {
        const at = fanAt + 1024 + i * (4 + n)
        offsets[i] = v.getUint32(at)
        hashes.set(idx.subarray(at + 4, at + 4 + n), i * n)
      }
    }
    return new Pack(repo, name, blob, hashes, offsets, fanout)
  }

  find(hash: Uint8Array): number {
    const n = this.repo.hashLen
    let lo = hash[0] ? this.fanout[hash[0] - 1] : 0
    let hi = this.fanout[hash[0]]
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      let cmp = 0
      for (let i = 0; i < n && !cmp; i++) cmp = this.hashes[mid * n + i] - hash[i]
      if (!cmp) return this.offsets[mid]
      if (cmp < 0) lo = mid + 1
      else hi = mid
    }
    return -1
  }

  private async bytes(start: number, end: number): Promise<Uint8Array> {
    const ws = Math.floor(start / WINDOW) * WINDOW
    if (end > ws + WINDOW) return new Uint8Array(await this.blob.slice(start, end).arrayBuffer())
    let w = this.windows.get(ws)
    if (w) {
      this.windows.delete(ws)
    } else {
      w = this.blob.slice(ws, ws + WINDOW).arrayBuffer().then((b) => new Uint8Array(b))
      if (this.windows.size >= 24) this.windows.delete(this.windows.keys().next().value!)
    }
    this.windows.set(ws, w)
    return (await w).subarray(start - ws, end - ws)
  }

  private endOf(offset: number) {
    let lo = 0
    let hi = this.ends.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.ends[mid] <= offset) lo = mid + 1
      else hi = mid
    }
    return this.ends[lo]
  }

  async read(offset: number): Promise<GitObject> {
    const hit = this.cache.get(offset)
    if (hit) return hit
    const buf = await this.bytes(offset, this.endOf(offset))
    let i = 0
    let c = buf[i++]
    const code = (c >> 4) & 7
    let size = c & 15
    let shift = 4
    while (c & 0x80) {
      c = buf[i++]
      size += (c & 0x7f) * 2 ** shift
      shift += 7
    }
    let base: GitObject | null = null
    if (code === 6) {
      // OFS_DELTA: the base sits this many bytes earlier in the same pack.
      c = buf[i++]
      let back = c & 0x7f
      while (c & 0x80) {
        c = buf[i++]
        back = (back + 1) * 128 + (c & 0x7f)
      }
      base = await this.read(offset - back)
    } else if (code === 7) {
      // REF_DELTA: the base is named by hash and may be anywhere.
      base = await this.repo.read(hex(buf.subarray(i, i + this.repo.hashLen)))
      i += this.repo.hashLen
    }
    const data = unzlibSync(buf.subarray(i), { out: new Uint8Array(size) })
    const obj = base ? { type: base.type, data: applyDelta(base.data, data) } : { type: PACK_TYPES[code], data }
    if (!obj.type) throw new Error(`無法辨識的 pack 物件類型 ${code}`)
    // Keep recent objects: they're the bases of the deltas that follow.
    this.cache.set(offset, obj)
    this.cacheBytes += obj.data.length
    while (this.cacheBytes > 48 << 20 && this.cache.size > 1) {
      const [k, v] = this.cache.entries().next().value!
      this.cache.delete(k)
      this.cacheBytes -= v.data.length
    }
    return obj
  }
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let i = 0
  const varint = () => {
    let n = 0
    let shift = 0
    let c
    do {
      c = delta[i++]
      n += (c & 0x7f) * 2 ** shift
      shift += 7
    } while (c & 0x80)
    return n
  }
  varint() // base size
  const out = new Uint8Array(varint())
  let o = 0
  while (i < delta.length) {
    const op = delta[i++]
    if (op & 0x80) {
      let off = 0
      let len = 0
      for (let b = 0; b < 4; b++) if (op & (1 << b)) off += delta[i++] * 2 ** (8 * b)
      for (let b = 0; b < 3; b++) if (op & (16 << b)) len += delta[i++] << (8 * b)
      out.set(base.subarray(off, off + (len || 0x10000)), o)
      o += len || 0x10000
    } else if (op) {
      out.set(delta.subarray(i, i + op), o)
      i += op
      o += op
    } else {
      throw new Error('delta 資料損壞')
    }
  }
  return out
}

// ---------- the repository ----------
export class Repo {
  algo: HashAlgo = 'sha1'
  hashLen = 20
  config = new Map<string, string>()
  refs = new Map<string, string>() // as on disk when opened (or last written): full name → hash
  symrefs = new Map<string, string>() // refs/remotes/origin/HEAD → refs/remotes/origin/main
  head: Head = { ref: null, hash: null }
  shallow = new Set<string>()
  packs: Pack[] = []
  mem = new Map<string, GitObject>() // objects made here and not yet on disk
  private commits = new Map<string, Commit>()
  private tags = new Map<string, Tag>()

  private constructor(readonly fs: GitFs) {}

  static async open(fs: GitFs): Promise<Repo> {
    const r = new Repo(fs)
    r.config = parseConfig((await readText(fs, 'config')) ?? '')
    if (r.config.get('extensions.objectformat')?.toLowerCase() === 'sha256') {
      r.algo = 'sha256'
      r.hashLen = 32
    }
    if (r.config.get('extensions.refstorage')?.toLowerCase() === 'reftable') {
      throw new Error('這個 repo 用 reftable 格式存放分支，目前還不支援。')
    }
    const names = ((await fs.list('objects/pack')) ?? [])
      .filter((e) => !e.dir && e.name.endsWith('.idx'))
      .map((e) => e.name.slice(0, -4))
    r.packs = (await Promise.all(names.map((n) => Pack.open(r, n)))).filter((p): p is Pack => !!p)
    for (const line of ((await readText(fs, 'shallow')) ?? '').split('\n')) if (line.trim()) r.shallow.add(line.trim())
    await r.loadRefs()
    return r
  }

  get writable() {
    return !!this.fs.write
  }

  async loadRefs() {
    this.refs.clear()
    this.symrefs.clear()
    for (const line of ((await readText(this.fs, 'packed-refs')) ?? '').split('\n')) {
      const m = line.match(/^([0-9a-f]{40,64}) (refs\/\S+)$/)
      if (m) this.refs.set(m[2], m[1])
    }
    const walk = async (dir: string): Promise<void> => {
      const entries = (await this.fs.list(dir)) ?? []
      await Promise.all(
        entries.map(async (e) => {
          const path = `${dir}/${e.name}`
          if (e.dir) return walk(path)
          if (e.name.endsWith('.lock')) return
          const text = ((await readText(this.fs, path)) ?? '').trim()
          if (text.startsWith('ref: ')) this.symrefs.set(path, text.slice(5))
          else if (/^[0-9a-f]{40,64}$/.test(text)) this.refs.set(path, text)
        }),
      )
    }
    await walk('refs')
    const head = ((await readText(this.fs, 'HEAD')) ?? '').trim()
    this.head = head.startsWith('ref: ') ? { ref: head.slice(5), hash: null } : { ref: null, hash: head || null }
    if (this.head.ref) this.head.hash = this.refs.get(this.head.ref) ?? null
  }

  // The ref's value as it is on disk right now (not what was read when opening).
  async refOnDisk(name: string): Promise<string | null> {
    const loose = ((await readText(this.fs, name)) ?? '').trim()
    if (name === 'HEAD' && loose.startsWith('ref: ')) return null
    if (loose) return loose
    for (const line of ((await readText(this.fs, 'packed-refs')) ?? '').split('\n')) {
      if (line.endsWith(` ${name}`)) return line.slice(0, line.indexOf(' '))
    }
    return null
  }

  async read(hash: string): Promise<GitObject> {
    const m = this.mem.get(hash)
    if (m) return m
    const loose = await readBytes(this.fs, `objects/${hash.slice(0, 2)}/${hash.slice(2)}`)
    if (loose) {
      const raw = unzlibSync(loose)
      const nul = raw.indexOf(0)
      const [type] = toBin(raw.subarray(0, nul)).split(' ')
      if (!TYPES.includes(type as ObjType)) throw new Error(`物件 ${hash} 的類型無法辨識`)
      return { type: type as ObjType, data: raw.subarray(nul + 1) }
    }
    const bin = unhex(hash)
    for (const p of this.packs) {
      const at = p.find(bin)
      if (at >= 0) return p.read(at)
    }
    throw new MissingObjectError(hash)
  }

  async commit(hash: string): Promise<Commit> {
    let c = this.commits.get(hash)
    if (!c) {
      const o = await this.read(hash)
      if (o.type !== 'commit') throw new Error(`${hash} 不是 commit（是 ${o.type}）`)
      c = parseCommit(hash, o.data)
      this.commits.set(hash, c)
    }
    return c
  }

  cachedCommit(hash: string) {
    return this.commits.get(hash)
  }

  async tag(hash: string): Promise<Tag> {
    let t = this.tags.get(hash)
    if (!t) {
      const o = await this.read(hash)
      if (o.type !== 'tag') throw new Error(`${hash} 不是 tag（是 ${o.type}）`)
      t = parseTag(hash, o.data)
      this.tags.set(hash, t)
    }
    return t
  }

  async typeOf(hash: string): Promise<ObjType> {
    if (this.commits.has(hash)) return 'commit'
    if (this.tags.has(hash)) return 'tag'
    return (await this.read(hash)).type
  }

  // Follows annotated tags down to what they finally point at.
  async peel(hash: string): Promise<{ hash: string; type: ObjType }> {
    for (let i = 0; i < 16; i++) {
      const type = await this.typeOf(hash)
      if (type !== 'tag') return { hash, type }
      hash = (await this.tag(hash)).object
    }
    throw new Error('標籤串太長')
  }

  async hashObject(type: ObjType, data: Uint8Array): Promise<string> {
    return hex(await digest(this.algo, concat([enc.encode(`${type} ${data.length}\0`), data])))
  }

  // Stores a new object in memory (written out later) and returns its hash.
  async add(type: ObjType, data: Uint8Array): Promise<string> {
    const hash = await this.hashObject(type, data)
    if (!this.mem.has(hash)) this.mem.set(hash, { type, data })
    return hash
  }

  identity(): { name: string; email: string } | null {
    const name = this.config.get('user.name')
    const email = this.config.get('user.email')
    return name && email ? { name, email } : null
  }
}
