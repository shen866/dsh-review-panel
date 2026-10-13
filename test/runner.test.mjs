import assert from 'node:assert/strict'
import test from 'node:test'

import { buildReviewPrompt, ReviewRunner } from '../dist/review/runner.js'

const changeSet = {
  scope: 'working-tree',
  cwd: '/repo/a',
  ref: null,
  baseBranch: null,
  files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
  patch: '@@ -1 +1 @@\n-old\n+new',
  truncated: false,
}

function fakeDeps(result) {
  const calls = { created: 0, started: 0, createdOptions: null, spawnRequest: null }
  return {
    calls,
    agents: () => ({
      async create(options) {
        calls.created++
        calls.createdOptions = options
        return { agent: { fake: true }, async dispose() {} }
      },
    }),
    subagents: () => ({
      async start(name, request) {
        calls.started++
        calls.spawnRequest = request
        assert.equal(name, 'spawn')
        assert.equal(request.parent.fake, true)
        assert.match(request.prompt[0].text, /a\.ts/)
        return {
          result: Promise.resolve(result),
          async dispose() {},
        }
      },
    }),
    agentDefaultModel: () => ({ currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }),
  }
}

test('prompt lists files and embeds the patch', () => {
  const prompt = buildReviewPrompt(changeSet)
  assert.match(prompt, /a\.ts（modified，\+1 -0）/)
  assert.match(prompt, /\+new/)
})

test('a completed subagent run resolves to done with its text', async () => {
  const deps = fakeDeps({ stopReason: 'completed', output: [{ type: 'text', text: '总体良好' }] })
  const runner = new ReviewRunner(deps)
  const run = runner.start(changeSet)
  assert.equal(run.status, 'running')
  await run.settled
  assert.equal(run.status, 'done')
  assert.equal(run.text, '总体良好')
  assert.equal(run.model, 'deepseek/deepseek-chat')
  assert.equal(deps.calls.created, 1)
  assert.equal(deps.calls.started, 1)
})

test('an explicit model selection overrides the host default', async () => {
  const deps = fakeDeps({ stopReason: 'completed', output: [] })
  const runner = new ReviewRunner(deps)
  const run = runner.start(changeSet, { provider: 'openai', model: 'gpt-5' })
  await run.settled
  assert.equal(run.status, 'done')
  assert.equal(run.model, 'openai/gpt-5')
  assert.deepEqual(deps.calls.createdOptions.agentOptions, { provider: 'openai', model: 'gpt-5' })
  assert.deepEqual(deps.calls.spawnRequest.agentOptions, { provider: 'openai', model: 'gpt-5' })
})

test('without a selection the host default model is used', async () => {
  const deps = fakeDeps({ stopReason: 'completed', output: [] })
  const runner = new ReviewRunner(deps)
  const run = runner.start(changeSet)
  await run.settled
  assert.deepEqual(deps.calls.createdOptions.agentOptions, { provider: 'deepseek', model: 'deepseek-chat' })
})

test('no selection and no host default fails the run', async () => {
  const deps = fakeDeps({ stopReason: 'completed', output: [] })
  deps.agentDefaultModel = () => undefined
  const runner = new ReviewRunner(deps)
  const run = runner.start(changeSet)
  await run.settled
  assert.equal(run.status, 'error')
  assert.match(run.error, /无法确定检视使用的模型/)
})

test('a second start on the same repo reuses the running review', async () => {
  const deps = fakeDeps({ stopReason: 'completed', output: [] })
  const runner = new ReviewRunner(deps)
  const first = runner.start(changeSet)
  const second = runner.start(changeSet)
  assert.equal(second.id, first.id)
  await first.settled
  assert.equal(deps.calls.started, 1)
})

test('a non-completed stop reason becomes an error', async () => {
  const deps = fakeDeps({ stopReason: 'error', output: [], diagnostic: 'boom' })
  const runner = new ReviewRunner(deps)
  const run = runner.start(changeSet)
  await run.settled
  assert.equal(run.status, 'error')
  assert.equal(run.error, 'boom')
})

test('missing agent services fail the run', async () => {
  const runner = new ReviewRunner({ agents: () => undefined, subagents: () => undefined, agentDefaultModel: () => undefined })
  const run = runner.start(changeSet)
  await run.settled
  assert.equal(run.status, 'error')
  assert.match(run.error, /不可用/)
})
