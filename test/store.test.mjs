import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ReviewStore } from '../dist/review/store.js'

function record(id, extra = {}) {
  return {
    id,
    status: 'done',
    model: 'deepseek/deepseek-chat',
    text: '结论',
    findings: null,
    verdict: 'approve',
    error: null,
    startedAt: 1,
    finishedAt: 2,
    cwd: '/repo/a',
    ...extra,
  }
}

test('put then get round-trips the latest record per repo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-store-'))
  // The storage directory (including missing parents) is created on demand.
  const store = new ReviewStore(join(dir, 'nested'))
  assert.equal(await store.get('/repo/a'), null)
  await store.put('/repo/a', record('r1'))
  await store.put('/repo/b', record('r2', { cwd: '/repo/b' }))
  assert.equal((await store.get('/repo/a')).id, 'r1')
  assert.equal((await store.get('/repo/b')).id, 'r2')
})

test('a second put replaces the repo previous record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-store-'))
  const store = new ReviewStore(dir)
  await store.put('/repo/a', record('r1'))
  await store.put('/repo/a', record('r2', { text: '新结论', verdict: 'must-fix' }))
  const latest = await store.get('/repo/a')
  assert.equal(latest.id, 'r2')
  assert.equal(latest.text, '新结论')
  assert.equal(latest.verdict, 'must-fix')
})

test('concurrent puts for different repos keep every record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-store-'))
  const store = new ReviewStore(dir)
  const repos = Array.from({ length: 10 }, (_, i) => join(dir, `repo-${i}`))
  await Promise.all(repos.map((cwd, i) => store.put(cwd, record(`r${i}`, { cwd }))))
  for (let i = 0; i < repos.length; i++) {
    assert.equal((await store.get(repos[i])).id, `r${i}`)
  }
})

test('a corrupted table reads as empty and recovers on the next put', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-store-'))
  await writeFile(join(dir, 'reviews.json'), '{oops')
  const store = new ReviewStore(dir)
  assert.equal(await store.get('/repo/a'), null)
  await store.put('/repo/a', record('r1'))
  assert.equal((await store.get('/repo/a')).id, 'r1')
})

test('clear removes only the repo own record and persists the removal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-store-'))
  const store = new ReviewStore(dir)
  await store.put('/repo/a', record('r1'))
  await store.put('/repo/b', record('r2', { cwd: '/repo/b' }))
  await store.clear('/repo/a')
  assert.equal(await store.get('/repo/a'), null)
  assert.equal((await store.get('/repo/b')).id, 'r2')
  // The deletion survives a fresh store over the same table.
  const reopened = new ReviewStore(dir)
  assert.equal(await reopened.get('/repo/a'), null)
  assert.equal((await reopened.get('/repo/b')).id, 'r2')
})

test('clear on an unknown repo is a no-op', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-review-store-'))
  const store = new ReviewStore(dir)
  await store.put('/repo/a', record('r1'))
  await store.clear('/repo/never-seen')
  assert.equal((await store.get('/repo/a')).id, 'r1')
})
