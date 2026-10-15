import { randomUUID } from 'node:crypto'

import type { ChangeSet } from '../service/types.js'
import { parseReviewFindings, type ReviewFinding, type ReviewVerdict } from './findings.js'
import type { ReviewRecord, ReviewStoreLike } from './store.js'

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
  /** Final review text when status is "done" (findings fence stripped). */
  text?: string
  /** Structured findings parsed from the answer; null when absent/broken. */
  findings?: ReviewFinding[] | null
  verdict?: ReviewVerdict | null
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
  /** Latest-review persistence; absent, settled runs simply stay in memory. */
  store?: ReviewStoreLike
  timeoutMs?: number
}

export const DEFAULT_REVIEW_TIMEOUT_MS = 10 * 60 * 1000

/** Settled runs older than this are evicted from the in-memory map. */
const SETTLED_RUN_RETENTION_MS = 60 * 60 * 1000

export function buildReviewPrompt(changeSet: ChangeSet): string {
  const fileList = changeSet.files
    .map((file) => `- ${file.path}（${file.status}，+${file.additions} -${file.deletions}）`)
    .join('\n')
  return [
    '你是一名资深代码评审员。请评审以下代码变更（unified diff），用中文逐条输出检视意见。',
    '',
    '评审要求：',
    '1. 覆盖 bug、边界条件、并发/事务、安全、性能、可读性等方面；没有问题的方面不要硬凑。',
    '2. 直接输出，不要调用任何工具，不要修改任何文件。',
    '3. 不要输出总体评价、总结或成段的问题清单正文；检视意见只通过下面的结构化格式逐条给出。',
    '',
    '输出格式：',
    '所有检视意见必须在回答末尾的 review-findings 代码块中以 JSON 给出：',
    '',
    '```review-findings',
    '{"findings":[{"severity":"critical | normal | suggestion","path":"diff 中的文件路径","side":"new | old","line":123,"quote":"被评论那行代码的内容","title":"短标题","detail":"问题说明与修改建议"}]}',
    '```',
    '',
    '- severity 分三级：critical=严重（必须修复的 bug、安全或正确性问题），normal=一般（应当修改的问题），suggestion=建议（可选的改进）。',
    '- quote 必须从下方 diff 逐字复制该行内容（不含行首的 +、- 或空格），line 是可选的新文件行号，side 缺省为 new。',
    '- 无法定位到具体行的问题省略 quote 和 line，作为文件级意见；没有发现问题则 findings 为 []。',
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
  private settledAt = new Map<string, number>()

  constructor(private deps: ReviewRunnerDeps) {}

  get(id: string): ReviewRun | undefined {
    return this.runs.get(id)
  }

  /** Starts a review, or returns the already-running one for the same repo. */
  start(changeSet: ChangeSet, selection?: ReviewModelSelection): ReviewRun {
    const existingId = this.runningByRepo.get(changeSet.cwd)
    const existing = existingId ? this.runs.get(existingId) : undefined
    if (existing && existing.status === 'running') return existing
    // Only the latest review per repo is kept; drop the settled predecessor.
    if (existingId) {
      this.runs.delete(existingId)
      this.settledAt.delete(existingId)
    }
    this.evictSettled()

    const run: ReviewRun = { id: randomUUID(), status: 'running', startedAt: Date.now(), settled: Promise.resolve() }
    run.settled = this.execute(run, changeSet, selection)
    this.runs.set(run.id, run)
    this.runningByRepo.set(changeSet.cwd, run.id)
    return run
  }

  /** Drops settled runs past the retention window so the map stays bounded. */
  private evictSettled(): void {
    const now = Date.now()
    for (const [id, run] of this.runs) {
      if (run.status === 'running') continue
      if (now - (this.settledAt.get(id) ?? run.startedAt) <= SETTLED_RUN_RETENTION_MS) continue
      this.runs.delete(id)
      this.settledAt.delete(id)
    }
  }

  /** The currently-running review for a repo, if any (for the latest route). */
  runningFor(cwd: string): ReviewRun | undefined {
    const id = this.runningByRepo.get(cwd)
    const run = id ? this.runs.get(id) : undefined
    return run && run.status === 'running' ? run : undefined
  }

  private async execute(run: ReviewRun, changeSet: ChangeSet, requested?: ReviewModelSelection): Promise<void> {
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
        reject(new Error('检视超时'))
      }, this.deps.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS)
    })
    try {
      const agents = this.deps.agents()
      const subagents = this.deps.subagents()
      if (!agents || !subagents) throw new Error('智能体服务不可用（需要 agents / subagents）')
      const selection = requested ?? this.deps.agentDefaultModel()?.currentSelection()
      if (!selection) throw new Error('无法确定检视使用的模型：未指定模型，且宿主没有默认模型')
      run.model = `${selection.provider}/${selection.model}`
      handle = await Promise.race([agents.create({
        sessionId: `review-${run.id}`,
        signal: controller.signal,
        meta: { cwd: changeSet.cwd },
        agentOptions: { provider: selection.provider, model: selection.model },
      }), timeout])
      sub = await Promise.race([subagents.start('spawn', {
        label: '代码检视',
        parent: handle.agent,
        signal: controller.signal,
        prompt: [{ type: 'text', text: buildReviewPrompt(changeSet) }],
        // Explicit child route: without it the child inherits the parent's,
        // which already matches — but stating it keeps the choice intact even
        // if the throwaway parent's resolution changes later.
        agentOptions: { provider: selection.provider, model: selection.model },
      }), timeout])
      // Attach a noop catch up front so an already-rejected sub.result between
      // start() resolving and the await below never surfaces as an
      // unhandledRejection.
      sub.result.catch(() => {})
      const result = await Promise.race([sub.result, timeout])
      if (result.stopReason === 'completed') {
        run.status = 'done'
        const raw = result.output.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
        const parsed = parseReviewFindings(raw)
        run.text = parsed ? parsed.text : raw
        run.findings = parsed ? parsed.findings : null
        run.verdict = parsed ? parsed.verdict : null
      } else if (controller.signal.aborted) {
        fail(new Error('检视超时或被取消'))
      } else {
        fail(new Error(result.diagnostic ?? `子智能体异常结束（${result.stopReason}）`))
      }
    } catch (error) {
      fail(controller.signal.aborted ? new Error('检视超时或被取消') : error)
    } finally {
      if (timer) clearTimeout(timer)
      this.settledAt.set(run.id, Date.now())
      if (this.runningByRepo.get(changeSet.cwd) === run.id) this.runningByRepo.delete(changeSet.cwd)
      await this.persist(run, changeSet.cwd)
      await sub?.dispose().catch(() => {})
      await handle?.dispose().catch(() => {})
    }
  }

  /**
   * Persist the settled run as the repo's latest review record. A store
   * failure is swallowed: persistence must never fail the review itself.
   */
  private async persist(run: ReviewRun, cwd: string): Promise<void> {
    const store = this.deps.store
    if (!store || run.status === 'running') return
    const record: ReviewRecord = {
      id: run.id,
      status: run.status,
      model: run.model ?? null,
      text: run.text ?? null,
      findings: run.findings ?? null,
      verdict: run.verdict ?? null,
      error: run.error ?? null,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      cwd,
    }
    await store.put(cwd, record).catch(() => {})
  }
}
