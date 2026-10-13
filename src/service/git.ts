import { spawn } from 'node:child_process'

import type { ChangeSet, FileChange, FileStatus, ReviewScope } from './types.js'

export const DEFAULT_MAX_PATCH_BYTES = 512 * 1024

export interface CollectOptions {
  /** Repository root; must be inside a git work tree. */
  cwd: string
  scope: ReviewScope
  /** Base commit for the "since-ref" scope; the diff is `ref..HEAD`. */
  ref?: string | null
  /** Base branch for the "branch" scope; the diff is `baseBranch...HEAD`. */
  baseBranch?: string | null
  maxPatchBytes?: number
  signal?: AbortSignal
}

/** Well-known hash of the empty tree, used as the diff base before the first commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function diffRange(options: CollectOptions): string[] {
  switch (options.scope) {
    case 'working-tree':
      return ['HEAD']
    case 'since-ref':
      if (!options.ref) {
        throw new Error('collectChanges: `ref` is required when scope is "since-ref"')
      }
      return [`${options.ref}..HEAD`]
    case 'branch':
      if (!options.baseBranch) {
        throw new Error('collectChanges: `baseBranch` is required when scope is "branch"')
      }
      return [`${options.baseBranch}...HEAD`]
  }
}

/** `working-tree` diffs against HEAD, or the empty tree when there are no commits yet. */
async function resolveRange(options: CollectOptions): Promise<string[]> {
  const range = diffRange(options)
  if (options.scope !== 'working-tree') return range
  const hasHead = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], options.cwd, options.signal)
    .then(() => true, () => false)
  return [hasHead ? 'HEAD' : EMPTY_TREE]
}

export function runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'))
      } else {
        const detail = Buffer.concat(stderr).toString('utf8').trim()
        reject(new Error(`git ${args.join(' ')} exited with ${code}: ${detail}`))
      }
    })
  })
}

const STATUS_LETTERS: Record<string, FileStatus> = {
  A: 'added',
  C: 'added',
  M: 'modified',
  T: 'modified',
  D: 'deleted',
  R: 'renamed',
}

/**
 * Parse `git diff --name-status -z`. Tokens are NUL-separated; a status record
 * is the status letter (with optional score), followed by one path, or two
 * paths (old, new) for renames/copies.
 */
export function parseNameStatus(raw: string): FileChange[] {
  const tokens = raw.split('\0').filter((token) => token.length > 0)
  const changes: FileChange[] = []
  for (let i = 0; i < tokens.length; i++) {
    const letter = tokens[i][0]
    const status = STATUS_LETTERS[letter]
    if (!status) continue
    if (letter === 'R' || letter === 'C') {
      const path = tokens[i + 2]
      i += 2
      if (path) changes.push({ path, status, additions: 0, deletions: 0 })
    } else {
      const path = tokens[i + 1]
      i += 1
      if (path) changes.push({ path, status, additions: 0, deletions: 0 })
    }
  }
  return changes
}

/**
 * Parse `git diff --numstat -z`. Records look like `adds\tdels\tpath\0`;
 * renames have an empty path field and the old/new paths follow as separate
 * NUL-terminated tokens. Binary files report `-` for both counters.
 */
export function parseNumstat(raw: string): Map<string, { additions: number; deletions: number }> {
  const tokens = raw.split('\0')
  const stats = new Map<string, { additions: number; deletions: number }>()
  for (let i = 0; i < tokens.length; i++) {
    const header = tokens[i]
    const firstTab = header.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : header.indexOf('\t', firstTab + 1)
    if (secondTab < 0) continue
    const adds = header.slice(0, firstTab)
    const dels = header.slice(firstTab + 1, secondTab)
    const additions = adds === '-' ? 0 : Number(adds) || 0
    const deletions = dels === '-' ? 0 : Number(dels) || 0
    let path = header.slice(secondTab + 1)
    if (path === '') {
      // Rename: skip the old path, key the stats by the new path.
      path = tokens[i + 2]
      i += 2
    }
    if (path) stats.set(path, { additions, deletions })
  }
  return stats
}

/** Pure collection logic, exported so tests can drive it without a harness. */
export async function collectChanges(options: CollectOptions): Promise<ChangeSet> {
  const range = await resolveRange(options)
  const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES
  const [nameStatus, numstat, patch] = await Promise.all([
    runGit(['diff', '--name-status', '-z', ...range], options.cwd, options.signal),
    runGit(['diff', '--numstat', '-z', ...range], options.cwd, options.signal),
    runGit(['diff', ...range], options.cwd, options.signal),
  ])
  const stats = parseNumstat(numstat)
  const files = parseNameStatus(nameStatus).map((change) => ({
    ...change,
    ...(stats.get(change.path) ?? { additions: 0, deletions: 0 }),
  }))
  const truncated = Buffer.byteLength(patch, 'utf8') > maxPatchBytes
  return {
    scope: options.scope,
    cwd: options.cwd,
    ref: options.ref ?? null,
    baseBranch: options.baseBranch ?? null,
    files,
    patch: truncated ? patch.slice(0, maxPatchBytes) : patch,
    truncated,
  }
}
