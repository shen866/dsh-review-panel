import assert from 'node:assert/strict'
import { realpath } from 'node:fs/promises'
import test from 'node:test'

import {
  changesRoute,
  commitMessageRoute,
  commitStartRoute,
  commitStatusRoute,
  modelsRoute,
  reviewLatestRoute,
  reviewStartRoute,
  reviewStatusRoute,
} from '../dist/web/routes.js'

function mockRes() {
  return {
    statusCode: 0,
    body: undefined,
    setHeader() {},
    end(payload) { this.body = JSON.parse(payload) },
  }
}

function fakeService() {
  const calls = []
  return {
    calls,
    async collect(options) {
      calls.push(options)
      return { cwd: options.cwd, scope: options.scope, files: [], patch: '', truncated: false }
    },
  }
}

test('session id resolves to the session workspace path', async () => {
  const service = fakeService()
  const workspaces = () => ({ list: () => [{ path: '/repo/a', sessionIds: ['s-1'] }] })
  const route = changesRoute(service, workspaces)
  const res = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/changes?scope=working-tree&session=s-1' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.cwd, '/repo/a')
  assert.equal(service.calls[0].cwd, '/repo/a')
})

test('the session workspace path is realpath-normalized', async () => {
  const service = fakeService()
  const workspaces = () => ({ list: () => [{ path: '/tmp', sessionIds: ['s-1'] }] })
  const route = changesRoute(service, workspaces)
  const res = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/changes?session=s-1' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(service.calls[0].cwd, await realpath('/tmp'))
})

test('a session request is 503 while the workspace registry is unavailable', async () => {
  const service = fakeService()
  const route = changesRoute(service, () => undefined)
  const res = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/changes?session=s-1' }, res)
  assert.equal(res.statusCode, 503)
  assert.match(res.body.error, /workspace registry unavailable/)
  assert.equal(service.calls.length, 0)
})

test('unknown session id is a 400', async () => {
  const service = fakeService()
  const workspaces = () => ({ list: () => [{ path: '/repo/a', sessionIds: ['s-1'] }] })
  const route = changesRoute(service, workspaces)
  const res = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/changes?session=nope' }, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /no workspace found/)
  assert.equal(service.calls.length, 0)
})

test('changes route rejects an invalid scope with 400', async () => {
  const route = changesRoute(fakeService())
  const res = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/changes?scope=bogus' }, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /invalid scope/)
})

test('without a session the route falls back to process.cwd()', async () => {
  const service = fakeService()
  const route = changesRoute(service)
  const res = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/changes' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(service.calls[0].cwd, process.cwd())
})

test('route failures return a generic 500 without the internal message', async () => {
  const service = {
    async collect() { throw new Error('fatal: bad revision (stderr leaking local paths)') },
  }
  const route = changesRoute(service)
  const res = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/changes' }, res)
  assert.equal(res.statusCode, 500)
  assert.equal(res.body.error, 'internal error')
})

function fakeRunner() {
  const started = []
  return {
    started,
    start(changeSet, selection) {
      started.push({ changeSet, selection })
      return { id: 'run-1', status: 'running' }
    },
    get(id) {
      if (id !== 'run-1') return undefined
      return { id, status: 'done', model: 'deepseek/deepseek-chat', text: '结论', startedAt: 1 }
    },
  }
}

function fakeServiceWithFiles() {
  return {
    async collect(options) {
      return {
        cwd: options.cwd,
        scope: options.scope,
        files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
        patch: 'x',
        truncated: false,
      }
    },
  }
}

test('review start collects the workspace diff and returns the run id', async () => {
  const runner = fakeRunner()
  const workspaces = () => ({ list: () => [{ path: '/repo/a', sessionIds: ['s-1'] }] })
  const route = reviewStartRoute(fakeServiceWithFiles(), runner, workspaces)
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/review/start?session=s-1' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.id, 'run-1')
  assert.equal(runner.started[0].changeSet.cwd, '/repo/a')
  assert.equal(runner.started[0].selection, undefined)
})

test('review start forwards an explicit provider/model pair', async () => {
  const runner = fakeRunner()
  const route = reviewStartRoute(fakeServiceWithFiles(), runner)
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/review/start?provider=openai&model=gpt-5' }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(runner.started[0].selection, { provider: 'openai', model: 'gpt-5' })
})

test('review start treats empty provider/model as absent', async () => {
  const runner = fakeRunner()
  const route = reviewStartRoute(fakeServiceWithFiles(), runner)
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/review/start?provider=&model=' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(runner.started[0].selection, undefined)
})

test('review start still requires provider and model as a pair', async () => {
  const runner = fakeRunner()
  const route = reviewStartRoute(fakeServiceWithFiles(), runner)
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/review/start?provider=&model=gpt-5' }, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /同时指定/)
  assert.equal(runner.started.length, 0)
})

test('review start rejects a lone provider without model', async () => {
  const runner = fakeRunner()
  const route = reviewStartRoute(fakeServiceWithFiles(), runner)
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/review/start?provider=openai' }, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /同时指定/)
  assert.equal(runner.started.length, 0)
})

test('review start rejects when there is nothing to review', async () => {
  const runner = fakeRunner()
  const route = reviewStartRoute(fakeService(), runner)
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/review/start' }, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /无需检视/)
  assert.equal(runner.started.length, 0)
})

test('review start requires POST', async () => {
  const route = reviewStartRoute(fakeService(), fakeRunner())
  const res = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/review/start' }, res)
  assert.equal(res.statusCode, 405)
})

test('review status returns the run, 404 for unknown ids', async () => {
  const route = reviewStatusRoute(fakeRunner())
  const ok = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/review/status?id=run-1' }, ok)
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.body.status, 'done')
  assert.equal(ok.body.text, '结论')
  assert.equal(ok.body.model, 'deepseek/deepseek-chat')
  const missing = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/review/status?id=nope' }, missing)
  assert.equal(missing.statusCode, 404)
})

test('review latest prefers the running run over the store', async () => {
  const runner = {
    runningFor: (cwd) => cwd === '/repo/a' ? { id: 'run-9', status: 'running', startedAt: 1 } : undefined,
  }
  const store = { async get() { return { id: 'old', status: 'done' } } }
  const workspaces = () => ({ list: () => [{ path: '/repo/a', sessionIds: ['s-1'] }] })
  const route = reviewLatestRoute(runner, store, workspaces)
  const res = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/review/latest?session=s-1' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.id, 'run-9')
  assert.equal(res.body.status, 'running')
})

test('review latest returns one shape for running runs and stored records', async () => {
  const workspaces = () => ({ list: () => [{ path: '/repo/a', sessionIds: ['s-1'] }] })
  const runningRes = mockRes()
  await reviewLatestRoute(
    { runningFor: () => ({ id: 'run-9', status: 'running', startedAt: 1 }) },
    { async get() { return null } },
    workspaces,
  ).handler({ method: 'GET', url: '/review-panel/api/review/latest?session=s-1' }, runningRes)
  const record = {
    id: 'old',
    status: 'done',
    model: 'deepseek/deepseek-chat',
    text: '结论',
    findings: [],
    verdict: 'approve',
    error: null,
    startedAt: 1,
    finishedAt: 2,
    cwd: '/repo/a',
  }
  const recordRes = mockRes()
  await reviewLatestRoute(
    { runningFor: () => undefined },
    { async get() { return record } },
    workspaces,
  ).handler({ method: 'GET', url: '/review-panel/api/review/latest?session=s-1' }, recordRes)
  assert.deepEqual(Object.keys(runningRes.body).sort(), Object.keys(recordRes.body).sort())
  assert.equal(runningRes.body.finishedAt, null)
  assert.equal(runningRes.body.cwd, '/repo/a')
  assert.equal(recordRes.body.finishedAt, 2)
  assert.equal(recordRes.body.cwd, '/repo/a')
})

test('review latest falls back to the persisted record', async () => {
  const runner = { runningFor: () => undefined }
  const store = {
    async get(cwd) {
      return cwd === '/repo/a' ? { id: 'old', status: 'done', verdict: 'approve', findings: [] } : null
    },
  }
  const workspaces = () => ({ list: () => [{ path: '/repo/a', sessionIds: ['s-1'] }] })
  const route = reviewLatestRoute(runner, store, workspaces)
  const res = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/review/latest?session=s-1' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.id, 'old')
  assert.equal(res.body.verdict, 'approve')
})

test('review latest is 404 without run or record, 400 for unknown session', async () => {
  const runner = { runningFor: () => undefined }
  const store = { async get() { return null } }
  const workspaces = () => ({ list: () => [{ path: '/repo/a', sessionIds: ['s-1'] }] })
  const route = reviewLatestRoute(runner, store, workspaces)
  const missing = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/review/latest?session=s-1' }, missing)
  assert.equal(missing.statusCode, 404)
  const bad = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/review/latest?session=nope' }, bad)
  assert.equal(bad.statusCode, 400)
})

function fakeCommitRunner() {
  const started = []
  return {
    started,
    start(changeSet, options, selection) {
      started.push({ changeSet, options, selection })
      return { id: 'commit-1', status: 'running', startedAt: 1 }
    },
    get(id) {
      if (id !== 'commit-1') return undefined
      return {
        id,
        status: 'done',
        message: 'fix: 处理空值',
        commit: 'abc1234',
        pushed: true,
        startedAt: 1,
      }
    },
  }
}

test('commit start collects the workspace diff and returns the run id', async () => {
  const runner = fakeCommitRunner()
  const workspaces = () => ({ list: () => [{ path: '/repo/a', sessionIds: ['s-1'] }] })
  const route = commitStartRoute(fakeServiceWithFiles(), runner, workspaces)
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/commit/start?session=s-1&message=' + encodeURIComponent('fix: 处理空值') }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.id, 'commit-1')
  assert.equal(runner.started[0].changeSet.cwd, '/repo/a')
  assert.deepEqual(runner.started[0].options, { push: false, message: 'fix: 处理空值' })
})

test('commit start forwards the push flag', async () => {
  const runner = fakeCommitRunner()
  const route = commitStartRoute(fakeServiceWithFiles(), runner)
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/commit/start?push=1&message=' + encodeURIComponent('feat: 新功能') }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(runner.started[0].options, { push: true, message: 'feat: 新功能' })
})

test('commit start rejects a missing or blank message instead of generating one', async () => {
  const runner = fakeCommitRunner()
  const route = commitStartRoute(fakeServiceWithFiles(), runner)
  const missing = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/commit/start' }, missing)
  assert.equal(missing.statusCode, 400)
  assert.match(missing.body.error, /缺少 commit 信息/)
  const blank = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/commit/start?message=+%20' }, blank)
  assert.equal(blank.statusCode, 400)
  assert.match(blank.body.error, /缺少 commit 信息/)
  assert.equal(runner.started.length, 0)
})

test('commit start rejects when there is nothing to commit', async () => {
  const runner = fakeCommitRunner()
  const route = commitStartRoute(fakeService(), runner)
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/commit/start?message=' + encodeURIComponent('fix: 处理空值') }, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /无需提交/)
  assert.equal(runner.started.length, 0)
})

test('commit start requires POST', async () => {
  const route = commitStartRoute(fakeService(), fakeCommitRunner())
  const res = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/commit/start' }, res)
  assert.equal(res.statusCode, 405)
})

test('commit message starts a message-only run and returns the run id', async () => {
  const runner = fakeCommitRunner()
  const workspaces = () => ({ list: () => [{ path: '/repo/a', sessionIds: ['s-1'] }] })
  const route = commitMessageRoute(fakeServiceWithFiles(), runner, workspaces)
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/commit/message?session=s-1' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.id, 'commit-1')
  assert.equal(runner.started[0].changeSet.cwd, '/repo/a')
  assert.deepEqual(runner.started[0].options, { push: false, messageOnly: true })
  assert.equal(runner.started[0].selection, undefined)
})

test('commit message forwards an explicit provider/model pair', async () => {
  const runner = fakeCommitRunner()
  const route = commitMessageRoute(fakeServiceWithFiles(), runner)
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/commit/message?provider=openai&model=gpt-5' }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(runner.started[0].selection, { provider: 'openai', model: 'gpt-5' })
})

test('commit message still requires provider and model as a pair', async () => {
  const runner = fakeCommitRunner()
  const route = commitMessageRoute(fakeServiceWithFiles(), runner)
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/commit/message?provider=openai' }, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /同时指定/)
  assert.equal(runner.started.length, 0)
})

test('commit message rejects when there is nothing to generate from', async () => {
  const runner = fakeCommitRunner()
  const route = commitMessageRoute(fakeService(), runner)
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/commit/message' }, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /无需生成/)
  assert.equal(runner.started.length, 0)
})

test('commit message requires POST', async () => {
  const route = commitMessageRoute(fakeService(), fakeCommitRunner())
  const res = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/commit/message' }, res)
  assert.equal(res.statusCode, 405)
})

test('commit status returns the run, 404 for unknown ids', async () => {
  const route = commitStatusRoute(fakeCommitRunner())
  const ok = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/commit/status?id=commit-1' }, ok)
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(ok.body, {
    id: 'commit-1',
    status: 'done',
    message: 'fix: 处理空值',
    commit: 'abc1234',
    pushed: true,
    pushError: null,
    error: null,
    startedAt: 1,
  })
  const missing = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/commit/status?id=nope' }, missing)
  assert.equal(missing.statusCode, 404)
})

function fakeLlm(listModelsImpl) {
  return () => ({
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'broken', name: 'Broken' }],
    listModels: listModelsImpl ?? (async (provider) => provider === 'broken'
      ? Promise.reject(new Error('no catalog'))
      : [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }]),
  })
}

test('models route lists providers, their catalogs, and the default', async () => {
  const route = modelsRoute(fakeLlm(), () => ({ currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }))
  const res = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/models' }, res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body.default, { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(res.body.providers.length, 2)
  assert.deepEqual(res.body.providers[0], {
    id: 'deepseek',
    name: 'DeepSeek',
    models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }],
  })
  // A provider whose catalog listing fails still appears, with empty models.
  assert.deepEqual(res.body.providers[1], { id: 'broken', name: 'Broken', models: [] })
})

test('models route is 503 without the llm service, and tolerates no default', async () => {
  const missing = modelsRoute(() => undefined, () => undefined)
  const res = mockRes()
  await missing.handler({ method: 'GET', url: '/review-panel/api/models' }, res)
  assert.equal(res.statusCode, 503)

  const route = modelsRoute(fakeLlm(), () => undefined)
  const ok = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/models' }, ok)
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.body.default, null)
})

test('GET routes reject non-GET methods with 405', async () => {
  const changes = changesRoute(fakeService())
  const changesRes = mockRes()
  await changes.handler({ method: 'POST', url: '/review-panel/api/changes' }, changesRes)
  assert.equal(changesRes.statusCode, 405)

  const status = reviewStatusRoute(fakeRunner())
  const statusRes = mockRes()
  await status.handler({ method: 'POST', url: '/review-panel/api/review/status?id=run-1' }, statusRes)
  assert.equal(statusRes.statusCode, 405)

  const latest = reviewLatestRoute({ runningFor: () => undefined }, { async get() { return null } })
  const latestRes = mockRes()
  await latest.handler({ method: 'POST', url: '/review-panel/api/review/latest' }, latestRes)
  assert.equal(latestRes.statusCode, 405)

  const models = modelsRoute(fakeLlm(), () => undefined)
  const modelsRes = mockRes()
  await models.handler({ method: 'POST', url: '/review-panel/api/models' }, modelsRes)
  assert.equal(modelsRes.statusCode, 405)
})

function repoOf(changeSet, extra = {}) {
  return {
    isRepo: true,
    branch: 'main',
    head: 'abc1234',
    detached: false,
    unborn: false,
    operation: null,
    conflicts: [],
    upstream: null,
    ahead: 0,
    behind: 0,
    stashes: 0,
    ...extra,
  }
}

function fakeServiceWithRepo(files, repoExtra) {
  return {
    async collect(options) {
      const repo = repoOf(null, repoExtra)
      return {
        cwd: options.cwd,
        scope: options.scope,
        files,
        patch: 'x',
        truncated: false,
        repo,
      }
    },
  }
}

test('review start rejects a non-git directory', async () => {
  const runner = fakeRunner()
  const route = reviewStartRoute(fakeServiceWithRepo([], { isRepo: false }), runner)
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/review/start' }, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /不是 git 仓库/)
  assert.equal(runner.started.length, 0)
})

test('commit start rejects a directory with unresolved conflicts', async () => {
  const runner = fakeCommitRunner()
  const route = commitStartRoute(
    fakeServiceWithRepo([{ path: 'a.txt', status: 'modified', additions: 4, deletions: 0 }], {
      operation: 'merge',
      conflicts: ['a.txt'],
    }),
    runner,
  )
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/commit/start?message=' + encodeURIComponent('fix: 处理空值') }, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /冲突/)
  assert.equal(runner.started.length, 0)
})

test('commit start still works while a merge finishes without conflicts', async () => {
  const runner = fakeCommitRunner()
  const route = commitStartRoute(
    fakeServiceWithRepo([{ path: 'a.txt', status: 'modified', additions: 1, deletions: 0 }], {
      operation: 'merge',
      conflicts: [],
    }),
    runner,
  )
  const res = mockRes()
  await route.handler({ method: 'POST', url: '/review-panel/api/commit/start?message=' + encodeURIComponent('fix: 处理空值') }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(runner.started.length, 1)
})

test('changes route passes the repo status through', async () => {
  const service = fakeServiceWithRepo([], { ahead: 2, upstream: 'origin/main', operation: 'rebase', conflicts: ['a.txt'] })
  const route = changesRoute(service)
  const res = mockRes()
  await route.handler({ method: 'GET', url: '/review-panel/api/changes' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.repo.ahead, 2)
  assert.equal(res.body.repo.operation, 'rebase')
  assert.deepEqual(res.body.repo.conflicts, ['a.txt'])
})
