import { fromBin } from './bytes'
import type { History, RefState } from './history'
import { commitPayload, insertCommitSig, tagPayload, type CommitEdit } from './objects'
import type { Repo } from './repo'
import type { Signer } from './sign/signer'

// What happens to the signatures of commits rewritten only because a parent got a new hash
// (their old signatures no longer match): dropped, redone with the key where there was one, or
// added to every one of them.
export type DescendantSigs = 'drop' | 'resign' | 'all'

export interface RewriteRequest {
  target: string
  edit: CommitEdit
  sign: boolean // sign the edited commit
  descendants: DescendantSigs
  signer: Signer | null
  moveTags: boolean
}

// Local branches move to the rewritten commits; tags only if asked. Remote branches stay where
// they are: they show what the remote has, which is what the force push will replace.
export const movable = (name: string, moveTags: boolean) =>
  name.startsWith('refs/heads/') || (moveTags && name.startsWith('refs/tags/'))

function reachable(history: History, state: RefState, moveTags: boolean): Set<string> {
  const tips = [...history.peeled].filter(([name]) => movable(name, moveTags) || name === 'HEAD').map(([, h]) => h)
  const seen = new Set<string>()
  while (tips.length) {
    const h = tips.pop()!
    if (seen.has(h)) continue
    const c = history.commits.get(h)
    if (!c) continue
    seen.add(h)
    tips.push(...c.parents)
  }
  if (state.head.hash && !state.head.ref) seen.add(state.head.hash)
  return seen
}

// The target and every descendant a movable ref can reach, parents before children.
export function affected(history: History, state: RefState, target: string, moveTags: boolean): string[] {
  const reach = reachable(history, state, moveTags)
  if (!reach.has(target)) return []
  const set = new Set([target])
  const stack = [target]
  while (stack.length) {
    for (const ch of history.children.get(stack.pop()!) ?? []) {
      if (!set.has(ch) && reach.has(ch)) {
        set.add(ch)
        stack.push(ch)
      }
    }
  }
  const out: string[] = []
  for (let i = history.rows.length - 1; i >= 0; i--) if (set.has(history.rows[i].hash)) out.push(history.rows[i].hash)
  return out
}

export async function rewrite(
  repo: Repo,
  history: History,
  state: RefState,
  req: RewriteRequest,
  onProgress?: (done: number, total: number) => void,
): Promise<{ state: RefState; map: Map<string, string> }> {
  const order = affected(history, state, req.target, req.moveTags)
  if (!order.length) throw new Error('沒有本地分支包含這個 commit，改了也不會有分支指向它。')
  const sigHeader = repo.algo === 'sha256' ? 'gpgsig-sha256' : 'gpgsig'
  const signs = (wasSigned: boolean) => req.descendants === 'all' || (req.descendants === 'resign' && wasSigned)
  const signer = () => {
    if (!req.signer) throw new Error('要簽名，請先載入私鑰。')
    return req.signer
  }

  const map = new Map<string, string>()
  for (const [i, hash] of order.entries()) {
    const c = history.commits.get(hash)!
    const isTarget = hash === req.target
    let payload = commitPayload(c, c.parents.map((p) => map.get(p) ?? p), isTarget ? req.edit : {})
    if (isTarget ? req.sign : signs(!!c.sig) && req.signer) {
      payload = insertCommitSig(payload, sigHeader, await signer().sign(fromBin(payload)))
    }
    map.set(hash, await repo.add('commit', fromBin(payload)))
    onProgress?.(i + 1, order.length)
  }

  // Annotated tags are objects naming the commit, so they're rewritten too (signature redone or dropped).
  const retarget = async (hash: string): Promise<string> => {
    const known = map.get(hash)
    if (known) return known
    if ((await repo.typeOf(hash)) !== 'tag') return hash
    const t = await repo.tag(hash)
    const inner = await retarget(t.object)
    if (inner === t.object) return hash
    let payload = tagPayload(t, inner)
    if (signs(!!t.sig) && req.signer) payload += await req.signer.sign(fromBin(payload))
    const nh = await repo.add('tag', fromBin(payload))
    map.set(hash, nh)
    return nh
  }
  const refs = new Map(state.refs)
  for (const [name, hash] of state.refs) if (movable(name, req.moveTags)) refs.set(name, await retarget(hash))
  const head = state.head.ref
    ? { ref: state.head.ref, hash: refs.get(state.head.ref) ?? null }
    : { ref: null, hash: state.head.hash && (map.get(state.head.hash) ?? state.head.hash) }
  return { state: { refs, head }, map }
}
