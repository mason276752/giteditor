import { base64, base64url, concat, digest, enc, hex, toBin, unbase64, unhex } from '../bytes'
import { PassphraseError, type Signer } from './signer'

// SSH signatures as made by `ssh-keygen -Y sign -n git` (git's gpg.format=ssh), with the private key's
// maths done by WebCrypto.

type Bytes = Uint8Array<ArrayBuffer>

class Reader {
  private i = 0
  constructor(private b: Uint8Array) {}
  u32() {
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.i, 4).getUint32(0)
    this.i += 4
    return v
  }
  bytes(n: number) {
    if (this.i + n > this.b.length) throw new Error('私鑰資料不完整')
    return this.b.slice(this.i, (this.i += n))
  }
  string() {
    return this.bytes(this.u32())
  }
  text() {
    return toBin(this.string())
  }
}

const u32 = (n: number) => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n)
  return b
}
const sshString = (b: Uint8Array | string) => {
  const bytes = typeof b === 'string' ? enc.encode(b) : b
  return concat([u32(bytes.length), bytes])
}
const unsigned = (b: Uint8Array) => {
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  return b.subarray(i)
}
// SSH's mpint: big-endian, a leading zero byte when the top bit is set.
const mpint = (b: Uint8Array) => {
  const u = unsigned(b)
  return sshString(u[0] & 0x80 ? concat([new Uint8Array(1), u]) : u)
}
const pad = (b: Uint8Array, n: number) => {
  const u = unsigned(b)
  return concat([new Uint8Array(Math.max(0, n - u.length)), u]).slice(-n)
}
const big = (b: Uint8Array) => BigInt(`0x${hex(b) || '0'}`)
const unbig = (n: bigint) => {
  const h = n.toString(16)
  return unhex(h.length % 2 ? `0${h}` : h)
}

interface Key {
  type: string // public key type: ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256…
  algo: string // signature algorithm: rsa-sha2-512 for RSA keys, otherwise the same
  pub: Uint8Array // public key blob
  comment: string
  sign(data: Bytes): Promise<Uint8Array> // signature blob contents
}

const CURVES: Record<string, { crv: string; size: number; hash: string }> = {
  nistp256: { crv: 'P-256', size: 32, hash: 'SHA-256' },
  nistp384: { crv: 'P-384', size: 48, hash: 'SHA-384' },
  nistp521: { crv: 'P-521', size: 66, hash: 'SHA-512' },
}
const CIPHERS: Record<string, { keyLen: number; ivLen: number; gcm?: boolean }> = {
  'aes128-ctr': { keyLen: 16, ivLen: 16 },
  'aes192-ctr': { keyLen: 24, ivLen: 16 },
  'aes256-ctr': { keyLen: 32, ivLen: 16 },
  'aes256-gcm@openssh.com': { keyLen: 32, ivLen: 12, gcm: true },
}
const subtle = () => crypto.subtle

async function ed25519(seed: Uint8Array, pub: Uint8Array, comment: string): Promise<Key> {
  const jwk = { kty: 'OKP', crv: 'Ed25519', d: base64url(seed), x: base64url(pub) }
  const key = await subtle().importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign'])
  return {
    type: 'ssh-ed25519',
    algo: 'ssh-ed25519',
    pub: concat([sshString('ssh-ed25519'), sshString(pub)]),
    comment,
    sign: async (data) => new Uint8Array(await subtle().sign('Ed25519', key, data)),
  }
}

async function rsa(jwk: JsonWebKey, comment: string): Promise<Key> {
  const key = await subtle().importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, false, ['sign'])
  return {
    type: 'ssh-rsa',
    algo: 'rsa-sha2-512',
    pub: concat([sshString('ssh-rsa'), mpint(unbase64(fromUrl(jwk.e!))), mpint(unbase64(fromUrl(jwk.n!)))]),
    comment,
    sign: async (data) => new Uint8Array(await subtle().sign('RSASSA-PKCS1-v1_5', key, data)),
  }
}

async function ecdsa(curve: string, jwk: JsonWebKey, comment: string): Promise<Key> {
  const c = CURVES[curve]
  const key = await subtle().importKey('jwk', jwk, { name: 'ECDSA', namedCurve: c.crv }, false, ['sign'])
  const type = `ecdsa-sha2-${curve}`
  const point = concat([Uint8Array.of(4), pad(unbase64(fromUrl(jwk.x!)), c.size), pad(unbase64(fromUrl(jwk.y!)), c.size)])
  return {
    type,
    algo: type,
    pub: concat([sshString(type), sshString(curve), sshString(point)]),
    comment,
    async sign(data) {
      // WebCrypto gives r ‖ s; SSH wants them as two mpints.
      const rs = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: c.hash }, key, data))
      return concat([mpint(rs.subarray(0, c.size)), mpint(rs.subarray(c.size))])
    },
  }
}

const fromUrl = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/')

// ---------- OpenSSH's own format (`ssh-keygen` since 2018) ----------
async function openssh(body: string, passphrase: string): Promise<Key> {
  const buf = unbase64(body)
  const magic = 'openssh-key-v1\0'
  if (toBin(buf.subarray(0, magic.length)) !== magic) throw new Error('不是 OpenSSH 私鑰')
  const r = new Reader(buf.subarray(magic.length))
  const cipher = r.text()
  const kdf = r.text()
  const kdfOpts = r.string()
  if (r.u32() !== 1) throw new Error('一個檔案裡有多把金鑰，目前不支援')
  r.string() // public key, repeated inside
  let priv: Uint8Array = r.string()
  if (cipher !== 'none') {
    const c = CIPHERS[cipher]
    if (!c || kdf !== 'bcrypt') throw new Error(`不支援這種私鑰加密方式（${cipher}／${kdf}）`)
    if (!passphrase) throw new PassphraseError(false)
    const kr = new Reader(kdfOpts)
    const salt = kr.string()
    const rounds = kr.u32()
    const { pbkdf } = await import('bcrypt-pbkdf')
    const pass = enc.encode(passphrase)
    const out = new Uint8Array(c.keyLen + c.ivLen)
    pbkdf(pass, pass.length, salt, salt.length, out, out.length, rounds)
    const iv = out.slice(c.keyLen)
    const name = c.gcm ? 'AES-GCM' : 'AES-CTR'
    const aes = await subtle().importKey('raw', out.slice(0, c.keyLen), name, false, ['decrypt'])
    try {
      priv = new Uint8Array(
        c.gcm
          ? await subtle().decrypt({ name, iv }, aes, concat([priv, r.bytes(16)]) as Bytes)
          : await subtle().decrypt({ name, counter: iv, length: 128 }, aes, priv as Bytes),
      )
    } catch {
      throw new PassphraseError(true)
    }
  }
  const p = new Reader(priv)
  // Two copies of a random number: equal only if the passphrase was right.
  if (p.u32() !== p.u32()) throw new PassphraseError(true)
  const type = p.text()
  if (type === 'ssh-ed25519') {
    const pub = p.string()
    const sk = p.string()
    return ed25519(sk.subarray(0, 32), pub, p.text())
  }
  if (type === 'ssh-rsa') {
    const [n, e, d, iqmp, pp, q] = Array.from({ length: 6 }, () => p.string())
    const D = big(d)
    const jwk: JsonWebKey = {
      kty: 'RSA',
      n: base64url(unsigned(n)),
      e: base64url(unsigned(e)),
      d: base64url(unsigned(d)),
      p: base64url(unsigned(pp)),
      q: base64url(unsigned(q)),
      dp: base64url(unbig(D % (big(pp) - 1n))),
      dq: base64url(unbig(D % (big(q) - 1n))),
      qi: base64url(unsigned(iqmp)),
    }
    return rsa(jwk, p.text())
  }
  const ec = type.match(/^ecdsa-sha2-(nistp\d+)$/)
  if (ec && CURVES[ec[1]]) {
    const c = CURVES[ec[1]]
    p.text() // curve name again
    const point = p.string()
    const d = p.string()
    const jwk: JsonWebKey = {
      kty: 'EC',
      crv: c.crv,
      x: base64url(point.subarray(1, 1 + c.size)),
      y: base64url(point.subarray(1 + c.size)),
      d: base64url(pad(d, c.size)),
    }
    return ecdsa(ec[1], jwk, p.text())
  }
  if (type.startsWith('sk-')) throw new Error('這是硬體金鑰（FIDO／YubiKey），私鑰在裝置裡，瀏覽器沒辦法用它簽名。')
  throw new Error(`不支援 ${type} 金鑰`)
}

// ---------- PEM (PKCS#8, and PKCS#1 RSA from older ssh-keygen) ----------
const derLen = (n: number) =>
  n < 0x80 ? Uint8Array.of(n) : n < 0x100 ? Uint8Array.of(0x81, n) : n < 0x10000 ? Uint8Array.of(0x82, n >> 8, n & 255) : Uint8Array.of(0x83, n >> 16, (n >> 8) & 255, n & 255)
const der = (tag: number, ...content: Uint8Array[]) => {
  const c = concat(content)
  return concat([Uint8Array.of(tag), derLen(c.length), c])
}
const RSA_ALG = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00)
const pkcs1ToPkcs8 = (pkcs1: Uint8Array) => der(0x30, Uint8Array.of(2, 1, 0), RSA_ALG, der(0x04, pkcs1))

async function pkcs8(bytes: Uint8Array, comment: string): Promise<Key> {
  const data = bytes as Bytes
  const exported = async (alg: AlgorithmIdentifier | EcKeyImportParams | RsaHashedImportParams) =>
    subtle().exportKey('jwk', await subtle().importKey('pkcs8', data, alg, true, ['sign']))
  // Try each kind; importKey refuses a key of another kind.
  try {
    const jwk = await exported({ name: 'Ed25519' })
    return ed25519(unbase64(fromUrl(jwk.d!)), unbase64(fromUrl(jwk.x!)), comment)
  } catch { /* not Ed25519 */ }
  for (const [curve, c] of Object.entries(CURVES)) {
    try {
      return ecdsa(curve, await exported({ name: 'ECDSA', namedCurve: c.crv }), comment)
    } catch { /* not this curve */ }
  }
  try {
    return rsa(await exported({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }), comment)
  } catch {
    throw new Error('無法讀取這把 PEM 私鑰')
  }
}

const pem = (text: string, label: string) =>
  text.match(new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`))?.[1]

export const isSshKey = (text: string) => /-----BEGIN (OPENSSH|RSA|EC|ENCRYPTED)? ?PRIVATE KEY-----/.test(text)

async function readKey(text: string, passphrase: string): Promise<Key> {
  const ossh = pem(text, 'OPENSSH PRIVATE KEY')
  if (ossh) return openssh(ossh, passphrase)
  const rsa1 = pem(text, 'RSA PRIVATE KEY')
  if (rsa1) {
    if (/ENCRYPTED/.test(rsa1)) throw new Error('舊格式的加密 RSA 私鑰不支援。可以先用 ssh-keygen -p -f 金鑰檔 改存成新格式。')
    return pkcs8(pkcs1ToPkcs8(unbase64(rsa1)), '')
  }
  const p8 = pem(text, 'PRIVATE KEY')
  if (p8) return pkcs8(unbase64(p8), '')
  if (pem(text, 'ENCRYPTED PRIVATE KEY')) throw new Error('有密碼的 PKCS#8 私鑰不支援。可以先用 ssh-keygen -p -f 金鑰檔 改存成 OpenSSH 格式。')
  throw new Error('看不懂這把私鑰：請貼上 OpenSSH 私鑰（-----BEGIN OPENSSH PRIVATE KEY-----）')
}

export async function fingerprint(pub: Uint8Array) {
  return `SHA256:${base64(await digest('sha256', pub)).replace(/=+$/, '')}`
}

const KEY_NAMES: Record<string, string> = { 'ssh-ed25519': 'ED25519', 'ssh-rsa': 'RSA' }

export async function sshSigner(text: string, passphrase: string): Promise<Signer> {
  const key = await readKey(text, passphrase)
  const namespace = 'git'
  const name = KEY_NAMES[key.type] ?? key.type.replace(/^ecdsa-sha2-nistp/, 'ECDSA P-')
  return {
    kind: 'ssh',
    label: `SSH ${name}${key.comment ? ` · ${key.comment}` : ''}`,
    fingerprint: await fingerprint(key.pub),
    async sign(payload) {
      const hash = await digest('sha512', payload)
      const signed = concat([enc.encode('SSHSIG'), sshString(namespace), sshString(''), sshString('sha512'), sshString(hash)])
      const sig = concat([sshString(key.algo), sshString(await key.sign(signed as Bytes))])
      const blob = concat([
        enc.encode('SSHSIG'), u32(1), sshString(key.pub), sshString(namespace), sshString(''), sshString('sha512'), sshString(sig),
      ])
      const lines = base64(blob).match(/.{1,70}/g)!.join('\n')
      return `-----BEGIN SSH SIGNATURE-----\n${lines}\n-----END SSH SIGNATURE-----\n`
    },
  }
}
