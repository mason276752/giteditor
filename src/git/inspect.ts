import { unzlibSync } from 'fflate'
import { decoder, hex, toBin } from './bytes'
import { parseTree } from './objects'
import type { Repo } from './repo'

// What the .git browser shows for a file: a one-line summary, plus either readable text (decoded
// binary formats) or the bytes to show as they are.
export interface Inspection {
  summary: string
  text?: string
  data?: Uint8Array
  name?: string
}

const MODE_NAMES: Record<string, string> = { '40000': 'tree', '160000': 'commit', '120000': 'link' }

export function inspect(repo: Repo, path: string, data: Uint8Array): Inspection {
  const name = path.split('/').pop()!
  const n = repo.hashLen
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  if (/^objects\/[0-9a-f]{2}\/[0-9a-f]{38}([0-9a-f]{24})?$/.test(path)) {
    const raw = unzlibSync(data)
    const nul = raw.indexOf(0)
    const [type, size] = toBin(raw.subarray(0, nul)).split(' ')
    const body = raw.subarray(nul + 1)
    const summary = `${type} 物件 ${path.slice(8, 10)}${path.slice(11)}（壓縮前 ${Number(size).toLocaleString()} bytes）`
    if (type === 'tree') {
      const text = parseTree(body, n).map((e) => `${e.mode.padStart(6, '0')} ${MODE_NAMES[e.mode] ?? 'blob'} ${e.hash}  ${e.name}`).join('\n')
      return { summary, text }
    }
    if (type === 'blob') return { summary, data: body, name: 'blob' }
    return { summary, text: decoder().decode(body) }
  }

  if (path.startsWith('objects/pack/') && name.endsWith('.idx')) {
    const v2 = view.getUint32(0) === 0xff744f63
    const count = view.getUint32((v2 ? 8 : 0) + 255 * 4)
    return { summary: `pack 索引（第 ${v2 ? view.getUint32(4) : 1} 版），${count.toLocaleString()} 個物件` }
  }

  if (path.startsWith('objects/pack/') && name.endsWith('.pack') && toBin(data.subarray(0, 4)) === 'PACK') {
    return { summary: `packfile（第 ${view.getUint32(4)} 版），${view.getUint32(8).toLocaleString()} 個物件，壓縮存放` }
  }

  if (path === 'index' && toBin(data.subarray(0, 4)) === 'DIRC') {
    const version = view.getUint32(4)
    const count = view.getUint32(8)
    const summary = `暫存區（index，第 ${version} 版），${count.toLocaleString()} 個檔案`
    if (version > 3) return { summary }
    const lines: string[] = []
    let o = 12
    for (let i = 0; i < count && o < data.length; i++) {
      const mode = view.getUint32(o + 24)
      const flags = view.getUint16(o + 40 + n)
      let p = o + 42 + n
      if (version === 3 && flags & 0x4000) p += 2
      const nul = data.indexOf(0, p)
      lines.push(`${mode.toString(8)} ${hex(data.subarray(o + 40, o + 40 + n))}  ${decoder().decode(data.subarray(p, nul))}`)
      // Entries are NUL-padded to a multiple of 8 bytes.
      o += (nul - o + 8) & ~7
    }
    return { summary, text: lines.join('\n') }
  }

  return { summary: '', data, name }
}
