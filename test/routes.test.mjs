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
