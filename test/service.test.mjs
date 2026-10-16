import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import ReviewPanelService from '../dist/service/index.js'

// The cordis Service constructor only touches `ctx.reflect.provide`, and
// `collect()` itself is ctx-free, so a stub ctx is enough to exercise the
// option-merge logic against a real git repo.
function fakeCtx() {
  return { reflect: { provide() {} } }
}

function makeService(overrides = {}) {
  const config = {
    defaultBaseBranch: 'main',
    maxPatchBytes: 512 * 1024,
    storageDir: join(tmpdir(), 'dsh-review-store-test'),
    ...overrides,
  }
  return new ReviewPanelService(fakeCtx(), config)
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-review-panel-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-m', 'init')
  git('checkout', '-b', 'feature')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  git('add', '.')
  git('commit', '-m', 'feature work')
  return dir
}

test('branch scope falls back to the configured defaultBaseBranch on null', async () => {
  const dir = initRepo()
  try {
    // The web routes pass `null` for a missing `base` query param; that null
    // must NOT override the configured default.
    const changeSet = await makeService().collect({ cwd: dir, scope: 'branch', ref: null, baseBranch: null })
    assert.equal(changeSet.baseBranch, 'main')
    assert.deepEqual(changeSet.files, [{ path: 'a.txt', status: 'modified', additions: 1, deletions: 0 }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('branch scope falls back to the configured defaultBaseBranch when omitted', async () => {
  const dir = initRepo()
  try {
    const changeSet = await makeService().collect({ cwd: dir, scope: 'branch' })
    assert.equal(changeSet.baseBranch, 'main')
    assert.equal(changeSet.files.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an explicit baseBranch still wins over the configured default', async () => {
  const dir = initRepo()
  try {
    // The feature branch is identical to its own tip; diffing it against
    // itself yields no changes while the default would find the commit.
    const changeSet = await makeService().collect({
      cwd: dir, scope: 'branch', ref: null, baseBranch: 'feature',
    })
    assert.equal(changeSet.baseBranch, 'feature')
    assert.equal(changeSet.files.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the service class carries the cordis Config schema', () => {
  assert.ok(ReviewPanelService.Config)
  const resolved = ReviewPanelService.Config({})
  assert.equal(resolved.defaultBaseBranch, 'main')
  assert.equal(resolved.maxPatchBytes, 512 * 1024)
  assert.equal(resolved.storageDir, '~/.dsh-review-panel')
})

test('a missing storageDir falls back to the schema default', () => {
  // Cordis normally fills defaults from the schema; without the static Config
  // the constructor still must not crash on an absent storageDir.
  const service = new ReviewPanelService(fakeCtx(), { defaultBaseBranch: 'main', maxPatchBytes: 512 * 1024 })
  assert.ok(service.reviewStore)
})
