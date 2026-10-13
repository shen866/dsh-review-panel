import assert from 'node:assert/strict'
import test from 'node:test'

import { changesRoute } from '../dist/web/routes.js'

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
  await route.handler({ url: '/review-panel/api/changes?scope=working-tree&session=s-1' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.cwd, '/repo/a')
  assert.equal(service.calls[0].cwd, '/repo/a')
})

test('unknown session id is a 400', async () => {
  const service = fakeService()
  const workspaces = () => ({ list: () => [{ path: '/repo/a', sessionIds: ['s-1'] }] })
  const route = changesRoute(service, workspaces)
  const res = mockRes()
  await route.handler({ url: '/review-panel/api/changes?session=nope' }, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /no workspace found/)
  assert.equal(service.calls.length, 0)
})

test('without a session the route falls back to process.cwd()', async () => {
  const service = fakeService()
  const route = changesRoute(service)
  const res = mockRes()
  await route.handler({ url: '/review-panel/api/changes' }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(service.calls[0].cwd, process.cwd())
})

import { reviewStartRoute, reviewStatusRoute } from '../dist/web/routes.js'

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
  await route.handler({ url: '/review-panel/api/review/status?id=run-1' }, ok)
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.body.status, 'done')
  assert.equal(ok.body.text, '结论')
  assert.equal(ok.body.model, 'deepseek/deepseek-chat')
  const missing = mockRes()
  await route.handler({ url: '/review-panel/api/review/status?id=nope' }, missing)
  assert.equal(missing.statusCode, 404)
})

import { modelsRoute } from '../dist/web/routes.js'

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
  await route.handler({ url: '/review-panel/api/models' }, res)
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
  await missing.handler({ url: '/review-panel/api/models' }, res)
  assert.equal(res.statusCode, 503)

  const route = modelsRoute(fakeLlm(), () => undefined)
  const ok = mockRes()
  await route.handler({ url: '/review-panel/api/models' }, ok)
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.body.default, null)
})
