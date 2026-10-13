import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ReviewRunner } from '../review/runner.js'
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

/**
 * Resolve the `session` query param to its workspace path. Without a session
 * the caller's process cwd is used. Returns an error message on failure.
 */
function resolveRepo(
  url: URL,
  workspaces?: WorkspaceRegistrySource,
): { cwd: string } | { error: string } {
  const sessionId = url.searchParams.get('session')
  if (!sessionId) return { cwd: process.cwd() }
  const workspace = workspaces?.()?.list().find((entry) => entry.sessionIds.includes(sessionId))
  if (!workspace) return { error: `no workspace found for session: ${sessionId}` }
  return { cwd: workspace.path }
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
        const url = new URL(req.url ?? '/', 'http://localhost')
        const scope = (url.searchParams.get('scope') ?? 'working-tree') as ReviewScope
        if (!(REVIEW_SCOPES as readonly string[]).includes(scope)) {
          sendJson(res, 400, { error: `invalid scope: ${scope}` })
          return
        }
        const repo = resolveRepo(url, workspaces)
        if ('error' in repo) {
          sendJson(res, 400, { error: repo.error })
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
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
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
        const runtime = llm()
        if (!runtime) {
          sendJson(res, 503, { error: '模型服务不可用' })
          return
        }
        const providers = []
        for (const provider of runtime.listProviders()) {
          let models: { id: string; name: string }[] = []
          try {
            models = (await runtime.listModels(provider.id)).map((model) => ({ id: model.id, name: model.name }))
          } catch {
            // Advisory catalog: a provider without listable models stays selectable.
          }
          providers.push({ id: provider.id, name: provider.name, models })
        }
        sendJson(res, 200, { default: defaultModel()?.currentSelection() ?? null, providers })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}

/**
 * `POST /review-panel/api/review/start?session=&provider=&model=` — collect
 * the working-tree diff of the session's workspace and start an independent
 * subagent review. `provider` and `model` are optional but must come as a
 * pair; absent, the host's default model selection is used. Idempotent per
 * repo: a second start while one is running returns the same run.
 * Responds `{ id }`.
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
        const provider = url.searchParams.get('provider')
        const model = url.searchParams.get('model')
        if ((provider === null) !== (model === null)) {
          sendJson(res, 400, { error: 'provider 和 model 必须同时指定' })
          return
        }
        const selection = provider !== null && model !== null ? { provider, model } : undefined
        const repo = resolveRepo(url, workspaces)
        if ('error' in repo) {
          sendJson(res, 400, { error: repo.error })
          return
        }
        const changeSet = await reviewPanel.collect({ cwd: repo.cwd, scope: 'working-tree' })
        if (changeSet.files.length === 0) {
          sendJson(res, 400, { error: '工作区没有未提交的变更，无需检视' })
          return
        }
        sendJson(res, 200, { id: runner.start(changeSet, selection).id })
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}

/** `GET /review-panel/api/review/status?id=` — poll a run's status/result. */
export function reviewStatusRoute(runner: ReviewRunner): WebServerRoute {
  return {
    kind: 'exact',
    path: '/review-panel/api/review/status',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = url.searchParams.get('id') ?? ''
      const run = runner.get(id)
      if (!run) {
        sendJson(res, 404, { error: `unknown review run: ${id}` })
        return
      }
      sendJson(res, 200, {
        id: run.id,
        status: run.status,
        model: run.model,
        text: run.text,
        error: run.error,
        startedAt: run.startedAt,
      })
    },
  }
}
