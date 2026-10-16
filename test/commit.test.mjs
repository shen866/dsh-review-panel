import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCommitMessagePrompt, extractCommitMessage, CommitRunner } from '../dist/review/commit.js'

const changeSet = {
  scope: 'working-tree',
  cwd: '/repo/a',
  ref: null,
  baseBranch: null,
  files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
  patch: '@@ -1 +1 @@\n-old\n+new',
  truncated: false,
}

function fakeDeps(result, git = {}) {
  const calls = { created: 0, started: 0, committed: [], pushed: [], cleared: [] }
  return {
    calls,
    agents: () => ({
      async create() {
        calls.created++
        return { agent: { fake: true }, async dispose() {} }
      },
    }),
    subagents: () => ({
      async start(name, request) {
        calls.started++
        assert.equal(name, 'spawn')
        assert.match(request.prompt[0].text, /a\.ts/)
        return { result: Promise.resolve(result), async dispose() {} }
      },
    }),
    agentDefaultModel: () => ({ currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }),
    async commit(cwd, message) {
      calls.committed.push({ cwd, message })
      if (git.commitError) throw new Error(git.commitError)
      return git.commitHash ?? 'abc1234'
    },
    async push(cwd) {
      calls.pushed.push(cwd)
      if (git.pushError) throw new Error(git.pushError)
    },
    store: {
      async clear(cwd) {
        calls.cleared.push(cwd)
      },
    },
  }
}

const completed = (text) => ({ stopReason: 'completed', output: [{ type: 'text', text }] })

test('the commit prompt lists files, embeds the patch and demands message-only output', () => {
  const prompt = buildCommitMessagePrompt(changeSet)
  assert.match(prompt, /a\.ts（modified，\+1 -0）/)
  assert.match(prompt, /\+new/)
  assert.match(prompt, /Conventional Commits/)
  assert.match(prompt, /只输出 commit 信息本身/)
})

test('extractCommitMessage trims and unwraps a surrounding fence', () => {
  assert.equal(extractCommitMessage('  fix: 修复空指针\n'), 'fix: 修复空指针')
  assert.equal(extractCommitMessage('```\nfix: 修复空指针\n```'), 'fix: 修复空指针')
  assert.equal(extractCommitMessage('```text\nfeat: 新功能\n\n- 要点一\n```'), 'feat: 新功能\n\n- 要点一')
  assert.equal(extractCommitMessage('   '), '')
})

test('a completed run commits with the generated message and does not push by default', async () => {
  const deps = fakeDeps(completed('fix: 处理空值'))
  const runner = new CommitRunner(deps)
  const run = runner.start(changeSet, { push: false })
  assert.equal(run.status, 'running')
  await run.settled
  assert.equal(run.status, 'done')
  assert.equal(run.message, 'fix: 处理空值')
  assert.equal(run.commit, 'abc1234')
  assert.equal(run.pushed, false)
  assert.deepEqual(deps.calls.committed, [{ cwd: '/repo/a', message: 'fix: 处理空值' }])
  assert.deepEqual(deps.calls.pushed, [])
  assert.deepEqual(deps.calls.cleared, ['/repo/a'])
})

test('a push run pushes after committing', async () => {
  const deps = fakeDeps(completed('feat: 新功能'))
  const runner = new CommitRunner(deps)
  const run = runner.start(changeSet, { push: true })
  await run.settled
  assert.equal(run.status, 'done')
  assert.equal(run.pushed, true)
  assert.deepEqual(deps.calls.pushed, ['/repo/a'])
})

test('a push failure keeps the commit and reports pushError', async () => {
  const deps = fakeDeps(completed('fix: 处理空值'), { pushError: 'no upstream' })
  const runner = new CommitRunner(deps)
  const run = runner.start(changeSet, { push: true })
  await run.settled
  assert.equal(run.status, 'done')
  assert.equal(run.commit, 'abc1234')
  assert.equal(run.pushed, false)
  assert.equal(run.pushError, 'no upstream')
  // The commit stands, so the review record is cleared anyway.
  assert.deepEqual(deps.calls.cleared, ['/repo/a'])
})

test('a failing commit never clears the review store', async () => {
  const deps = fakeDeps(completed('fix: 处理空值'), { commitError: 'nothing to commit' })
  const runner = new CommitRunner(deps)
  const run = runner.start(changeSet, { push: false })
  await run.settled
  assert.equal(run.status, 'error')
  assert.equal(run.error, 'nothing to commit')
  assert.deepEqual(deps.calls.cleared, [])
})

test('an empty model answer falls back to a generated message', async () => {
  const deps = fakeDeps(completed('   '))
  const runner = new CommitRunner(deps)
  const run = runner.start(changeSet, { push: false })
  await run.settled
  assert.equal(run.status, 'done')
  assert.equal(run.message, 'chore: 更新 1 个文件')
  assert.equal(deps.calls.committed[0].message, 'chore: 更新 1 个文件')
})

test('a fenced model answer is unwrapped before committing', async () => {
  const deps = fakeDeps(completed('```\nfix: 处理空值\n```'))
  const runner = new CommitRunner(deps)
  const run = runner.start(changeSet, { push: false })
  await run.settled
  assert.equal(run.message, 'fix: 处理空值')
})

test('a failing subagent errors the run and never touches git', async () => {
  const deps = fakeDeps({ stopReason: 'error', output: [], diagnostic: 'boom' })
  const runner = new CommitRunner(deps)
  const run = runner.start(changeSet, { push: true })
  await run.settled
  assert.equal(run.status, 'error')
  assert.equal(run.error, 'boom')
  assert.deepEqual(deps.calls.committed, [])
  assert.deepEqual(deps.calls.pushed, [])
  assert.deepEqual(deps.calls.cleared, [])
})

test('missing agent services fail the run', async () => {
  const runner = new CommitRunner({ agents: () => undefined, subagents: () => undefined, agentDefaultModel: () => undefined })
  const run = runner.start(changeSet, { push: false })
  await run.settled
  assert.equal(run.status, 'error')
  assert.match(run.error, /不可用/)
})

test('a second start on the same repo reuses the running commit', async () => {
  const deps = fakeDeps(completed('fix: 处理空值'))
  const runner = new CommitRunner(deps)
  const first = runner.start(changeSet, { push: false })
  const second = runner.start(changeSet, { push: true })
  assert.equal(second.id, first.id)
  await first.settled
  assert.equal(deps.calls.started, 1)
})

test('an explicit message is used verbatim and skips the generation subagent', async () => {
  const deps = fakeDeps(completed('generated: 不应使用'))
  const runner = new CommitRunner(deps)
  const run = runner.start(changeSet, { push: true, message: '  docs: 手写信息\n' })
  await run.settled
  assert.equal(run.status, 'done')
  assert.equal(run.message, 'docs: 手写信息')
  assert.equal(deps.calls.created, 0)
  assert.equal(deps.calls.started, 0)
  assert.deepEqual(deps.calls.committed, [{ cwd: '/repo/a', message: 'docs: 手写信息' }])
  assert.deepEqual(deps.calls.pushed, ['/repo/a'])
  assert.deepEqual(deps.calls.cleared, ['/repo/a'])
})

test('a whitespace-only explicit message falls back to generation', async () => {
  const deps = fakeDeps(completed('fix: 处理空值'))
  const runner = new CommitRunner(deps)
  const run = runner.start(changeSet, { push: false, message: '   ' })
  await run.settled
  assert.equal(run.status, 'done')
  assert.equal(run.message, 'fix: 处理空值')
  assert.equal(deps.calls.started, 1)
})

test('a message-only run generates the message and never touches git', async () => {
  const deps = fakeDeps(completed('fix: 处理空值'))
  const runner = new CommitRunner(deps)
  const run = runner.start(changeSet, { push: false, messageOnly: true })
  assert.equal(run.status, 'running')
  await run.settled
  assert.equal(run.status, 'done')
  assert.equal(run.message, 'fix: 处理空值')
  assert.equal(run.commit, undefined)
  assert.equal(run.pushed, false)
  assert.deepEqual(deps.calls.committed, [])
  assert.deepEqual(deps.calls.pushed, [])
  assert.deepEqual(deps.calls.cleared, [])
})

test('message-only ignores a caller-supplied message and always generates', async () => {
  const deps = fakeDeps(completed('fix: 处理空值'))
  const runner = new CommitRunner(deps)
  const run = runner.start(changeSet, { push: false, messageOnly: true, message: 'docs: 手写信息' })
  await run.settled
  assert.equal(run.status, 'done')
  assert.equal(run.message, 'fix: 处理空值')
  assert.equal(deps.calls.started, 1)
  assert.deepEqual(deps.calls.committed, [])
})
