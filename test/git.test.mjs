import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collectChanges } from '../dist/service/git.js'

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
