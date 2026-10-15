import { realpath } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { CommitRun, CommitRunner } from '../review/commit.js'
import type { ReviewRun, ReviewRunner } from '../review/runner.js'
import type { ReviewStoreLike } from '../review/store.js'
import type ReviewPanelService from '../service/index.js'
import { REVIEW_SCOPES, type ReviewScope } from '../service/types.js'

export interface WebServerRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

/** Minimal face of the host `workspaceRegistry` service (web profile only). */
export interface WorkspaceRegistryLike {
  list(): { path: string; sessionIds: readonly string[] }[]
}

/** Minimal face of the host `llm` service used by the models route. */
export interface LlmLike {
  listProviders(): { id: string; name: string }[]
  listModels(provider: string): Promise<readonly { id: string; name: string }[]>
}

/** Minimal face of the host `agentDefaultModel` service. */
export interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string }
}

/**
 * Lazy accessor for a host service: resolved per request because the web
 * plugin typically loads before the host services finish starting.
 */
export type ServiceSource<T> = () => T | undefined

/** Lazy accessor for the workspace registry. */
export type WorkspaceRegistrySource = ServiceSource<WorkspaceRegistryLike>

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/** Log the full error server-side; clients only ever get a generic message. */
function sendInternalError(res: ServerResponse, error: unknown) {
  console.error(error)
  sendJson(res, 500, { error: 'internal error' })
}

/**
 * Resolve the `session` query param to its workspace path. Without a session
 * the caller's process cwd is used. The path is realpath-normalized (falling
 * back to the raw spelling) so routes, the runner, and the store all key the
 * same repo by one spelling. Returns an error message and HTTP status on
 * failure.
 */
async function resolveRepo(
  url: URL,
  workspaces?: WorkspaceRegistrySource,
): Promise<{ cwd: string } | { error: string; status: number }> {
  const sessionId = url.searchParams.get('session')
  let cwd = process.cwd()
  if (sessionId) {
    const registry = workspaces?.()
    if (!registry) return { error: 'workspace registry unavailable', status: 503 }
    const workspace = registry.list().find((entry) => entry.sessionIds.includes(sessionId))
    if (!workspace) return { error: `no workspace found for session: ${sessionId}`, status: 400 }
    cwd = workspace.path
  }
  try {
    return { cwd: await realpath(cwd) }
  } catch {
    return { cwd }
  }
}

/**
 * JSON API backing the right-sidebar tab body:
 * `/review-panel/api/changes?scope=&ref=&base=&session=`.
 * `session` names the browser session; its workspace's path becomes the repo.
 */
export function changesRoute(reviewPanel: ReviewPanelService, workspaces?: WorkspaceRegistrySource): WebServerRoute {
  return {
    kind: 'exact',
    path: '/review-panel/api/changes',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'GET required' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const scope = (url.searchParams.get('scope') ?? 'working-tree') as ReviewScope
        if (!(REVIEW_SCOPES as readonly string[]).includes(scope)) {
          sendJson(res, 400, { error: `invalid scope: ${scope}` })
          return
        }
        const repo = await resolveRepo(url, workspaces)
        if ('error' in repo) {
          sendJson(res, repo.status, { error: repo.error })
          return
        }
        const changeSet = await reviewPanel.collect({
          cwd: repo.cwd,
          scope,
          ref: url.searchParams.get('ref'),
          baseBranch: url.searchParams.get('base'),
        })
        sendJson(res, 200, changeSet)
      } catch (error) {
        sendInternalError(res, error)
      }
    },
  }
}

/**
 * `GET /review-panel/api/models` — the model choices the review picker offers:
 * every registered provider with its advertised catalog, plus the host's
 * default selection so the panel can mark the "默认" entry. A provider whose
 * adapter publishes no catalog (or fails listing) still appears, with an
 * empty `models` array — catalog membership is advisory, never a gate.
 */
export function modelsRoute(
  llm: ServiceSource<LlmLike>,
  defaultModel: ServiceSource<AgentDefaultModelLike>,
): WebServerRoute {
  return {
    kind: 'exact',
    path: '/review-panel/api/models',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'GET required' })
          return
        }
        const runtime = llm()
        if (!runtime) {
          sendJson(res, 503, { error: '模型服务不可用' })
          return
        }
        const providers = await Promise.all(
          runtime.listProviders().map(async (provider) => {
            let models: { id: string; name: string }[] = []
            try {
              models = (await runtime.listModels(provider.id)).map((model) => ({ id: model.id, name: model.name }))
            } catch {
              // Advisory catalog: a provider without listable models stays selectable.
            }
            return { id: provider.id, name: provider.name, models }
          }),
        )
        sendJson(res, 200, { default: defaultModel()?.currentSelection() ?? null, providers })
      } catch (error) {
        sendInternalError(res, error)
      }
    },
  }
}

/**
 * `POST /review-panel/api/review/start?session=&provider=&model=` — collect
 * the working-tree diff of the session's workspace and start an independent
 * subagent review. `provider` and `model` are optional but must come as a
 * pair; absent (or empty), the host's default model selection is used.
 * Idempotent per repo: a second start while one is running returns the same
 * run. Responds `{ id }`.
 */
export function reviewStartRoute(
  reviewPanel: ReviewPanelService,
  runner: ReviewRunner,
  workspaces?: WorkspaceRegistrySource,
): WebServerRoute {
  return {
    kind: 'exact',
    path: '/review-panel/api/review/start',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST required' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const provider = url.searchParams.get('provider') || null
        const model = url.searchParams.get('model') || null
        if ((provider === null) !== (model === null)) {
          sendJson(res, 400, { error: 'provider 和 model 必须同时指定' })
          return
        }
        const selection = provider !== null && model !== null ? { provider, model } : undefined
        const repo = await resolveRepo(url, workspaces)
        if ('error' in repo) {
          sendJson(res, repo.status, { error: repo.error })
          return
        }
        const changeSet = await reviewPanel.collect({ cwd: repo.cwd, scope: 'working-tree' })
        if (changeSet.files.length === 0) {
          sendJson(res, 400, { error: '工作区没有未提交的变更，无需检视' })
          return
        }
        sendJson(res, 200, { id: runner.start(changeSet, selection).id })
      } catch (error) {
        sendInternalError(res, error)
      }
    },
  }
}

/**
 * Fields every run-like source shares (a live `ReviewRun` or a persisted
 * `ReviewRecord`), loose enough to cover both.
 */
interface RunJsonSource {
  id: string
  status: ReviewRun['status']
  model?: string | null
  text?: string | null
  findings?: ReviewRun['findings']
  verdict?: ReviewRun['verdict']
  error?: string | null
  startedAt: number
}

/** The JSON shape shared by the status route (never `settled`). */
function runToJson(run: RunJsonSource) {
  return {
    id: run.id,
    status: run.status,
    model: run.model ?? null,
    text: run.text ?? null,
    findings: run.findings ?? null,
    verdict: run.verdict ?? null,
    error: run.error ?? null,
    startedAt: run.startedAt,
  }
}

/**
 * The JSON shape for the latest route: same fields whether the source is a
 * running run (no `finishedAt` yet, `cwd` from the request) or a persisted
 * record (both present on the record itself).
 */
function latestToJson(
  run: RunJsonSource & { finishedAt?: number | null; cwd?: string },
  cwd: string,
) {
  return { ...runToJson(run), finishedAt: run.finishedAt ?? null, cwd: run.cwd ?? cwd }
}

/** `GET /review-panel/api/review/status?id=` — poll a run's status/result. */
export function reviewStatusRoute(runner: ReviewRunner): WebServerRoute {
  return {
    kind: 'exact',
    path: '/review-panel/api/review/status',
    handler: (req, res) => {
      try {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'GET required' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = url.searchParams.get('id') ?? ''
        const run = runner.get(id)
        if (!run) {
          sendJson(res, 404, { error: `unknown review run: ${id}` })
          return
        }
        sendJson(res, 200, runToJson(run))
      } catch (error) {
        sendInternalError(res, error)
      }
    },
  }
}

/**
 * `GET /review-panel/api/review/latest?session=` — the panel's restore entry:
 * the repo's currently-running run when there is one (so a reloaded panel can
 * resume polling), otherwise its latest persisted record; 404 when neither
 * exists.
 */
export function reviewLatestRoute(
  runner: ReviewRunner,
  store: ReviewStoreLike,
  workspaces?: WorkspaceRegistrySource,
): WebServerRoute {
  return {
    kind: 'exact',
    path: '/review-panel/api/review/latest',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'GET required' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const repo = await resolveRepo(url, workspaces)
        if ('error' in repo) {
          sendJson(res, repo.status, { error: repo.error })
          return
        }
        const running = runner.runningFor(repo.cwd)
        if (running) {
          sendJson(res, 200, latestToJson(running, repo.cwd))
          return
        }
        const record = await store.get(repo.cwd)
        if (!record) {
          sendJson(res, 404, { error: 'no review record for this repo' })
          return
        }
        sendJson(res, 200, latestToJson(record, repo.cwd))
      } catch (error) {
        sendInternalError(res, error)
      }
    },
  }
}

/**
 * `POST /review-panel/api/commit/start?session=&push=&provider=&model=` —
 * generate a commit message from the working-tree diff with a subagent, then
 * stage everything and commit; `push=1` (or `true`) also pushes afterwards.
 * `provider`/`model` follow the same pair rule as the review start route.
 * Responds `{ id }`; poll the status route for the outcome.
 */
export function commitStartRoute(
  reviewPanel: ReviewPanelService,
  runner: CommitRunner,
  workspaces?: WorkspaceRegistrySource,
): WebServerRoute {
  return {
    kind: 'exact',
    path: '/review-panel/api/commit/start',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST required' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const provider = url.searchParams.get('provider') || null
        const model = url.searchParams.get('model') || null
        if ((provider === null) !== (model === null)) {
          sendJson(res, 400, { error: 'provider 和 model 必须同时指定' })
          return
        }
        const selection = provider !== null && model !== null ? { provider, model } : undefined
        const push = url.searchParams.get('push') === '1' || url.searchParams.get('push') === 'true'
        const repo = await resolveRepo(url, workspaces)
        if ('error' in repo) {
          sendJson(res, repo.status, { error: repo.error })
          return
        }
        const changeSet = await reviewPanel.collect({ cwd: repo.cwd, scope: 'working-tree' })
        if (changeSet.files.length === 0) {
          sendJson(res, 400, { error: '工作区没有未提交的变更，无需提交' })
          return
        }
        sendJson(res, 200, { id: runner.start(changeSet, { push }, selection).id })
      } catch (error) {
        sendInternalError(res, error)
      }
    },
  }
}

/** The JSON shape for the commit status route (never `settled`). */
function commitToJson(run: CommitRun) {
  return {
    id: run.id,
    status: run.status,
    message: run.message ?? null,
    commit: run.commit ?? null,
    pushed: run.pushed ?? null,
    pushError: run.pushError ?? null,
    error: run.error ?? null,
    startedAt: run.startedAt,
  }
}

/** `GET /review-panel/api/commit/status?id=` — poll a commit run's outcome. */
export function commitStatusRoute(runner: CommitRunner): WebServerRoute {
  return {
    kind: 'exact',
    path: '/review-panel/api/commit/status',
    handler: (req, res) => {
      try {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'GET required' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = url.searchParams.get('id') ?? ''
        const run = runner.get(id)
        if (!run) {
          sendJson(res, 404, { error: `unknown commit run: ${id}` })
          return
        }
        sendJson(res, 200, commitToJson(run))
      } catch (error) {
        sendInternalError(res, error)
      }
    },
  }
}
