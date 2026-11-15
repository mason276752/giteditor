import { binToText, decoder, hex, isUtf8Label, textToBin, toBin } from './bytes'

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag'

export interface Person {
  name: string
  email: string
  time: number // seconds since the epoch
  tz: string // '+0800'
}

export type SigKind = 'pgp' | 'ssh' | 'x509' | 'other'

// One header of a commit or tag; continuation lines are joined with '\n'. Binary strings.
// `raw` is the header as stored, so headers left alone are written back byte for byte.
interface Header {
  key: string
  value: string
  raw?: string
}

export interface Commit {
  hash: string
  tree: string
  parents: string[]
  author: Person
  committer: Person
  message: string
  encoding: string | null
  sig: SigKind | null
  headers: Header[]
  body: string // the message as stored (binary string)
}

export interface Tag {
  hash: string
  object: string
  type: string
  name: string
  tagger: Person | null
  message: string
  sig: SigKind | null
  headers: Header[]
  body: string // message plus signature, as stored
  sigAt: number // where the signature starts in body (body.length if unsigned)
}

export interface TreeEntry {
  mode: string
  name: string // for showing
  raw: string // as stored (binary string), for rebuilding the tree
  hash: string
}

export const SIG_HEADERS = ['gpgsig', 'gpgsig-sha256']
const SIG_STARTS: [string, SigKind][] = [
  ['-----BEGIN PGP SIGNATURE-----', 'pgp'],
  ['-----BEGIN PGP MESSAGE-----', 'pgp'],
  ['-----BEGIN SSH SIGNATURE-----', 'ssh'],
  ['-----BEGIN SIGNED MESSAGE-----', 'x509'],
]
const sigKind = (armor: string): SigKind => SIG_STARTS.find(([s]) => armor.startsWith(s))?.[1] ?? 'other'

function splitObject(s: string): { headers: Header[]; body: string } {
  const eoh = s.indexOf('\n\n')
  const head = eoh < 0 ? s : s.slice(0, eoh)
  const headers: Header[] = []
  for (const line of head.split('\n')) {
    const last = headers.at(-1)
    if (line.startsWith(' ') && last) {
      last.value += `\n${line.slice(1)}`
      last.raw += `\n${line}`
      continue
    }
    const sp = line.indexOf(' ')
    headers.push(sp < 0 ? { key: line, value: '', raw: line } : { key: line.slice(0, sp), value: line.slice(sp + 1), raw: line })
  }
  return { headers, body: eoh < 0 ? '' : s.slice(eoh + 2) }
}

const joinObject = (headers: Header[], body: string) =>
  `${headers.map((h) => h.raw ?? `${h.key} ${h.value.replace(/\n/g, '\n ')}`).join('\n')}\n\n${body}`

// "Name <email> 1700000000 +0800", tolerating the odd malformed lines found in old repos.
export function parsePerson(s: string): Person {
  const lt = s.lastIndexOf('<')
  const gt = s.indexOf('>', lt)
  if (lt < 0 || gt < 0) return { name: s.trim(), email: '', time: 0, tz: '+0000' }
  const [time, tz] = s.slice(gt + 1).trim().split(/\s+/)
  return {
    name: s.slice(0, lt).trim(),
    email: s.slice(lt + 1, gt),
    time: Number(time) || 0,
    tz: /^[+-]\d{4}$/.test(tz ?? '') ? tz : '+0000',
  }
}

export const formatPerson = (p: Person) => `${p.name} <${p.email}> ${p.time} ${p.tz}`

export function parseCommit(hash: string, data: Uint8Array): Commit {
  const { headers, body } = splitObject(toBin(data))
  const get = (k: string) => headers.find((h) => h.key === k)?.value
  const encoding = get('encoding') ?? null
  const label = encoding ?? undefined
  const sigHeader = headers.find((h) => SIG_HEADERS.includes(h.key))
  return {
    hash,
    tree: get('tree') ?? '',
    parents: headers.filter((h) => h.key === 'parent').map((h) => h.value),
    author: parsePerson(binToText(get('author') ?? '', label)),
    committer: parsePerson(binToText(get('committer') ?? '', label)),
    message: binToText(body, label),
    encoding,
    sig: sigHeader ? sigKind(sigHeader.value) : null,
    headers,
    body,
  }
}

export function parseTag(hash: string, data: Uint8Array): Tag {
  const { headers, body } = splitObject(toBin(data))
  const get = (k: string) => headers.find((h) => h.key === k)?.value
  // Like git: the signature starts at the last line that looks like the start of one.
  let sigAt = body.length
  let sig: SigKind | null = null
  for (let i = 0; i < body.length; ) {
    const k = SIG_STARTS.find(([s]) => body.startsWith(s, i))
    if (k) {
      sigAt = i
      sig = k[1]
    }
    const nl = body.indexOf('\n', i)
    i = nl < 0 ? body.length : nl + 1
  }
  const tagger = get('tagger')
  return {
    hash,
    object: get('object') ?? '',
    type: get('type') ?? '',
    name: binToText(get('tag') ?? ''),
    tagger: tagger ? parsePerson(binToText(tagger)) : null,
    message: binToText(body.slice(0, sigAt)),
    sig,
    headers,
    body,
    sigAt,
  }
}

export function parseTree(data: Uint8Array, hashLen: number): TreeEntry[] {
  const out: TreeEntry[] = []
  let i = 0
  while (i < data.length) {
    const sp = data.indexOf(0x20, i)
    const nul = data.indexOf(0, sp)
    out.push({
      mode: toBin(data.subarray(i, sp)),
      name: decoder().decode(data.subarray(sp + 1, nul)),
      raw: toBin(data.subarray(sp + 1, nul)),
      hash: hex(data.subarray(nul + 1, nul + 1 + hashLen)),
    })
    i = nul + 1 + hashLen
  }
  return out
}

// ---------- rewriting ----------
export interface CommitEdit {
  tree?: string
  author?: Person
  committer?: Person
  message?: string
}

// How git stores a message typed in an editor: no trailing blank lines, ending in one newline.
export const cleanMessage = (m: string) => {
  const t = m.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  return t ? `${t}\n` : ''
}

// The commit with new parents and the edit applied, unsigned (any old signature no longer matches).
// Untouched headers keep their exact bytes. A commit in a legacy encoding (Big5…) that gets edited
// is stored as UTF-8 from then on, since the new text is UTF-8.
export function commitPayload(c: Commit, parents: string[], edit: CommitEdit = {}): string {
  const edited = edit.author || edit.committer || edit.message !== undefined
  const reencode = edited && !!c.encoding && !isUtf8Label(c.encoding)
  const headers: Header[] = []
  const parentHeaders = parents.map((p) => ({ key: 'parent', value: p }))
  let placedParents = false
  for (const h of c.headers) {
    if (h.key === 'parent' || SIG_HEADERS.includes(h.key) || (reencode && h.key === 'encoding')) continue
    if (h.key === 'tree' && edit.tree) {
      headers.push({ key: 'tree', value: edit.tree })
    } else if (h.key === 'author' && (edit.author || reencode)) {
      headers.push({ key: 'author', value: textToBin(formatPerson(edit.author ?? c.author)) })
    } else if (h.key === 'committer' && (edit.committer || reencode)) {
      headers.push({ key: 'committer', value: textToBin(formatPerson(edit.committer ?? c.committer)) })
    } else {
      headers.push(h)
    }
    if (h.key === 'tree') {
      headers.push(...parentHeaders)
      placedParents = true
    }
  }
  if (!placedParents) headers.unshift(...parentHeaders)
  const body = edit.message !== undefined ? textToBin(cleanMessage(edit.message)) : reencode ? textToBin(c.message) : c.body
  return joinObject(headers, body)
}

// Puts the signature in as the last header, the way `git commit -S` does.
export function insertCommitSig(payload: string, header: string, armor: string): string {
  const eoh = payload.indexOf('\n\n') + 1
  const lines = armor.replace(/\n$/, '').split('\n')
  return payload.slice(0, eoh) + header + lines.map((l) => ` ${l}\n`).join('') + payload.slice(eoh)
}

// The tag pointing at a new object, signature dropped; a new signature goes after the message.
export function tagPayload(t: Tag, object: string): string {
  const headers = t.headers.map((h) => (h.key === 'object' ? { key: 'object', value: object } : h))
  return joinObject(headers, t.body.slice(0, t.sigAt))
}
