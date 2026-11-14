export interface Signer {
  kind: 'pgp' | 'ssh'
  label: string // what kind of key, and whose
  fingerprint: string
  // An armored detached signature over the payload, as git stores it.
  sign(payload: Uint8Array): Promise<string>
}

// The key is protected and the passphrase is missing (`wrong` false) or doesn't open it.
export class PassphraseError extends Error {
  constructor(public wrong: boolean) {
    super(wrong ? '密碼不對' : '這把私鑰有密碼保護')
  }
}
