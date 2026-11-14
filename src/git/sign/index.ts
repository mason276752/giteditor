import { PassphraseError, type Signer } from './signer'
import { isSshKey, sshSigner } from './ssh'

export { PassphraseError, type Signer }

export type KeyFormat = 'pgp' | 'ssh'

export function keyFormat(text: string): KeyFormat | null {
  if (/-----BEGIN PGP PRIVATE KEY BLOCK-----/.test(text)) return 'pgp'
  if (isSshKey(text)) return 'ssh'
  return null
}

// OpenPGP needs openpgp.js (~400 KB), loaded only when a GPG key is used.
async function pgpSigner(armoredKey: string, passphrase: string): Promise<Signer> {
  const openpgp = await import('openpgp')
  let key = await openpgp.readPrivateKey({ armoredKey })
  if (!key.isDecrypted()) {
    if (!passphrase) throw new PassphraseError(false)
    try {
      key = await openpgp.decryptKey({ privateKey: key, passphrase })
    } catch {
      throw new PassphraseError(true)
    }
  }
  const signingKey = key
  return {
    kind: 'pgp',
    label: `GPG · ${key.getUserIDs()[0] ?? key.getKeyID().toHex().toUpperCase()}`,
    fingerprint: key.getFingerprint().toUpperCase().replace(/(.{4})(?!$)/g, '$1 '),
    async sign(payload) {
      // A binary-document signature over the exact bytes, as `gpg --detach-sign` makes for git.
      const message = await openpgp.createMessage({ binary: payload })
      return openpgp.sign({ message, signingKeys: signingKey, detached: true, format: 'armored' })
    },
  }
}

export async function loadSigner(text: string, passphrase = ''): Promise<Signer> {
  const format = keyFormat(text)
  if (format === 'pgp') return pgpSigner(text, passphrase)
  if (format === 'ssh') return sshSigner(text, passphrase)
  if (/PUBLIC KEY|^ssh-|^ecdsa-/m.test(text)) throw new Error('這是公鑰。簽名要用私鑰。')
  throw new Error('看不懂這把金鑰：請貼上 SSH 私鑰或 GPG 私鑰（ASCII armor）。')
}
