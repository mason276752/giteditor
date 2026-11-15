import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { beforeAll, describe, test } from 'vitest'
import { fromBin } from './bytes'
import { commitPayload, parseCommit } from './objects'
import { affected, rewrite, type RewriteRequest } from './rewrite'
import { loadSigner } from './sign'
import { commitFile, git, makeRepo, open } from './testkit'
import { makeBundle, refUpdates, writeToRepo } from './write'

const byMessage = (h: Awaited<ReturnType<typeof open>>['history'], subject: string) =>
  [...h.commits.values()].find((c) => c.message.split('\n')[0] === subject)!

const baseReq = (target: string): RewriteRequest => ({
  target, edit: {}, sign: false, descendants: 'drop', signer: null, moveTags: true,
})

describe('reading', () => {
  let dir: string
  beforeAll(() => {
    dir = makeRepo()
  })

  test('every object, packed (with deltas) or loose, reads back to its own hash', async () => {
    const { repo } = await open(dir)
    const all = git(dir, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)').split('\n')
    assert.ok(git(dir, 'verify-pack', '-v', ...(await readdir(join(dir, '.git/objects/pack'))).filter((n) => n.endsWith('.idx')).map((n) => join(dir, '.git/objects/pack', n))).includes('chain length'), 'the pack has deltas')
    for (const hash of all) {
      const o = await repo.read(hash)
      assert.equal(await repo.hashObject(o.type, o.data), hash)
    }
  })

  test('history has the same commits as git log --all, children before parents', async () => {
    const { history } = await open(dir)
    const expected = git(dir, 'rev-list', '--all').split('\n').sort()
    assert.deepEqual([...history.commits.keys()].sort(), expected)
    for (const [i, row] of history.rows.entries()) {
      for (const p of history.commits.get(row.hash)!.parents) assert.ok(history.index.get(p)! > i)
    }
    const labels = [...history.labels.values()].flat().map((l) => l.short).sort()
    assert.deepEqual(labels, ['feature', 'light', 'main', 'origin/main', 'v1'])
    assert.ok(history.labels.get(git(dir, 'rev-parse', 'main'))!.find((l) => l.short === 'main')!.current)
  })

  test('rebuilding an unchanged commit gives the same hash', async () => {
    const { repo, history } = await open(dir)
    for (const c of history.commits.values()) {
      assert.equal(await repo.hashObject('commit', fromBin(commitPayload(c, c.parents))), c.hash)
    }
  })
})

describe('rewriting', () => {
  test('edits a commit, rewrites what follows, moves branches and tags but not remote branches', async () => {
    const dir = makeRepo()
    const before = git(dir, 'rev-parse', 'main', 'feature', 'v1', 'light', 'origin/main').split('\n')
    const { repo, state, history } = await open(dir)
    const c2 = byMessage(history, 'c2')
    const author = { name: '新作者', email: 'new@example.com', time: 1_600_000_000, tz: '-0230' }
    assert.equal(affected(history, c2.hash, true).length, 6, 'c2, c3, f1, f2, merge, c5')
    const { state: next, map } = await rewrite(repo, history, state, {
      ...baseReq(c2.hash),
      edit: { author, committer: { ...author, time: 1_600_000_100 }, message: '改過的訊息\n\n第二段' },
    })
    assert.equal(map.size, 7, '6 commits + v1 tag object')
    const updates = refUpdates(state, next)
    assert.deepEqual(updates.map((u) => u.name).sort(), ['refs/heads/feature', 'refs/heads/main', 'refs/tags/light', 'refs/tags/v1'])
    await writeToRepo(repo, state, next, { name: 'x', email: 'x@x' }, 'test')

    git(dir, 'fsck', '--strict', '--no-dangling')
    const newC2 = map.get(c2.hash)!
    assert.equal(git(dir, 'log', '-1', '--format=%an|%ae|%at|%ai|%cn|%ct|%B', newC2), `新作者|new@example.com|1600000000|2020-09-13 09:56:40 -0230|新作者|1600000100|改過的訊息\n\n第二段`)
    assert.equal(git(dir, 'rev-parse', 'v1^{commit}'), newC2)
    assert.equal(git(dir, 'cat-file', '-t', 'v1'), 'tag')
    assert.equal(git(dir, 'rev-parse', 'light^{commit}'), map.get(byMessage(history, 'f1').hash))
    assert.equal(git(dir, 'rev-parse', 'origin/main'), before[4], 'remote branch untouched')
    assert.equal(git(dir, 'rev-parse', 'ORIG_HEAD'), before[0])
    assert.match(git(dir, 'reflog', '-1', 'main'), /giteditor: test/)
    // Untouched commits keep their dates; the tree (and so the index) is the same.
    assert.equal(git(dir, 'log', '-1', '--format=%at', 'main'), git(dir, 'log', '-1', '--format=%at', before[0]))
    git(dir, 'diff', '--cached', '--quiet')
  })

  test('refuses to write when a ref moved on disk after opening', async () => {
    const dir = makeRepo()
    const { repo, state, history } = await open(dir)
    const { state: next } = await rewrite(repo, history, state, { ...baseReq(byMessage(history, 'c5').hash), edit: { message: 'x' } })
    commitFile(dir, 'z.txt', 'z', 'meanwhile')
    await assert.rejects(writeToRepo(repo, state, next, { name: 'x', email: 'x@x' }, 'test'), /被改過了/)
  })

  test('a bundle plus update-ref gives the same result', async () => {
    const dir = makeRepo()
    const copy = mkdtempSync(join(tmpdir(), 'giteditor-copy-'))
    cpSync(dir, copy, { recursive: true })
    const { repo, state, history } = await open(dir)
    const { state: next } = await rewrite(repo, history, state, { ...baseReq(byMessage(history, 'c1').hash), edit: { message: 'root' } })
    const { data, commands } = await makeBundle(repo, state, next, 'fix.bundle', 'test')
    writeFileSync(join(copy, 'fix.bundle'), data!)
    for (const cmd of commands) execFileSync('sh', ['-c', cmd], { cwd: copy })
    git(copy, 'fsck', '--strict', '--no-dangling')
    for (const [name, hash] of next.refs) assert.equal(git(copy, 'rev-parse', name), hash)
    assert.equal(git(copy, 'log', '--format=%s', 'main').split('\n').at(-1), 'root')
  })

  test('works in a SHA-256 repository', async () => {
    const dir = makeRepo('sha256')
    const { repo, state, history } = await open(dir)
    assert.equal(repo.hashLen, 32)
    assert.equal(history.commits.size, 7)
    const { state: next } = await rewrite(repo, history, state, { ...baseReq(byMessage(history, 'f1').hash), edit: { message: 'f1!' } })
    await writeToRepo(repo, state, next, { name: 'x', email: 'x@x' }, 'test')
    git(dir, 'fsck', '--strict', '--no-dangling')
    assert.equal(git(dir, 'log', '--format=%s', 'feature').split('\n')[1], 'f1!')
  })

  test('an edited Big5 commit is stored as UTF-8 with the same text', async () => {
    const dir = makeRepo()
    writeFileSync(join(dir, 'msg'), Uint8Array.of(0xa4, 0xa4, 0xa4, 0xe5, 0x0a)) // 「中文」 in Big5
    writeFileSync(join(dir, 'c.txt'), 'c')
    git(dir, 'add', 'c.txt')
    git(dir, '-c', 'i18n.commitEncoding=big5', 'commit', '-q', '-F', 'msg')
    const { repo, state, history } = await open(dir)
    const c = history.commits.get(git(dir, 'rev-parse', 'HEAD'))!
    assert.equal(c.encoding, 'big5')
    assert.equal(c.message, '中文\n')
    const { map, state: next } = await rewrite(repo, history, state, { ...baseReq(c.hash), edit: { author: { ...c.author, name: '作者' } } })
    await writeToRepo(repo, state, next, { name: 'x', email: 'x@x' }, 'test')
    const raw = git(dir, 'cat-file', '-p', map.get(c.hash)!)
    assert.ok(!raw.includes('encoding'))
    assert.match(raw, /author 作者 <test@example.com>/)
    assert.ok(raw.endsWith('\n\n中文'))
  })
})

describe('signing', () => {
  const keyDir = mkdtempSync(join(tmpdir(), 'giteditor-keys-'))
  const keys: [string, string[], string][] = [
    ['ed25519', ['-t', 'ed25519'], ''],
    ['ed25519 with passphrase', ['-t', 'ed25519'], 'hunter2'],
    ['rsa', ['-t', 'rsa', '-b', '2048'], ''],
    ['rsa with passphrase', ['-t', 'rsa', '-b', '2048'], 'pw'],
    ['ecdsa p256', ['-t', 'ecdsa', '-b', '256'], ''],
    ['ecdsa p384', ['-t', 'ecdsa', '-b', '384'], ''],
    ['ecdsa p521 with passphrase', ['-t', 'ecdsa', '-b', '521'], 'pw'],
    ['rsa PEM (PKCS#1)', ['-t', 'rsa', '-b', '2048', '-m', 'PEM'], ''],
    ['ecdsa PKCS#8', ['-t', 'ecdsa', '-b', '256', '-m', 'PKCS8'], ''],
  ]

  for (const [label, args, pass] of keys) {
    test(`SSH ${label}: git verify-commit accepts the signature`, async () => {
      const keyFile = join(keyDir, label.replace(/\W+/g, '_'))
      execFileSync('ssh-keygen', ['-q', ...args, '-N', pass, '-C', 'me@laptop', '-f', keyFile])
      const signers = join(keyDir, `${label.replace(/\W+/g, '_')}.allowed`)
      writeFileSync(signers, `test@example.com namespaces="git" ${await readFile(`${keyFile}.pub`, 'utf8')}`)

      const dir = makeRepo()
      const { repo, state, history } = await open(dir)
      const keyText = await readFile(keyFile, 'utf8')
      if (pass) await assert.rejects(loadSigner(keyText), /密碼/)
      const signer = await loadSigner(keyText, pass)
      const target = byMessage(history, 'c3').hash
      const { state: next, map } = await rewrite(repo, history, state, { ...baseReq(target), sign: true, descendants: 'all', signer })
      await writeToRepo(repo, state, next, { name: 'x', email: 'x@x' }, 'sign')
      git(dir, 'fsck', '--strict', '--no-dangling')
      for (const ref of [map.get(target)!, 'main']) {
        const out = execFileSync('git', ['-c', `gpg.ssh.allowedSignersFile=${signers}`, 'verify-commit', '-v', ref], {
          cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        })
        assert.match(out + git(dir, '-c', `gpg.ssh.allowedSignersFile=${signers}`, 'log', '-1', '--format=%G?', ref), /G$/)
      }
      assert.equal(signer.fingerprint, execFileSync('ssh-keygen', ['-lf', `${keyFile}.pub`], { encoding: 'utf8' }).split(' ')[1])
    })
  }

  test('a wrong passphrase is reported as such', async () => {
    const keyFile = join(keyDir, 'wrong')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'right', '-f', keyFile])
    await assert.rejects(loadSigner(await readFile(keyFile, 'utf8'), 'wrong'), /密碼不對/)
  })

  test('GPG: the signature verifies over the commit without its signature header', async () => {
    const openpgp = await import('openpgp')
    const { privateKey, publicKey } = await openpgp.generateKey({ userIDs: [{ name: 'Tester', email: 'test@example.com' }], passphrase: 'pw', format: 'armored' })
    await assert.rejects(loadSigner(privateKey, 'nope'), /密碼不對/)
    const signer = await loadSigner(privateKey, 'pw')
    const dir = makeRepo()
    const { repo, state, history } = await open(dir)
    const target = byMessage(history, 'c5').hash
    const { state: next, map } = await rewrite(repo, history, state, { ...baseReq(target), sign: true, signer })
    await writeToRepo(repo, state, next, { name: 'x', email: 'x@x' }, 'sign')
    git(dir, 'fsck', '--strict', '--no-dangling')
    const signed = parseCommit(map.get(target)!, (await repo.read(map.get(target)!)).data)
    assert.equal(signed.sig, 'pgp')
    const raw = git(dir, 'cat-file', 'commit', signed.hash) + '\n'
    const sig = raw.match(/gpgsig ([\s\S]*?-----END PGP SIGNATURE-----)/)![1].replace(/\n /g, '\n')
    const payload = raw.replace(/gpgsig [\s\S]*?-----END PGP SIGNATURE-----\n/, '')
    const result = await openpgp.verify({
      message: await openpgp.createMessage({ binary: new TextEncoder().encode(payload) }),
      signature: await openpgp.readSignature({ armoredSignature: sig }),
      verificationKeys: await openpgp.readKey({ armoredKey: publicKey }),
    })
    assert.equal(await result.signatures[0].verified, true)
  })
})
