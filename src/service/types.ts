/**
 * Review scopes supported by the panel and the reviewer.
 * Hoisted enum tuples MUST carry `as const`, or they widen to `string[]`.
 */
export const REVIEW_SCOPES = ['working-tree', 'since-ref', 'branch'] as const
export type ReviewScope = (typeof REVIEW_SCOPES)[number]

export const FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed'] as const
export type FileStatus = (typeof FILE_STATUSES)[number]

export type FileChange = {
  path: string
  status: FileStatus
  additions: number
  deletions: number
}

/** In-progress git operations the panel surfaces as lifecycle state. */
export const REPO_OPERATIONS = ['merge', 'rebase', 'cherry-pick', 'revert'] as const
export type RepoOperation = (typeof REPO_OPERATIONS)[number]

/**
 * Where the repository stands in the git workflow, collected alongside the
 * diff so the panel can explain states a plain `git diff HEAD` cannot:
 * not-yet-a-repo, an unfinished merge/rebase, or commits waiting to be pushed.
 */
export type RepoStatus = {
  /** false when cwd is not inside a git work tree (or git is unavailable). */
  isRepo: boolean
  /** Current branch short name; null when detached or not a repo. */
  branch: string | null
  /** HEAD commit hash; null before the first commit (unborn HEAD). */
  head: string | null
  /** HEAD is detached (checkout of a commit/tag, or mid-rebase). */
  detached: boolean
  /** No commits yet; diffs fall back to the empty tree. */
  unborn: boolean
  /** Unfinished merge/rebase/cherry-pick/revert, if any. */
  operation: RepoOperation | null
  /** Paths with unresolved merge conflicts. */
  conflicts: string[]
  /** Upstream short name (e.g. origin/main); null when none is configured. */
  upstream: string | null
  /** Commits ahead of / behind the upstream; 0 without an upstream. */
  ahead: number
  behind: number
  /** Entries in the stash list. */
  stashes: number
}

/**
 * Output-facing shape: members must not be optional (an `undefined` property
 * fails a JSON node), so absent values are `null`.
 */
export type ChangeSet = {
  scope: ReviewScope
  cwd: string
  ref: string | null
  baseBranch: string | null
  files: FileChange[]
  patch: string
  truncated: boolean
  /** Lifecycle state of the repository the diff was collected from. */
  repo: RepoStatus
}
