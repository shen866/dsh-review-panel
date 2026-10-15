import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collectChanges, commitAll } from '../dist/service/git.js'

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
