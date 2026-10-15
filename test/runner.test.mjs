import assert from 'node:assert/strict'
import test from 'node:test'

import { parseReviewFindings } from '../dist/review/findings.js'
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

const structuredText = [
  '总体良好，修复了边界问题。',
  '',
  '```review-findings',
  JSON.stringify({
    verdict: 'changes-suggested',
    findings: [
      { severity: 'major', path: 'a.ts', side: 'new', line: 1, quote: 'new', title: '建议处理空值', detail: 'old 可能为空' },
      { path: 'a.ts', detail: '文件级意见' },
      { severity: 'nonsense', path: '' },
      { severity: 'critical' },
    ],
  }),
  '```',
].join('\n')

test('parseReviewFindings strips the fence and normalizes entries', () => {
  const parsed = parseReviewFindings(structuredText)
  assert.ok(parsed)
  assert.equal(parsed.text, '总体良好，修复了边界问题。')
  assert.equal(parsed.verdict, 'changes-suggested')
  assert.equal(parsed.findings.length, 2)
  assert.deepEqual(parsed.findings[0], {
    // Legacy severity ids fold into the current three levels.
    severity: 'normal',
    path: 'a.ts',
    side: 'new',
    line: 1,
    quote: 'new',
    title: '建议处理空值',
    detail: 'old 可能为空',
  })
  // Missing severity/title fall back; a detail-only entry stays file-level.
  assert.equal(parsed.findings[1].severity, 'normal')
  assert.equal(parsed.findings[1].title, '文件级意见')
  assert.equal(parsed.findings[1].quote, null)
  assert.equal(parsed.findings[1].line, null)
})

test('parseReviewFindings keeps the three current severity levels', () => {
  const parsed = parseReviewFindings([
    '```review-findings',
    JSON.stringify({
      findings: [
        { severity: 'critical', path: 'a.ts', detail: 'x' },
        { severity: 'normal', path: 'a.ts', detail: 'y' },
        { severity: 'suggestion', path: 'a.ts', detail: 'z' },
        { severity: 'minor', path: 'a.ts', detail: 'legacy' },
      ],
    }),
    '```',
  ].join('\n'))
  assert.ok(parsed)
  assert.deepEqual(parsed.findings.map((finding) => finding.severity), ['critical', 'normal', 'suggestion', 'normal'])
})

test('parseReviewFindings returns null without a block or with broken JSON', () => {
  assert.equal(parseReviewFindings('没有结构块'), null)
  assert.equal(parseReviewFindings('```review-findings\n{oops\n```'), null)
})

test('parseReviewFindings tolerates an unclosed fence', () => {
  const parsed = parseReviewFindings('结论\n```review-findings\n{"verdict":"approve","findings":[]}')
  assert.ok(parsed)
  assert.equal(parsed.text, '结论')
  assert.equal(parsed.verdict, 'approve')
  assert.deepEqual(parsed.findings, [])
})

test('parseReviewFindings rejects non-integer line numbers', () => {
  const parsed = parseReviewFindings([
    '```review-findings',
    JSON.stringify({
      findings: [
        { path: 'a.ts', line: 1.5, detail: 'x' },
        { path: 'a.ts', line: Infinity, detail: 'y' },
        { path: 'a.ts', line: 2, detail: 'z' },
      ],
    }),
    '```',
  ].join('\n'))
  assert.ok(parsed)
  assert.equal(parsed.findings[0].line, null)
  assert.equal(parsed.findings[1].line, null)
  assert.equal(parsed.findings[2].line, 2)
})

test('parseReviewFindings survives a ``` inside a quote', () => {
  const parsed = parseReviewFindings([
    '总体良好。',
    '',
    '```review-findings',
    JSON.stringify({
      verdict: 'changes-suggested',
      findings: [{ severity: 'minor', path: 'a.ts', line: 1, quote: 'const s = ```嵌套```', title: 't', detail: 'd' }],
    }),
    '```',
  ].join('\n'))
  assert.ok(parsed)
  assert.equal(parsed.verdict, 'changes-suggested')
  assert.equal(parsed.findings.length, 1)
  assert.equal(parsed.findings[0].quote, 'const s = ```嵌套```')
})

test('the review prompt documents the review-findings block', () => {
  const prompt = buildReviewPrompt(changeSet)
  assert.match(prompt, /review-findings/)
  assert.match(prompt, /quote 必须从下方 diff 逐字复制/)
  // Findings-only output: no overall-summary paragraph is requested anymore.
  assert.match(prompt, /不要输出总体评价/)
})

test('a completed run exposes parsed findings and stripped text', async () => {
  const deps = fakeDeps({ stopReason: 'completed', output: [{ type: 'text', text: structuredText }] })
  const runner = new ReviewRunner(deps)
  const run = runner.start(changeSet)
  await run.settled
  assert.equal(run.status, 'done')
  assert.equal(run.text, '总体良好，修复了边界问题。')
  assert.equal(run.verdict, 'changes-suggested')
  assert.equal(run.findings.length, 2)
})

test('a completed run without a findings block keeps the raw text', async () => {
  const deps = fakeDeps({ stopReason: 'completed', output: [{ type: 'text', text: '总体良好' }] })
  const runner = new ReviewRunner(deps)
  const run = runner.start(changeSet)
  await run.settled
  assert.equal(run.status, 'done')
  assert.equal(run.text, '总体良好')
  assert.equal(run.findings, null)
  assert.equal(run.verdict, null)
})

test('a settled run is persisted as the repo latest record', async () => {
  const saved = []
  const deps = fakeDeps({ stopReason: 'completed', output: [{ type: 'text', text: structuredText }] })
  deps.store = { async put(cwd, record) { saved.push({ cwd, record }) }, async get() { return null } }
  const runner = new ReviewRunner(deps)
  const run = runner.start(changeSet)
  await run.settled
  assert.equal(saved.length, 1)
  assert.equal(saved[0].cwd, '/repo/a')
  assert.equal(saved[0].record.id, run.id)
  assert.equal(saved[0].record.status, 'done')
  assert.equal(saved[0].record.model, 'deepseek/deepseek-chat')
  assert.equal(saved[0].record.verdict, 'changes-suggested')
  assert.equal(saved[0].record.findings.length, 2)
  assert.equal(typeof saved[0].record.finishedAt, 'number')
})

test('an errored run is persisted too', async () => {
  const saved = []
  const deps = fakeDeps({ stopReason: 'error', output: [], diagnostic: 'boom' })
  deps.store = { async put(cwd, record) { saved.push(record) }, async get() { return null } }
  const runner = new ReviewRunner(deps)
  const run = runner.start(changeSet)
  await run.settled
  assert.equal(saved.length, 1)
  assert.equal(saved[0].status, 'error')
  assert.equal(saved[0].error, 'boom')
})

test('a store failure never fails the review', async () => {
  const deps = fakeDeps({ stopReason: 'completed', output: [{ type: 'text', text: 'ok' }] })
  deps.store = { async put() { throw new Error('disk full') }, async get() { return null } }
  const runner = new ReviewRunner(deps)
  const run = runner.start(changeSet)
  await run.settled
  assert.equal(run.status, 'done')
  assert.equal(run.text, 'ok')
})

test('a new run on the same repo takes over the running reference', async () => {
  const deps = fakeDeps({ stopReason: 'completed', output: [] })
  const runner = new ReviewRunner(deps)
  const first = runner.start(changeSet)
  await first.settled
  const second = runner.start(changeSet)
  assert.notEqual(second.id, first.id)
  assert.equal(runner.runningFor('/repo/a'), second)
  await second.settled
  assert.equal(runner.runningFor('/repo/a'), undefined)
})

test('a hung sub.result settles via the timeout and cleans up', async () => {
  const disposed = { sub: 0, handle: 0 }
  const deps = {
    timeoutMs: 30,
    agents: () => ({
      async create() {
        return { agent: { fake: true }, async dispose() { disposed.handle++ } }
      },
    }),
    subagents: () => ({
      async start() {
        return { result: new Promise(() => {}), async dispose() { disposed.sub++ } }
      },
    }),
    agentDefaultModel: () => ({ currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }),
  }
  const runner = new ReviewRunner(deps)
  const run = runner.start(changeSet)
  await run.settled
  assert.equal(run.status, 'error')
  assert.match(run.error, /超时/)
  assert.equal(runner.runningFor('/repo/a'), undefined)
  assert.equal(disposed.sub, 1)
  assert.equal(disposed.handle, 1)
})

test('a hung agents.create settles via the timeout', async () => {
  const deps = {
    timeoutMs: 30,
    agents: () => ({ create: () => new Promise(() => {}) }),
    subagents: () => ({ start: async () => { throw new Error('unreachable') } }),
    agentDefaultModel: () => ({ currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }),
  }
  const runner = new ReviewRunner(deps)
  const run = runner.start(changeSet)
  await run.settled
  assert.equal(run.status, 'error')
  assert.match(run.error, /超时/)
  assert.equal(runner.runningFor('/repo/a'), undefined)
})

test('a sub.result rejected before the await never surfaces unhandled', async () => {
  const deps = {
    agents: () => ({
      async create() {
        return { agent: { fake: true }, async dispose() {} }
      },
    }),
    subagents: () => ({
      async start() {
        return { result: Promise.reject(new Error('early boom')), async dispose() {} }
      },
    }),
    agentDefaultModel: () => ({ currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }),
  }
  const runner = new ReviewRunner(deps)
  const run = runner.start(changeSet)
  await run.settled
  assert.equal(run.status, 'error')
  assert.equal(run.error, 'early boom')
  assert.equal(runner.runningFor('/repo/a'), undefined)
})
