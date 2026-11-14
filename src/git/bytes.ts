export const enc = new TextEncoder()
const decoders = new Map<string, TextDecoder>()

// TextDecoder for a git `encoding` header (Big5, GBK, Shift_JIS…); unknown labels fall back to UTF-8.
export function decoder(label = 'utf-8'): TextDecoder {
  let d = decoders.get(label)
  if (!d) {
    try {
      d = new TextDecoder(label)
    } catch {
      d = new TextDecoder()
    }
    decoders.set(label, d)
  }
  return d
}

export const isUtf8Label = (label: string) => /^utf-?8$/i.test(label.trim())

// "Binary strings" hold one byte per char (0–255). Objects are parsed and rebuilt in this form so
// bytes that aren't valid UTF-8 (old commits in Big5, stray Latin-1 names) come back out unchanged.
export function toBin(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x2000) s += String.fromCharCode(...b.subarray(i, i + 0x2000))
  return s
}

export function fromBin(s: string): Uint8Array {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i)
  return b
}

export const binToText = (s: string, label?: string) => decoder(label).decode(fromBin(s))
export const textToBin = (s: string) => toBin(enc.encode(s))

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))
export function hex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += HEX[b[i]]
  return s
}

export function unhex(s: string): Uint8Array {
  const b = new Uint8Array(s.length >> 1)
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.substr(i * 2, 2), 16)
  return b
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  n = 0
  for (const p of parts) {
    out.set(p, n)
    n += p.length
  }
  return out
}

export type HashAlgo = 'sha1' | 'sha256'
const SUBTLE_NAME = { sha1: 'SHA-1', sha256: 'SHA-256' } as const

export async function digest(algo: HashAlgo | 'sha512', data: Uint8Array): Promise<Uint8Array> {
  const name = algo === 'sha512' ? 'SHA-512' : SUBTLE_NAME[algo]
  return new Uint8Array(await crypto.subtle.digest(name, data as Uint8Array<ArrayBuffer>))
}

export function base64(b: Uint8Array): string {
  return btoa(toBin(b))
}

export function unbase64(s: string): Uint8Array {
  return fromBin(atob(s.replace(/[^A-Za-z0-9+/]/g, '')))
}

export const base64url = (b: Uint8Array) => base64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
