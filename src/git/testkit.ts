// Helpers for the tests: real git repositories in temp folders, read through the same code the page uses.
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findGitDir, type GitFs } from './fs'
import { loadHistory, type RefState } from './history'
import { Repo } from './repo'

export function nodeFs(root: string): GitFs {
  return {
    async file(p) {
      try {
        return new Blob([await readFile(join(root, p))])
      } catch {
        return null
      }
    },
    async list(p) {
      try {
        return (await readdir(join(root, p), { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory() }))
      } catch {
        return null
      }
    },
    async write(p, data, append) {
      await mkdir(dirname(join(root, p)), { recursive: true })
      await (append ? appendFile : writeFile)(join(root, p), data)
    },
    async remove(p) {
      await rm(join(root, p), { force: true })
    },
  }
}

let clock = 1_700_000_000
export function git(cwd: string, ...args: string[]): string {
  clock += 3600
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Tester',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Tester',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: `${clock} +0800`,
      GIT_COMMITTER_DATE: `${clock} +0800`,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim()
}

export function commitFile(dir: string, name: string, text: string, msg: string) {
  writeFileSync(join(dir, name), text)
  git(dir, 'add', name)
  git(dir, 'commit', '-q', '-m', msg)
}

// main: c1 - c2 - c3 - merge(feature) - c5 (loose), feature: c2 - f1 - f2; tags v1 (annotated, c2), light (f1)
export function makeRepo(format: 'sha1' | 'sha256' = 'sha1') {
  const dir = mkdtempSync(join(tmpdir(), 'giteditor-'))
  git(dir, 'init', '-q', '-b', 'main', `--object-format=${format}`)
  let text = ''
  const grow = (n: number) => {
    for (let i = 0; i < n; i++) text += `line ${i} ${'x'.repeat(40)}\n`
    return text
  }
  commitFile(dir, 'a.txt', grow(200), 'c1')
  commitFile(dir, 'a.txt', grow(5), 'c2\n\nbody of c2')
  git(dir, 'tag', '-a', 'v1', '-m', 'version 1')
  git(dir, 'checkout', '-q', '-b', 'feature')
  commitFile(dir, 'b.txt', 'feature\n', 'f1')
  git(dir, 'tag', 'light')
  commitFile(dir, 'b.txt', 'feature 2\n', 'f2')
  git(dir, 'checkout', '-q', 'main')
  commitFile(dir, 'a.txt', grow(5), 'c3')
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge feature', 'feature')
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(dir, 'gc', '-q', '--aggressive')
  commitFile(dir, 'a.txt', grow(5), 'c5')
  return dir
}

export async function open(dir: string) {
  const { fs } = await findGitDir(nodeFs(dir))
  const repo = await Repo.open(fs)
  const state: RefState = { refs: new Map(repo.refs), head: { ...repo.head } }
  const history = await loadHistory(repo, state)
  return { repo, state, history }
}
