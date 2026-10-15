/**
 * One-shot "generate a commit message, then commit (and optionally push)"
 * runs. The message comes from an independent subagent reading the working
 * tree diff (same spawn pattern as ReviewRunner); the git operations run
 * server-side afterwards. At most one running commit per repo. The git calls
 * are injectable so tests never touch a real repository.
 */

import { randomUUID } from 'node:crypto'

import { commitAll, pushCurrentBranch } from '../service/git.js'
import type { ChangeSet } from '../service/types.js'
import type {
  AgentHandleLike,
  ModelSelectionLike,
  ReviewModelSelection,
  SubagentRunLike,
} from './runner.js'

export type CommitStatus = 'running' | 'done' | 'error'

export interface CommitRun {
  id: string
  status: CommitStatus
  /** Generated commit message once the subagent answered. */
  message?: string
  /** Short hash of the created commit. */
  commit?: string
  /** Whether the run was asked to push (false when not requested). */
  pushed?: boolean
  /** Push failed AFTER a successful commit; the commit itself stands. */
  pushError?: string
  /** Failure detail when status is "error". */
  error?: string
  startedAt: number
  /** Settles when the run leaves "running"; used by tests, never serialized. */
  settled: Promise<void>
}

export interface CommitRunnerDeps {
  agents(): { create(options: Record<string, unknown>): Promise<AgentHandleLike> } | undefined
  subagents(): { start(name: string, request: Record<string, unknown>): Promise<SubagentRunLike> } | undefined
  agentDefaultModel(): { currentSelection(): ModelSelectionLike } | undefined
  /** Git operations; default to the real helpers in service/git.js. */
  commit?(cwd: string, message: string, signal?: AbortSignal): Promise<string>
  push?(cwd: string, signal?: AbortSignal): Promise<void>
  timeoutMs?: number
}

export const DEFAULT_COMMIT_TIMEOUT_MS = 3 * 60 * 1000

export function buildCommitMessagePrompt(changeSet: ChangeSet): string {
  const fileList = changeSet.files
    .map((file) => `- ${file.path}（${file.status}，+${file.additions} -${file.deletions}）`)
    .join('\n')
  return [
    '你是一名资深工程师。请根据以下代码变更（unified diff）编写一条 git commit 信息。',
    '',
    '要求：',
    '1. 使用 Conventional Commits 格式：<type>(<scope>): <subject>，subject 用中文概括变更意图，不超过 72 个字符。',
    '2. 变更较多时可在空行后添加正文，每条要点一行、以 - 开头；变更单一时只输出首行。',
    '3. 只输出 commit 信息本身，不要包裹代码块，不要输出任何解释。',
    '4. 直接输出，不要调用任何工具，不要修改任何文件。',
    '',
    `变更文件（${changeSet.files.length} 个）：`,
    fileList || '（无）',
    '',
    'Diff：',
    changeSet.patch || '（无变更内容）',
    changeSet.truncated ? '\n（注意：diff 过长已被截断）' : '',
  ].join('\n')
}

/**
 * Recover the commit message from the subagent's raw answer: trim whitespace
 * and unwrap a single surrounding code fence when the model added one anyway.
 */
export function extractCommitMessage(raw: string): string {
  let text = raw.trim()
  const fenced = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(text)
  if (fenced) text = fenced[1].trim()
  return text
}

/** Fallback when the model answered with nothing usable. */
function fallbackMessage(changeSet: ChangeSet): string {
  return `chore: 更新 ${changeSet.files.length} 个文件`
}

export class CommitRunner {
  private runs = new Map<string, CommitRun>()
  private runningByRepo = new Map<string, string>()

  constructor(private deps: CommitRunnerDeps) {}

  get(id: string): CommitRun | undefined {
    return this.runs.get(id)
  }

  /** Starts a commit run, or returns the already-running one for the same repo. */
  start(changeSet: ChangeSet, options: { push: boolean }, selection?: ReviewModelSelection): CommitRun {
    const existingId = this.runningByRepo.get(changeSet.cwd)
    const existing = existingId ? this.runs.get(existingId) : undefined
    if (existing && existing.status === 'running') return existing

    const run: CommitRun = { id: randomUUID(), status: 'running', startedAt: Date.now(), settled: Promise.resolve() }
    run.settled = this.execute(run, changeSet, options.push, selection)
    this.runs.set(run.id, run)
    this.runningByRepo.set(changeSet.cwd, run.id)
    return run
  }

  /** The currently-running commit for a repo, if any. */
  runningFor(cwd: string): CommitRun | undefined {
    const id = this.runningByRepo.get(cwd)
    const run = id ? this.runs.get(id) : undefined
    return run && run.status === 'running' ? run : undefined
  }

  private async execute(
    run: CommitRun,
    changeSet: ChangeSet,
    pushRequested: boolean,
    requested?: ReviewModelSelection,
  ): Promise<void> {
    const fail = (error: unknown) => {
      run.status = 'error'
      run.error = error instanceof Error ? error.message : String(error)
    }
    let handle: AgentHandleLike | undefined
    let sub: SubagentRunLike | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('提交超时'))
      }, this.deps.timeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS)
    })
    try {
      const agents = this.deps.agents()
      const subagents = this.deps.subagents()
      if (!agents || !subagents) throw new Error('智能体服务不可用（需要 agents / subagents）')
      const selection = requested ?? this.deps.agentDefaultModel()?.currentSelection()
      if (!selection) throw new Error('无法确定生成 commit 信息使用的模型：未指定模型，且宿主没有默认模型')
      handle = await Promise.race([agents.create({
        sessionId: `commit-${run.id}`,
        signal: controller.signal,
        meta: { cwd: changeSet.cwd },
        agentOptions: { provider: selection.provider, model: selection.model },
      }), timeout])
      sub = await Promise.race([subagents.start('spawn', {
        label: '生成 commit 信息',
        parent: handle.agent,
        signal: controller.signal,
        prompt: [{ type: 'text', text: buildCommitMessagePrompt(changeSet) }],
        agentOptions: { provider: selection.provider, model: selection.model },
      }), timeout])
      sub.result.catch(() => {})
      const result = await Promise.race([sub.result, timeout])
      if (result.stopReason !== 'completed') {
        if (controller.signal.aborted) throw new Error('生成 commit 信息超时或被取消')
        throw new Error(result.diagnostic ?? `子智能体异常结束（${result.stopReason}）`)
      }
      const raw = result.output.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
      const message = extractCommitMessage(raw) || fallbackMessage(changeSet)
      run.message = message
      const commit = this.deps.commit ?? commitAll
      const push = this.deps.push ?? pushCurrentBranch
      run.commit = await Promise.race([commit(changeSet.cwd, message, controller.signal), timeout])
      if (pushRequested) {
        try {
          await Promise.race([push(changeSet.cwd, controller.signal), timeout])
          run.pushed = true
        } catch (error) {
          run.pushed = false
          run.pushError = error instanceof Error ? error.message : String(error)
        }
      } else {
        run.pushed = false
      }
      run.status = 'done'
    } catch (error) {
      fail(controller.signal.aborted ? new Error('提交超时或被取消') : error)
    } finally {
      if (timer) clearTimeout(timer)
      if (this.runningByRepo.get(changeSet.cwd) === run.id) this.runningByRepo.delete(changeSet.cwd)
      await sub?.dispose().catch(() => {})
      await handle?.dispose().catch(() => {})
    }
  }
}
