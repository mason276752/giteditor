import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { enc, textToBin } from './bytes'
import { merge3, splitLines } from './diff'
import { danglingCommits, parseDate } from './revs'
import { rewrite } from './rewrite'
import { run, type ShellEnv } from './shell'
import { loadSigner } from './sign'
import { commitFile, git, makeRepo, open } from './testkit'
import { makeBundle, staleFiles, writeToRepo } from './write'

// L1: shared.txt (lines 1-10) · L2: line 2 + b.txt · L3: line 9 · L4: c.txt
function makeLinear() {
  const dir = mkdtempSync(join(tmpdir(), 'giteditor-linear-'))
  git(dir, 'init', '-q', '-b', 'main')
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
  const save = () => writeFileSync(join(dir, 'shared.txt'), `${lines.join('\n')}\n`)
  save()
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'L1')
  lines[1] = 'line 2 (L2)'
  save()
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'L2')
  lines[8] = 'line 9 (L3)'
  save()
  git(dir, 'commit', '-q', '-am', 'L3')
  commitFile(dir, 'c.txt', 'c\n', 'L4')
  return dir
}

// A page-like shell on the repo: commands run, edits written back, editor answers scripted.
async function terminal(dir: string, editor: ((text: string) => string | null)[] = []) {
  const { repo, state, history } = await open(dir)
  const env: ShellEnv = {
    repo,
    snap: { refs: state, work: { head: { ...repo.head }, index: null, files: null, rebase: null } },
    signer: null,
    config: new Map([['user.name', 'Shell User'], ['user.email', 'shell@example.com']]),
    hooks: {
      editText: async (_title, text) => {
        const answer = editor.shift()
        if (!answer) throw new Error('editor opened unexpectedly')
        return answer(text)
      },
      dangling: async () => danglingCommits(repo, env.snap, await repo.allCommits()),
    },
  }
  const sh = async (line: string) => {
    const r = await run(env, line)
    const err = r.lines.filter((l) => l.kind === 'err').map((l) => l.text).join('\n')
    return { out: r.lines.filter((l) => l.kind !== 'err').map((l) => l.text).join('\n'), err, res: r }
  }
  const ok = async (line: string) => {
    const r = await sh(line)
    assert.equal(r.err, '', `${line}\n→ ${r.err}`)
    return r.out
  }
  const save = async () => {
    const done = await writeToRepo(repo, state, env.snap.refs, { name: 'x', email: 'x@x' }, 'test')
    git(dir, 'fsck', '--strict', '--no-dangling')
    return done
  }
  return { env, repo, state, history, sh, ok, save }
}

const lines = (s: string) => s.split('\n')

describe('terminal', () => {
  test('edit files, add and commit; git sees the same after writing', async () => {
    const dir = makeRepo()
    const t = await terminal(dir, [(text) => `${text.trim()}\nadded in the editor\n`])
    assert.match(await t.ok('git status'), /On branch main\n\nnothing to commit, working tree clean/)
    await t.ok('echo hello > notes/new.txt && echo "world  2" >> notes/new.txt')
    await t.ok('edit b.txt')
    assert.equal(await t.ok('git status --short'), ' M b.txt\n?? notes/new.txt')
    assert.match(await t.ok('git diff'), /--- a\/b.txt\n\+\+\+ b\/b.txt\n@@ -1 \+1,2 @@\n feature 2\n\+added in the editor/)
    assert.match(await t.ok('git add -A && git commit -m "add notes" -m "second paragraph"'), /^\[main [0-9a-f]{7}\] add notes\n 2 files changed/)
    assert.match(await t.ok('git status'), /nothing to commit, working tree clean/)
    assert.equal(await t.ok('git log --format=%s -n 2'), 'add notes\nc5')
    const stale = await staleFiles(t.repo, t.state, t.env.snap.refs)
    await t.save()
    assert.equal(git(dir, 'log', '-1', '--format=%s|%b|%an <%ae>', 'main'), 'add notes|second paragraph\n|Shell User <shell@example.com>')
    assert.equal(git(dir, 'show', 'main:notes/new.txt'), 'hello\nworld  2')
    assert.equal(git(dir, 'show', 'main:b.txt'), 'feature 2\nadded in the editor')
    assert.deepEqual(stale.sort(), ['b.txt', 'notes/new.txt'])
  })

  test('amend with --date and GIT_COMMITTER_DATE', async () => {
    const dir = makeRepo()
    const before = git(dir, 'rev-parse', 'main', 'main~1').split('\n')
    const t = await terminal(dir)
    await t.ok('GIT_COMMITTER_DATE="2020-01-02 03:04:05 +0000" git commit --amend --no-edit --date="2019-12-31T23:00:00+08:00"')
    assert.equal(t.env.snap.work.rebase, null)
    await t.save()
    assert.equal(git(dir, 'log', '-1', '--format=%ad|%cd|%s|%P', '--date=raw', 'main'), `1577804400 +0800|1577934245 +0000|c5|${before[1]}`)
  })

  test('rebase -i with edit changes a file in an old commit; later commits keep their own changes', async () => {
    const dir = makeLinear()
    const authorDates = git(dir, 'log', '--format=%ad', '--date=raw', 'main')
    const t = await terminal(dir, [(todo) => todo.replace(/^pick (\w+) L2$/m, 'edit $1 L2')])
    const stop = await t.ok('git rebase -i HEAD~3')
    assert.match(stop, /Stopped at [0-9a-f]{7}\.\.\.  L2/)
    assert.match(await t.ok('git status'), /interactive rebase in progress/)
    await t.ok('echo "extra" >> b.txt && echo "line 5 edited" > tmp && git add b.txt')
    await t.ok('rm tmp && git commit --amend --no-edit')
    assert.match(await t.ok('git rebase --continue'), /Successfully rebased and updated refs\/heads\/main/)
    await t.save()
    assert.equal(git(dir, 'log', '--format=%s', 'main'), 'L4\nL3\nL2\nL1')
    assert.equal(git(dir, 'show', 'main~2:b.txt'), 'b\nextra')
    assert.equal(git(dir, 'show', 'main:b.txt'), 'b\nextra')
    assert.match(git(dir, 'show', 'main:shared.txt'), /line 2 \(L2\)[\s\S]*line 9 \(L3\)/)
    assert.equal(git(dir, 'log', '--format=%ad', '--date=raw', 'main'), authorDates, 'author dates are kept')
  })

  test('rebase -i: reorder, squash, fixup, drop and reword', async () => {
    const dir = makeLinear()
    const t = await terminal(dir, [
      (todo) => {
        const [l2, l3, l4] = lines(todo).filter((l) => l.startsWith('pick'))
        return [l4.replace('pick', 'reword'), l2.replace('pick', 'drop'), l3.replace('pick', 'squash')].join('\n')
      },
      () => 'L4 reworded\n',
      (text) => {
        assert.match(text, /L4 reworded[\s\S]*L3/)
        return 'L4 and L3 together\n# a comment that goes away\n'
      },
    ])
    await t.ok('git rebase -i HEAD~3')
    await t.save()
    assert.equal(git(dir, 'log', '--format=%s', 'main'), 'L4 and L3 together\nL1')
    assert.equal(git(dir, 'show', 'main:c.txt'), 'c')
    assert.doesNotMatch(git(dir, 'ls-tree', '-r', '--name-only', 'main'), /b\.txt/)
    assert.match(git(dir, 'show', 'main:shared.txt'), /^line 1\nline 2\n[\s\S]*line 9 \(L3\)/)
  })

  test('cherry-pick, revert and merge', async () => {
    const dir = makeRepo()
    const t = await terminal(dir)
    assert.match(await t.ok('git switch feature'), /Switched to branch 'feature'/)
    assert.match(await t.ok('git cherry-pick main~2'), /\[feature [0-9a-f]{7}\] c3/)
    assert.match(await t.ok('git revert HEAD'), /\[feature [0-9a-f]{7}\] Revert "c3"/)
    assert.match(await t.ok('git merge main'), /Merge made by the 'ort' strategy/)
    await t.save()
    assert.equal(git(dir, 'log', '--first-parent', '--format=%s', '-4', 'feature'), `Merge branch 'main'\nRevert "c3"\nc3\nf2`)
    assert.equal(git(dir, 'rev-parse', 'feature^{tree}'), git(dir, 'rev-parse', 'main^{tree}'))
  })

  test('a conflict cancels the command and changes nothing', async () => {
    const dir = makeLinear()
    git(dir, 'checkout', '-q', '-b', 'other', 'main~3')
    writeFileSync(join(dir, 'shared.txt'), readFileSync(join(dir, 'shared.txt'), 'utf8').replace('line 9', 'line 9 (other)'))
    git(dir, 'commit', '-q', '-am', 'other')
    const t = await terminal(dir)
    const before = t.env.snap
    const r = await t.sh('git cherry-pick main~1')
    assert.match(r.err, /could not apply [0-9a-f]{7}\.\.\. L3\nCONFLICT \(content\): Merge conflict in shared\.txt/)
    assert.equal(t.env.snap, before)
    const rb = await t.sh('git rebase main')
    assert.match(rb.err, /CONFLICT/)
    assert.equal(t.env.snap, before)
  })

  test('branches and tags: create, rename and delete, packed refs included', async () => {
    const dir = makeRepo()
    assert.match(readFileSync(join(dir, '.git/packed-refs'), 'utf8'), /refs\/heads\/feature/)
    const t = await terminal(dir)
    await t.ok('git branch -m feature topic && git tag -d light && git tag -a v2 -m "release two" HEAD~1 && git branch old v1')
    assert.match((await t.sh('git branch -D main')).err, /cannot delete branch 'main'/)
    assert.equal(await t.ok('git branch'), '* main\n  old\n  topic')
    assert.equal(await t.ok('git tag'), 'v1\nv2')
    await t.save()
    const refs = git(dir, 'show-ref').split('\n').map((l) => l.split(' ')[1])
    assert.deepEqual(refs.sort(), ['refs/heads/main', 'refs/heads/old', 'refs/heads/topic', 'refs/remotes/origin/main', 'refs/tags/v1', 'refs/tags/v2'])
    assert.equal(git(dir, 'cat-file', '-t', 'v2'), 'tag')
    assert.equal(git(dir, 'tag', '-l', '--format=%(contents)', 'v2'), 'release two')
    assert.equal(git(dir, 'rev-parse', 'v2^{commit}'), git(dir, 'rev-parse', 'main~1'))
    assert.doesNotMatch(readFileSync(join(dir, '.git/packed-refs'), 'utf8'), /feature|light/)
  })

  test('detached commits, dangling commits and rescuing them', async () => {
    const dir = makeRepo()
    commitFile(dir, 'lost.txt', 'lost\n', 'lost work')
    const lost = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'reset', '-q', '--hard', 'HEAD~1')
    const t = await terminal(dir)
    assert.match(await t.ok('git fsck'), new RegExp(`dangling commit ${lost}`))
    assert.match(await t.ok(`git switch --detach ${lost.slice(0, 8)}`), /HEAD is now at [0-9a-f]{7} lost work/)
    assert.match(await t.ok('git ls-tree -r --name-only HEAD'), /lost\.txt/)
    await t.ok('echo more > more.txt && git add more.txt && git commit -m "on top of lost"')
    const tip = (await t.ok('git rev-parse HEAD')).trim()
    await t.ok('git switch main')
    assert.deepEqual(await danglingCommits(t.repo, t.env.snap, await t.repo.allCommits()), [tip])
    await t.ok(`git branch rescue ${tip}`)
    assert.deepEqual(await danglingCommits(t.repo, t.env.snap, await t.repo.allCommits()), [])
    await t.save()
    assert.equal(git(dir, 'log', '--format=%s', '-2', 'rescue'), 'on top of lost\nlost work')
  })

  test('reset modes and restore', async () => {
    const dir = makeLinear()
    const t = await terminal(dir)
    await t.ok('git reset --soft HEAD~1')
    assert.equal(await t.ok('git status --short'), 'A  c.txt')
    await t.ok('git reset')
    assert.equal(await t.ok('git status --short'), '?? c.txt')
    await t.ok('echo changed > shared.txt && git restore shared.txt')
    assert.equal(await t.ok('git status --short'), '?? c.txt')
    assert.match(await t.ok('git reset --hard HEAD~1'), /HEAD is now at [0-9a-f]{7} L2/)
    assert.equal(await t.ok('git status --short'), '?? c.txt', 'untracked files survive --hard')
    assert.equal(await t.ok('cat shared.txt'), Array.from({ length: 10 }, (_, i) => (i === 1 ? 'line 2 (L2)' : `line ${i + 1}`)).join('\n'))
  })

  test('amend an old commit while detached, then rebase --onto moves the rest', async () => {
    const dir = makeLinear()
    const t = await terminal(dir)
    const old = (await t.ok('git rev-parse main~2')).trim()
    await t.ok('git switch --detach main~2')
    const amend = await t.ok('git commit --amend -m "L2 renamed"')
    assert.match(amend, new RegExp(`git rebase --onto [0-9a-f]{7} ${old.slice(0, 7)} main`))
    const fixed = (await t.ok('git rev-parse HEAD')).trim()
    assert.match(await t.ok(`git rebase --onto ${fixed} ${old} main`), /Successfully rebased/)
    await t.save()
    assert.equal(git(dir, 'log', '--format=%s', 'main'), 'L4\nL3\nL2 renamed\nL1')
  })

  test('git commit -S signs with the loaded SSH key', async () => {
    const dir = makeLinear()
    const keyDir = mkdtempSync(join(tmpdir(), 'giteditor-key-'))
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(keyDir, 'k')])
    writeFileSync(join(keyDir, 'allowed'), `shell@example.com namespaces="git" ${readFileSync(join(keyDir, 'k.pub'), 'utf8')}`)
    const t = await terminal(dir)
    assert.match((await t.sh('git commit --amend --no-edit -S')).err, /請先按終端機上方的「私鑰」/)
    t.env.signer = await loadSigner(readFileSync(join(keyDir, 'k'), 'utf8'))
    await t.ok('git commit --amend --no-edit -S && git tag -s v1 -m "signed tag"')
    await t.save()
    const verify = (args: string[]) => git(dir, '-c', `gpg.ssh.allowedSignersFile=${join(keyDir, 'allowed')}`, ...args)
    assert.equal(verify(['log', '-1', '--format=%G?', 'main']), 'G')
    verify(['verify-tag', 'v1'])
  })

  test('a bundle carries new branches, new trees and deletions', async () => {
    const dir = makeRepo()
    const copy = mkdtempSync(join(tmpdir(), 'giteditor-copy-'))
    cpSync(dir, copy, { recursive: true })
    const t = await terminal(dir)
    await t.ok('git switch -c topic main~1 && echo x > x.txt && git add x.txt && git commit -m x && git branch -D feature && git tag -d light')
    const { data, commands } = await makeBundle(t.repo, t.state, t.env.snap.refs, 'b.bundle', 'test')
    writeFileSync(join(copy, 'b.bundle'), data!)
    for (const cmd of commands) execFileSync('sh', ['-c', cmd], { cwd: copy })
    git(copy, 'fsck', '--strict', '--no-dangling')
    assert.equal(git(copy, 'show', 'topic:x.txt'), 'x')
    assert.doesNotMatch(git(copy, 'show-ref'), /feature|light/)
  })

  test('log, show, diff and friends print what git prints', async () => {
    const dir = makeRepo()
    const t = await terminal(dir)
    const mine = await t.ok('git log --oneline -n 3')
    assert.equal(mine, git(dir, 'log', '--oneline', '--decorate', '-n', '3'))
    assert.equal(await t.ok('git log --format="%H %an %ad" --date=iso -n 2'), git(dir, 'log', '--format=%H %an %ad', '--date=iso', '-n', '2'))
    assert.equal(await t.ok('git show --stat --format=%s HEAD'), git(dir, 'show', '--stat', '--format=%s', 'HEAD').replace(/\s+\|\s+/g, ' | ').replace(/ +$/gm, ''))
    assert.equal(await t.ok('git show HEAD~1:b.txt'), 'feature 2')
    assert.equal(await t.ok('git rev-parse HEAD~1^2'), git(dir, 'rev-parse', 'HEAD~1^2'))
    assert.match((await t.sh('git rev-parse HEAD~2^2')).err, /unknown revision/)
    assert.equal(await t.ok('git cat-file -p v1^{commit}'), git(dir, 'cat-file', '-p', 'v1^{commit}'))
    assert.equal(await t.ok('git ls-tree HEAD'), git(dir, 'ls-tree', 'HEAD'))
    await t.ok('echo changed > b.txt')
    assert.match(await t.ok('git diff'), /^diff --git a\/b.txt b\/b.txt\nindex [0-9a-f]{7}\.\.[0-9a-f]{7} 100644\n--- a\/b.txt\n\+\+\+ b\/b.txt\n@@ -1 \+1 @@\n-feature 2\n\+changed$/)
    assert.match((await t.sh('git push')).err, /不連網路/)
    assert.match((await t.sh('git frobnicate')).err, /不支援/)
    assert.match((await t.sh('ls nope')).err, /No such file/)
  })
})

describe('editing files of an old commit from the commit pane', () => {
  test('the edit is carried into later commits', async () => {
    const dir = makeLinear()
    const { repo, state, history } = await open(dir)
    const l2 = [...history.commits.values()].find((c) => c.message === 'L2\n')!
    const text = readFileSync(join(dir, 'shared.txt'), 'utf8')
    const at = (s: string) => new Map([[textToBin('shared.txt'), enc.encode(s)]])
    const ok = await rewrite(repo, history, state, {
      target: l2.hash, edit: {}, sign: false, descendants: 'drop', signer: null, moveTags: true,
      files: at(text.replace('line 9 (L3)', 'line 9').replace('line 5', 'line 5 fixed')),
    })
    await writeToRepo(repo, state, ok.state, { name: 'x', email: 'x@x' }, 'test')
    git(dir, 'fsck', '--strict', '--no-dangling')
    assert.match(git(dir, 'show', 'main~2:shared.txt'), /line 5 fixed/)
    assert.match(git(dir, 'show', 'main:shared.txt'), /line 2 \(L2\)[\s\S]*line 5 fixed[\s\S]*line 9 \(L3\)/)
    assert.equal(git(dir, 'show', 'main:c.txt'), 'c')
  })

  test('a later commit changing the same lines cancels everything', async () => {
    const dir = makeLinear()
    const { repo, state, history } = await open(dir)
    const l2 = [...history.commits.values()].find((c) => c.message === 'L2\n')!
    const text = readFileSync(join(dir, 'shared.txt'), 'utf8').replace('line 9 (L3)', 'line 9 edited')
    await assert.rejects(
      rewrite(repo, history, state, {
        target: l2.hash, edit: {}, sign: false, descendants: 'drop', signer: null, moveTags: true,
        files: new Map([[textToBin('shared.txt'), enc.encode(text)]]),
      }),
      /也改了 shared\.txt/,
    )
  })
})

describe('pieces', () => {
  const L = (s: string) => splitLines(s.split(' ').join('\n') + '\n')
  test('three-way merge', () => {
    assert.deepEqual(merge3(L('a b c d e f'), L('A b c d e f'), L('a b c d e F')), L('A b c d e F'))
    assert.deepEqual(merge3(L('a b c'), L('a X c'), L('a X c')), L('a X c'))
    assert.equal(merge3(L('a b c'), L('a X c'), L('a Y c')), null)
    assert.equal(merge3(L('a b c d'), L('a X c d'), L('a b Y d')), null, 'touching changes conflict, like git')
    assert.deepEqual(merge3(L('a b'), L('a b c'), L('z a b')), L('z a b c'))
  })

  test('dates people type', () => {
    assert.deepEqual(parseDate('2019-12-31T23:00:00+08:00'), { time: 1577804400, tz: '+0800' })
    assert.deepEqual(parseDate('2020-01-02 03:04:05 +0000'), { time: 1577934245, tz: '+0000' })
    assert.deepEqual(parseDate('Thu Nov 16 05:13:20 2023 +0800'), { time: 1700082800, tz: '+0800' })
    assert.deepEqual(parseDate('Thu, 16 Nov 2023 05:13:20 +0800'), { time: 1700082800, tz: '+0800' })
    assert.deepEqual(parseDate('@1700000000 -0230'), { time: 1700000000, tz: '-0230' })
    assert.equal(parseDate('yesterday-ish'), null)
  })
})
