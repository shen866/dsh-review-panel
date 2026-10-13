import { randomUUID } from 'node:crypto'

import type { ChangeSet } from '../service/types.js'

export type ReviewStatus = 'running' | 'done' | 'error'

/** An explicit provider/model pair chosen by the caller (the panel's picker). */
export interface ReviewModelSelection {
  provider: string
  model: string
}

export interface ReviewRun {
  id: string
  status: ReviewStatus
  /** "provider/model" the review actually runs on, set once execution starts. */
  model?: string
  /** Final review text when status is "done". */
  text?: string
  /** Failure detail when status is "error". */
  error?: string
  startedAt: number
  /** Settles when the run leaves "running"; used by tests, never serialized. */
  settled: Promise<void>
}

export interface ModelSelectionLike {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface AgentHandleLike {
  agent: unknown
  dispose(): Promise<void>
}

export interface SubagentRunLike {
  result: Promise<{
    output: { type: string; text?: string }[]
    stopReason: string
    diagnostic?: string
  }>
  dispose(): Promise<void>
}

/** Host services the runner needs, resolved lazily (they may start after us). */
export interface ReviewRunnerDeps {
  agents(): { create(options: Record<string, unknown>): Promise<AgentHandleLike> } | undefined
  subagents(): { start(name: string, request: Record<string, unknown>): Promise<SubagentRunLike> } | undefined
  agentDefaultModel(): { currentSelection(): ModelSelectionLike } | undefined
  timeoutMs?: number
}

export const DEFAULT_REVIEW_TIMEOUT_MS = 10 * 60 * 1000

export function buildReviewPrompt(changeSet: ChangeSet): string {
  const fileList = changeSet.files
    .map((file) => `- ${file.path}（${file.status}，+${file.additions} -${file.deletions}）`)
    .join('\n')
  return [
    '你是一名资深代码评审员。请评审以下代码变更（unified diff），用中文输出评审结论。',
    '',
    '要求：',
    '1. 先给一段总体评价（变更意图、整体质量）。',
    '2. 按严重程度列出发现的问题（bug、边界条件、并发/事务、安全、性能、可读性），每条注明文件和大致位置；没有问题的方面不要硬凑。',
    '3. 最后给出明确的结论：可以提交 / 建议修改后提交 / 必须修改。',
    '4. 直接输出 Markdown 文本，不要调用任何工具，不要修改任何文件。',
    '',
    `变更文件（${changeSet.files.length} 个）：`,
    fileList || '（无）',
    '',
    'Diff：',
    changeSet.patch || '（无变更内容）',
    changeSet.truncated ? '\n（注意：diff 过长已被截断，结论请标注这一点）' : '',
  ].join('\n')
}

/**
 * Runs one-shot code reviews on independent subagents. Each start() creates a
 * throwaway root agent as the parent (the webhook plugin pattern), spawns a
 * "spawn" provider child with the review prompt, and resolves when the
 * child's final assistant message lands. At most one running review per repo.
 */
export class ReviewRunner {
  private runs = new Map<string, ReviewRun>()
  private runningByRepo = new Map<string, string>()

  constructor(private deps: ReviewRunnerDeps) {}

  get(id: string): ReviewRun | undefined {
    return this.runs.get(id)
  }

  /** Starts a review, or returns the already-running one for the same repo. */
  start(changeSet: ChangeSet, selection?: ReviewModelSelection): ReviewRun {
    const existingId = this.runningByRepo.get(changeSet.cwd)
    const existing = existingId ? this.runs.get(existingId) : undefined
    if (existing && existing.status === 'running') return existing

    const run: ReviewRun = { id: randomUUID(), status: 'running', startedAt: Date.now(), settled: Promise.resolve() }
    run.settled = this.execute(run, changeSet, selection)
    this.runs.set(run.id, run)
    this.runningByRepo.set(changeSet.cwd, run.id)
    return run
  }

  private async execute(run: ReviewRun, changeSet: ChangeSet, requested?: ReviewModelSelection): Promise<void> {
    const fail = (error: unknown) => {
      run.status = 'error'
      run.error = error instanceof Error ? error.message : String(error)
    }
    let handle: AgentHandleLike | undefined
    let sub: SubagentRunLike | undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS)
    try {
      const agents = this.deps.agents()
      const subagents = this.deps.subagents()
      if (!agents || !subagents) throw new Error('智能体服务不可用（需要 agents / subagents）')
      const selection = requested ?? this.deps.agentDefaultModel()?.currentSelection()
      if (!selection) throw new Error('无法确定检视使用的模型：未指定模型，且宿主没有默认模型')
      run.model = `${selection.provider}/${selection.model}`
      handle = await agents.create({
        sessionId: `review-${run.id}`,
        signal: controller.signal,
        meta: { cwd: changeSet.cwd },
        agentOptions: { provider: selection.provider, model: selection.model },
      })
      sub = await subagents.start('spawn', {
        label: '代码检视',
        parent: handle.agent,
        signal: controller.signal,
        prompt: [{ type: 'text', text: buildReviewPrompt(changeSet) }],
        // Explicit child route: without it the child inherits the parent's,
        // which already matches — but stating it keeps the choice intact even
        // if the throwaway parent's resolution changes later.
        agentOptions: { provider: selection.provider, model: selection.model },
      })
      const result = await sub.result
      if (result.stopReason === 'completed') {
        run.status = 'done'
        run.text = result.output.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
      } else if (controller.signal.aborted) {
        fail(new Error('检视超时或被取消'))
      } else {
        fail(new Error(result.diagnostic ?? `子智能体异常结束（${result.stopReason}）`))
      }
    } catch (error) {
      fail(controller.signal.aborted ? new Error('检视超时或被取消') : error)
    } finally {
      clearTimeout(timer)
      await sub?.dispose().catch(() => {})
      await handle?.dispose().catch(() => {})
    }
  }
}
