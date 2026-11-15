import type { RefState } from './history'
import type { Head, Repo } from './repo'
import { diffFiles, flatten, type Change, type Files } from './tree'

// What the page has checked out. It lives only in the page: switching here never touches the repo's
// own HEAD, index or files on disk. `index` null means "same as HEAD's tree", `files` null "same as
// the index", so a clean checkout costs nothing.
export interface Work {
  head: Head
  index: Files | null
  files: Files | null
  rebase: RebaseState | null
}

export type TodoAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop' | 'break'
export interface TodoItem {
  action: TodoAction
  hash: string
}

export interface RebaseState {
  headName: string | null // the branch that moves when it's done
  origHead: string
  onto: string | null
  todo: TodoItem[]
  done: number
  total: number
  picked: number // commits placed so far (squash needs one before it)
  sign: boolean
  ignoreDate: boolean
  committerDateIsAuthorDate: boolean
  force: boolean // make new commits even where the old ones could be kept
}

// Everything undo goes back to.
export interface Snapshot {
  refs: RefState
  work: Work
}

export function headCommit(snap: Snapshot): string | null {
  const h = snap.work.head
  return h.ref ? (snap.refs.refs.get(h.ref) ?? null) : h.hash
}

export async function headTree(repo: Repo, snap: Snapshot): Promise<string | null> {
  const c = headCommit(snap)
  return c ? (await repo.commit(c)).tree : null
}

export async function workFiles(repo: Repo, snap: Snapshot) {
  const head = await flatten(repo, await headTree(repo, snap))
  const index = snap.work.index ?? head
  const files = snap.work.files ?? index
  return { head, index, files }
}

export interface Status {
  staged: Change[]
  unstaged: Change[]
  untracked: string[]
}

export async function status(repo: Repo, snap: Snapshot): Promise<Status> {
  if (!snap.work.index && !snap.work.files) return { staged: [], unstaged: [], untracked: [] }
  const { head, index, files } = await workFiles(repo, snap)
  return {
    staged: diffFiles(head, index),
    unstaged: diffFiles(index, files).filter((c) => c.a),
    untracked: [...files.keys()].filter((p) => !index.has(p)).sort(),
  }
}

export const isClean = (s: Status) => !s.staged.length && !s.unstaged.length
