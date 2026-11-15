// Where a .git directory's files come from. Paths are relative to the .git directory, '/'-separated.
export interface GitFs {
  file(path: string): Promise<Blob | null>
  list(path: string): Promise<DirEntry[] | null>
  // Only sources that can write back (a directory handle in Chromium) have these.
  write?(path: string, data: Uint8Array, append?: boolean): Promise<void>
  remove?(path: string): Promise<void>
  // Asks for permission to write; must be called from a click.
  requestWrite?(): Promise<boolean>
}

export interface DirEntry {
  name: string
  dir: boolean
}

export async function readBytes(fs: GitFs, path: string): Promise<Uint8Array | null> {
  const f = await fs.file(path)
  return f && new Uint8Array(await f.arrayBuffer())
}

export async function readText(fs: GitFs, path: string): Promise<string | null> {
  const f = await fs.file(path)
  return f && f.text()
}

const parts = (path: string) => path.split('/').filter(Boolean)

// ---------- File System Access API (Chromium): reads, and writes after asking ----------
interface PermissionHandle {
  queryPermission(d: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission(d: { mode: 'readwrite' }): Promise<PermissionState>
}

export function handleFs(root: FileSystemDirectoryHandle): GitFs {
  async function dir(segs: string[], create = false) {
    let d = root
    for (const s of segs) d = await d.getDirectoryHandle(s, { create })
    return d
  }
  return {
    async file(path) {
      const segs = parts(path)
      try {
        const d = await dir(segs.slice(0, -1))
        return await (await d.getFileHandle(segs.at(-1)!)).getFile()
      } catch {
        return null
      }
    },
    async list(path) {
      try {
        const d = await dir(parts(path))
        const out: DirEntry[] = []
        for await (const [name, h] of d.entries()) out.push({ name, dir: h.kind === 'directory' })
        return out
      } catch {
        return null
      }
    },
    async write(path, data, append = false) {
      const segs = parts(path)
      const d = await dir(segs.slice(0, -1), true)
      const fh = await d.getFileHandle(segs.at(-1)!, { create: true })
      const w = await fh.createWritable({ keepExistingData: append })
      if (append) await w.seek((await fh.getFile()).size)
      await w.write(data as Uint8Array<ArrayBuffer>)
      await w.close()
    },
    async remove(path) {
      const segs = parts(path)
      try {
        await (await dir(segs.slice(0, -1))).removeEntry(segs.at(-1)!)
      } catch (e) {
        if ((e as DOMException).name !== 'NotFoundError') throw e
      }
    },
    async requestWrite() {
      const h = root as unknown as PermissionHandle
      if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true
      return (await h.requestPermission({ mode: 'readwrite' })) === 'granted'
    },
  }
}

// ---------- a dropped folder (FileSystemEntry): read-only, but reads files on demand ----------
export function entryFs(root: FileSystemDirectoryEntry): GitFs {
  const getDir = (path: string) =>
    new Promise<FileSystemDirectoryEntry | null>((res) => {
      if (!parts(path).length) return res(root)
      root.getDirectory(path, {}, (e) => res(e as FileSystemDirectoryEntry), () => res(null))
    })
  return {
    file: (path) =>
      new Promise((res) => {
        root.getFile(path, {}, (e) => (e as FileSystemFileEntry).file(res, () => res(null)), () => res(null))
      }),
    async list(path) {
      const d = await getDir(path)
      if (!d) return null
      const reader = d.createReader()
      const out: DirEntry[] = []
      for (;;) {
        // readEntries hands out batches until it returns none.
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) return out
        for (const e of batch) out.push({ name: e.name, dir: e.isDirectory })
      }
    },
  }
}

// ---------- <input webkitdirectory>: every file is listed up front ----------
export function filesFs(files: Map<string, File>): GitFs {
  const dirs = new Map<string, Map<string, boolean>>()
  for (const path of files.keys()) {
    const segs = parts(path)
    for (let i = 0; i < segs.length; i++) {
      const parent = segs.slice(0, i).join('/')
      if (!dirs.has(parent)) dirs.set(parent, new Map())
      dirs.get(parent)!.set(segs[i], i < segs.length - 1)
    }
  }
  return {
    file: async (path) => files.get(parts(path).join('/')) ?? null,
    async list(path) {
      const d = dirs.get(parts(path).join('/'))
      return d ? [...d].map(([name, dir]) => ({ name, dir })) : null
    },
  }
}

// The same source seen from a subfolder.
export function subFs(fs: GitFs, prefix: string): GitFs {
  const p = (path: string) => (path ? `${prefix}/${path}` : prefix)
  return {
    file: (path) => fs.file(p(path)),
    list: (path) => fs.list(p(path)),
    write: fs.write && ((path, data, append) => fs.write!(p(path), data, append)),
    remove: fs.remove && ((path) => fs.remove!(p(path))),
    requestWrite: fs.requestWrite,
  }
}

// Picked or dropped files are snapshots in browsers without directory handles: once git changes
// them on disk (applying a bundle, say) they can't be read any more.
export function readError(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotReadableError') return '檔案在開啟之後被改過了（例如剛執行過 git 指令），請重新開啟 repo。'
  return e instanceof Error ? e.message : String(e)
}

// The picked folder may be the .git directory itself (or a bare repo), or a working tree holding one.
export async function findGitDir(fs: GitFs): Promise<{ fs: GitFs; inside: boolean }> {
  const isGitDir = async (f: GitFs) => !!(await f.file('HEAD')) && !!(await f.list('objects'))
  if (await isGitDir(fs)) return { fs, inside: false }
  const git = subFs(fs, '.git')
  if (await isGitDir(git)) return { fs: git, inside: true }
  const pointer = await readText(fs, '.git')
  if (pointer?.startsWith('gitdir:')) {
    throw new Error(
      `這個資料夾是 worktree 或 submodule，.git 只是指向「${pointer.slice(7).trim()}」的檔案。請改開那個資料夾。`,
    )
  }
  throw new Error('這裡找不到 .git：請選 repo 的資料夾，或裡面的 .git 資料夾。')
}
