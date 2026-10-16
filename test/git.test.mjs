import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collectChanges, collectRepoStatus, commitAll } from '../dist/service/git.js'

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-review-panel-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-m', 'init')
  return { dir, git }
}

test('working-tree collects uncommitted changes', async () => {
  const { dir } = initRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    const changeSet = await collectChanges({ cwd: dir, scope: 'working-tree' })
    assert.equal(changeSet.scope, 'working-tree')
    assert.deepEqual(changeSet.files, [{ path: 'a.txt', status: 'modified', additions: 1, deletions: 0 }])
    assert.match(changeSet.patch, /\+two/)
    assert.equal(changeSet.truncated, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('since-ref collects changes after a commit', async () => {
  const { dir, git } = initRepo()
  try {
    const base = git('rev-parse', 'HEAD').trim()
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(dir, 'b.txt'), 'new\n')
    git('add', '.')
    git('commit', '-m', 'second')
    const changeSet = await collectChanges({ cwd: dir, scope: 'since-ref', ref: base })
    assert.deepEqual(
      changeSet.files.map((file) => [file.path, file.status]),
      [
        ['a.txt', 'modified'],
        ['b.txt', 'added'],
      ],
    )
    assert.equal(changeSet.ref, base)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('branch collects the full branch against its base', async () => {
  const { dir, git } = initRepo()
  try {
    git('checkout', '-b', 'feature')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    git('add', '.')
    git('commit', '-m', 'feature work')
    const changeSet = await collectChanges({ cwd: dir, scope: 'branch', baseBranch: 'main' })
    assert.deepEqual(changeSet.files, [{ path: 'a.txt', status: 'modified', additions: 1, deletions: 0 }])
    assert.equal(changeSet.baseBranch, 'main')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('since-ref without ref throws', async () => {
  const { dir } = initRepo()
  try {
    await assert.rejects(() => collectChanges({ cwd: dir, scope: 'since-ref' }), /ref/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('working-tree diffs against the empty tree before the first commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-review-panel-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  try {
    git('init', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    git('add', '.')
    const changeSet = await collectChanges({ cwd: dir, scope: 'working-tree' })
    assert.deepEqual(changeSet.files, [{ path: 'a.txt', status: 'added', additions: 1, deletions: 0 }])
    assert.match(changeSet.patch, /\+one/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('since-ref rejects a ref that looks like a git option', async () => {
  const { dir } = initRepo()
  try {
    await assert.rejects(
      () => collectChanges({ cwd: dir, scope: 'since-ref', ref: '--output=/tmp/x' }),
      /invalid ref/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('branch rejects a baseBranch containing a range separator', async () => {
  const { dir } = initRepo()
  try {
    await assert.rejects(
      () => collectChanges({ cwd: dir, scope: 'branch', baseBranch: 'main..other' }),
      /invalid baseBranch/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('working-tree includes untracked files in both files and patch', async () => {
  const { dir } = initRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub/new.txt'), 'line1\nline2\n')
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
    const changeSet = await collectChanges({ cwd: dir, scope: 'working-tree' })
    assert.deepEqual(changeSet.files, [
      { path: 'a.txt', status: 'modified', additions: 1, deletions: 0 },
      { path: 'bin.dat', status: 'added', additions: 0, deletions: 0 },
      { path: 'sub/new.txt', status: 'added', additions: 2, deletions: 0 },
    ])
    // The synthesized section header must stay parseable by the frontend
    // `a/(.*) b/(.*)` regex, including for binary files.
    assert.match(changeSet.patch, /diff --git a\/sub\/new\.txt b\/sub\/new\.txt/)
    assert.match(changeSet.patch, /\+line1/)
    assert.match(changeSet.patch, /Binary files \/dev\/null and b\/bin\.dat differ/)
    assert.equal(changeSet.truncated, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('patch truncation never splits a multibyte character', async () => {
  const { dir } = initRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), '中'.repeat(2000))
    const changeSet = await collectChanges({ cwd: dir, scope: 'working-tree', maxPatchBytes: 1000 })
    assert.equal(changeSet.truncated, true)
    assert.ok(Buffer.byteLength(changeSet.patch, 'utf8') <= 1000)
    // fatal decoding throws on any lone surrogate or truncated sequence.
    assert.doesNotThrow(() =>
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(changeSet.patch, 'utf8')),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('commitAll stages tracked and untracked changes and returns the short hash', async () => {
  const { dir, git } = initRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(dir, 'b.txt'), 'new\n')
    const hash = await commitAll(dir, 'feat: 提交信息\n\n- 要点')
    assert.match(hash, /^[0-9a-f]{7,}$/)
    assert.equal(git('rev-parse', 'HEAD').trim().startsWith(hash), true)
    assert.equal(git('log', '-1', '--pretty=%B').trim(), 'feat: 提交信息\n\n- 要点'.trim())
    // Everything committed: the working tree is clean again.
    const after = await collectChanges({ cwd: dir, scope: 'working-tree' })
    assert.deepEqual(after.files, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a non-git directory reports isRepo false instead of throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-review-panel-'))
  try {
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    const status = await collectRepoStatus(dir)
    assert.equal(status.isRepo, false)
    const changeSet = await collectChanges({ cwd: dir, scope: 'working-tree' })
    assert.equal(changeSet.repo.isRepo, false)
    assert.deepEqual(changeSet.files, [])
    assert.equal(changeSet.patch, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repo status reports the branch and unborn head of a fresh repo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-review-panel-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  try {
    git('init', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    const status = await collectRepoStatus(dir)
    assert.equal(status.isRepo, true)
    assert.equal(status.branch, 'main')
    assert.equal(status.unborn, true)
    assert.equal(status.head, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repo status reports ahead count and upstream after a commit beyond the remote', async () => {
  const { dir, git } = initRepo()
  const remote = mkdtempSync(join(tmpdir(), 'dsh-review-remote-'))
  try {
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: remote })
    git('remote', 'add', 'origin', remote)
    git('push', '-u', 'origin', 'main')
    let status = await collectRepoStatus(dir)
    assert.equal(status.upstream, 'origin/main')
    assert.equal(status.ahead, 0)
    assert.equal(status.behind, 0)
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    git('commit', '-am', 'second')
    status = await collectRepoStatus(dir)
    assert.equal(status.ahead, 1)
    assert.equal(status.behind, 0)
    // Committed-not-pushed changes are invisible to the working-tree diff,
    // but the lifecycle status still reports them.
    const changeSet = await collectChanges({ cwd: dir, scope: 'working-tree' })
    assert.deepEqual(changeSet.files, [])
    assert.equal(changeSet.repo.ahead, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})

test('repo status detects a merge conflict and its resolution', async () => {
  const { dir, git } = initRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'base')
    git('checkout', '-b', 'feature')
    writeFileSync(join(dir, 'a.txt'), 'feature\n')
    git('commit', '-am', 'feature')
    git('checkout', 'main')
    writeFileSync(join(dir, 'a.txt'), 'main\n')
    git('commit', '-am', 'main')
    try { git('merge', 'feature') } catch { /* conflict expected */ }
    let status = await collectRepoStatus(dir)
    assert.equal(status.operation, 'merge')
    assert.deepEqual(status.conflicts, ['a.txt'])
    const during = await collectChanges({ cwd: dir, scope: 'working-tree' })
    assert.equal(during.repo.operation, 'merge')
    assert.ok(during.patch.includes('<<<<<<< HEAD'))
    // Resolving and staging clears the conflict list but not the operation.
    writeFileSync(join(dir, 'a.txt'), 'resolved\n')
    git('add', '.')
    status = await collectRepoStatus(dir)
    assert.equal(status.operation, 'merge')
    assert.deepEqual(status.conflicts, [])
    git('commit', '-m', 'merge feature')
    status = await collectRepoStatus(dir)
    assert.equal(status.operation, null)
    assert.deepEqual(status.conflicts, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repo status detects a conflicted rebase as rebase, not merge', async () => {
  const { dir, git } = initRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'base')
    git('checkout', '-b', 'feature')
    writeFileSync(join(dir, 'a.txt'), 'feature\n')
    git('commit', '-am', 'feature')
    git('checkout', 'main')
    writeFileSync(join(dir, 'a.txt'), 'main\n')
    git('commit', '-am', 'main')
    git('checkout', 'feature')
    try { git('rebase', 'main') } catch { /* conflict expected */ }
    const status = await collectRepoStatus(dir)
    assert.equal(status.operation, 'rebase')
    assert.deepEqual(status.conflicts, ['a.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repo status detects a conflicted cherry-pick', async () => {
  const { dir, git } = initRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'base\n')
    git('add', '.')
    git('commit', '-m', 'base')
    git('checkout', '-b', 'side')
    writeFileSync(join(dir, 'a.txt'), 'side\n')
    git('commit', '-am', 'side')
    git('checkout', 'main')
    writeFileSync(join(dir, 'a.txt'), 'main\n')
    git('commit', '-am', 'main')
    try { git('cherry-pick', 'side') } catch { /* conflict expected */ }
    const status = await collectRepoStatus(dir)
    assert.equal(status.operation, 'cherry-pick')
    assert.deepEqual(status.conflicts, ['a.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('repo status reports detached HEAD and stashes', async () => {
  const { dir, git } = initRepo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    git('commit', '-am', 'c2')
    git('checkout', '-q', 'HEAD~1')
    let status = await collectRepoStatus(dir)
    assert.equal(status.detached, true)
    assert.equal(status.branch, null)
    assert.equal(status.unborn, false)
    git('checkout', '-q', 'main')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
    git('stash')
    status = await collectRepoStatus(dir)
    assert.equal(status.stashes, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
