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
}
