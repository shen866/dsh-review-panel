import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { ChangeSet, FileChange, FileStatus, RepoOperation, RepoStatus, ReviewScope } from './types.js'

export const DEFAULT_MAX_PATCH_BYTES = 512 * 1024

/** Guard rails for untracked-file handling in the working-tree scope. */
const MAX_UNTRACKED_FILES = 100
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024
const BINARY_SNIFF_BYTES = 8000

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

/**
 * Conservative refname pattern: covers branches/tags (`feature/x`, `v1.2.3`),
 * emails in authored ranges, and revision suffixes (`HEAD~2`, `v1^{}`). Refs
 * starting with `-` are rejected separately so they can never be parsed as
 * git options, and `..` is forbidden so the value can never widen the range.
 */
const REF_PATTERN = /^[\w./@{}^~+-]+$/

function assertSafeRef(ref: string, name: string): void {
  if (ref.startsWith('-') || ref.includes('..') || !REF_PATTERN.test(ref)) {
    throw new Error(
      `collectChanges: invalid ${name} ${JSON.stringify(ref)}; expected a branch, tag or commit`,
    )
  }
}

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
  const hasHead = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], options.cwd, {
    signal: options.signal,
  }).then(
    () => true,
    (error) => {
      if (error instanceof Error) {
        const match = /exited with (\d+):([\s\S]*)$/.exec(error.message)
        const detail = match?.[2].trim() ?? ''
        // `--quiet` reports a missing HEAD as exit 1 with empty stderr; a
        // non-quiet failure still names HEAD in the message. Anything else
        // (git missing, spawn failure, abort) must propagate.
        if (match && (detail === '' || /HEAD|ambiguous argument|Needed a single revision/i.test(detail))) {
          return false
        }
      }
      throw error
    },
  )
  return [hasHead ? 'HEAD' : EMPTY_TREE]
}

export interface RunGitOptions {
  signal?: AbortSignal
  /** Cap on buffered stdout bytes; the child is killed once it is exceeded. */
  maxBytes?: number
  /** Non-zero exit codes that are not errors (`diff --no-index` uses 1 for "differences"). */
  allowExitCodes?: readonly number[]
}

export interface GitOutput {
  stdout: string
  truncated: boolean
}

export function runGit(args: string[], cwd: string, options: RunGitOptions = {}): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, signal: options.signal, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let truncated = false
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > maxBytes) {
        truncated = true
        stdout.push(chunk.subarray(0, chunk.length - (stdoutBytes - maxBytes)))
        child.kill('SIGKILL')
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      let output = Buffer.concat(stdout).toString('utf8')
      if (truncated) {
        // The byte cap may have landed mid-sequence; drop the U+FFFD that
        // Buffer.toString emits for the incomplete tail, then trim until the
        // decoded string fits the budget again.
        if (output.endsWith('\uFFFD')) output = output.slice(0, -1)
        while (Buffer.byteLength(output, 'utf8') > maxBytes) {
          output = output.slice(0, -1)
        }
        if (/[\uD800-\uDBFF]$/.test(output)) output = output.slice(0, -1)
        resolve({ stdout: output, truncated: true })
        return
      }
      if (code === 0 || (code !== null && options.allowExitCodes?.includes(code))) {
        resolve({ stdout: output, truncated: false })
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

/** RepoStatus for a directory that is not a usable git work tree. */
function notARepo(): RepoStatus {
  return {
    isRepo: false,
    branch: null,
    head: null,
    detached: false,
    unborn: false,
    operation: null,
    conflicts: [],
    upstream: null,
    ahead: 0,
    behind: 0,
    stashes: 0,
  }
}

/**
 * Parse the branch header and unmerged entries of
 * `git status --porcelain=v2 --branch -z --untracked-files=no`
 * (records are NUL-separated; `-z` keeps paths raw, never quoted).
 */
export function parseStatusBranch(raw: string): Pick<
  RepoStatus,
  'branch' | 'head' | 'detached' | 'unborn' | 'upstream' | 'ahead' | 'behind' | 'conflicts'
> {
  let branch: string | null = null
  let head: string | null = null
  let detached = false
  let unborn = false
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const conflicts: string[] = []
  for (const record of raw.split('\0')) {
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice('# branch.oid '.length)
      // `(initial)` marks an unborn HEAD; anything else is the commit hash.
      if (value === '(initial)') unborn = true
      else head = value
    } else if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length)
      if (value === '(detached)') detached = true
      else branch = value
    } else if (record.startsWith('# branch.upstream ')) {
      upstream = record.slice('# branch.upstream '.length)
    } else if (record.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(record)
      if (match) {
        ahead = Number(match[1]) || 0
        behind = Number(match[2]) || 0
      }
    } else if (record.startsWith('u ')) {
      // Unmerged record: `u XY sub m1 m2 m3 mW h1 h2 h3 <path>`; the path is
      // everything after the tenth space (it may contain spaces; `-z` keeps
      // it raw). A rename appends the source path as its own NUL record,
      // which simply matches no prefix here and is skipped.
      const path = record.split(' ').slice(10).join(' ')
      if (path) conflicts.push(path)
    }
  }
  return { branch, head, detached, unborn, upstream, ahead, behind, conflicts }
}

/** True when a `git rev-parse -q --verify <name>` succeeded (name exists). */
function refExists(result: GitOutput): boolean {
  return result.stdout.trim().length > 0
}

/** Detect an unfinished merge/rebase/cherry-pick/revert from repo metadata. */
async function detectOperation(cwd: string, signal?: AbortSignal): Promise<RepoOperation | null> {
  const probe = (name: string) =>
    runGit(['rev-parse', '-q', '--verify', name], cwd, { signal, allowExitCodes: [1] })
  const [merge, cherryPick, revert, rebaseMerge, rebaseApply] = await Promise.all([
    probe('MERGE_HEAD'),
    probe('CHERRY_PICK_HEAD'),
    probe('REVERT_HEAD'),
    runGit(['rev-parse', '--git-path', 'rebase-merge'], cwd, { signal }),
    runGit(['rev-parse', '--git-path', 'rebase-apply'], cwd, { signal }),
  ])
  // An unfinished rebase is checked first: it also stages conflicts, so a
  // bare MERGE_HEAD probe would mislabel it as a merge on some git versions.
  if (existsSync(resolve(cwd, rebaseMerge.stdout.trim())) || existsSync(resolve(cwd, rebaseApply.stdout.trim()))) {
    return 'rebase'
  }
  if (refExists(cherryPick)) return 'cherry-pick'
  if (refExists(revert)) return 'revert'
  if (refExists(merge)) return 'merge'
  return null
}

/**
 * Inspect where the git repository at `cwd` stands in its lifecycle. Never
 * throws for "not a repository" — that is a first-class state the panel
 * renders — but propagates unexpected git failures.
 */
export async function collectRepoStatus(cwd: string, signal?: AbortSignal): Promise<RepoStatus> {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, { signal }).then(
    (result) => result.stdout.trim() === 'true',
    (error) => {
      // Missing cwd or missing git binary both surface as ENOENT from spawn.
      if (error instanceof Error && ((error as NodeJS.ErrnoException).code === 'ENOENT' || /not a git repository/i.test(error.message))) {
        return false
      }
      throw error
    },
  )
  if (!inside) return notARepo()
  const [status, stash, operation] = await Promise.all([
    runGit(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'], cwd, { signal }),
    runGit(['stash', 'list'], cwd, { signal }),
    detectOperation(cwd, signal),
  ])
  return {
    isRepo: true,
    operation,
    stashes: stash.stdout.trim() ? stash.stdout.trim().split('\n').length : 0,
    ...parseStatusBranch(status.stdout),
  }
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

function countLines(content: Buffer): number {
  if (content.length === 0) return 0
  let lines = 0
  for (const byte of content) {
    if (byte === 0x0a) lines += 1
  }
  return content[content.length - 1] === 0x0a ? lines : lines + 1
}

async function readUntrackedFile(cwd: string, path: string): Promise<Buffer | null> {
  try {
    const info = await stat(join(cwd, path))
    if (!info.isFile() || info.size > MAX_UNTRACKED_FILE_BYTES) return null
    return await readFile(join(cwd, path))
  } catch {
    return null
  }
}

/**
 * Untracked files are invisible to `git diff HEAD`; list them and synthesize
 * per-file patches with `diff --no-index` (exit 1 means "differences", not an
 * error). File entries are always kept, but a patch section is skipped once
 * the byte budget is exhausted.
 */
async function collectUntracked(
  options: CollectOptions,
  usedBytes: number,
  maxPatchBytes: number,
): Promise<{ files: FileChange[]; patch: string; truncated: boolean }> {
  const { stdout } = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], options.cwd, {
    signal: options.signal,
  })
  const paths = stdout
    .split('\0')
    .filter((path) => path.length > 0)
    .slice(0, MAX_UNTRACKED_FILES)
  const files: FileChange[] = []
  const sections: string[] = []
  let remaining = maxPatchBytes - usedBytes
  let truncated = false
  for (const path of paths) {
    const content = await readUntrackedFile(options.cwd, path)
    const binary = content !== null && content.subarray(0, BINARY_SNIFF_BYTES).includes(0)
    files.push({
      path,
      status: 'added',
      additions: content === null || binary ? 0 : countLines(content),
      deletions: 0,
    })
    if (content === null || remaining <= 0) continue
    const section = await runGit(
      ['-c', 'core.quotePath=false', 'diff', '--no-index', '--', '/dev/null', path],
      options.cwd,
      { signal: options.signal, maxBytes: remaining, allowExitCodes: [1] },
    )
    if (section.truncated) {
      truncated = true
      continue
    }
    remaining -= Buffer.byteLength(section.stdout, 'utf8')
    sections.push(section.stdout)
  }
  return { files, patch: sections.join(''), truncated }
}

/** Pure collection logic, exported so tests can drive it without a harness. */
export async function collectChanges(options: CollectOptions): Promise<ChangeSet> {
  if (options.ref) assertSafeRef(options.ref, 'ref')
  if (options.baseBranch) assertSafeRef(options.baseBranch, 'baseBranch')
  // Lifecycle state first: a non-repository is a first-class result, not an
  // error, and a merge/rebase in progress is context the panel must surface.
  const repo = await collectRepoStatus(options.cwd, options.signal)
  if (!repo.isRepo) {
    return {
      scope: options.scope,
      cwd: options.cwd,
      ref: options.ref ?? null,
      baseBranch: options.baseBranch ?? null,
      files: [],
      patch: '',
      truncated: false,
      repo,
    }
  }
  const range = await resolveRange(options)
  const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES
  const [nameStatus, numstat, patchResult] = await Promise.all([
    runGit(['diff', '--name-status', '-z', ...range], options.cwd, { signal: options.signal }),
    runGit(['diff', '--numstat', '-z', ...range], options.cwd, { signal: options.signal }),
    runGit(['-c', 'core.quotePath=false', 'diff', ...range], options.cwd, {
      signal: options.signal,
      maxBytes: maxPatchBytes,
    }),
  ])
  const stats = parseNumstat(numstat.stdout)
  const files = parseNameStatus(nameStatus.stdout).map((change) => ({
    ...change,
    ...(stats.get(change.path) ?? { additions: 0, deletions: 0 }),
  }))
  let patch = patchResult.stdout
  let truncated = patchResult.truncated
  if (options.scope === 'working-tree') {
    const untracked = await collectUntracked(options, Buffer.byteLength(patch, 'utf8'), maxPatchBytes)
    files.push(...untracked.files)
    patch += untracked.patch
    truncated ||= untracked.truncated
  }
  return {
    scope: options.scope,
    cwd: options.cwd,
    ref: options.ref ?? null,
    baseBranch: options.baseBranch ?? null,
    files,
    patch,
    truncated,
    repo,
  }
}

/**
 * Stage everything (including untracked files, matching the working-tree
 * diff the panel shows) and commit; returns the new commit's short hash.
 * The message travels as a single argv element, so quoting/newlines in it
 * never touch a shell.
 */
export async function commitAll(cwd: string, message: string, signal?: AbortSignal): Promise<string> {
  await runGit(['add', '-A'], cwd, { signal })
  await runGit(['commit', '-m', message], cwd, { signal })
  const { stdout } = await runGit(['rev-parse', '--short', 'HEAD'], cwd, { signal })
  return stdout.trim()
}

/** Push the current branch to its configured upstream. */
export async function pushCurrentBranch(cwd: string, signal?: AbortSignal): Promise<void> {
  await runGit(['push'], cwd, { signal })
}
