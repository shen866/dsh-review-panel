import type { IncomingMessage, ServerResponse } from 'node:http'

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

/**
 * Lazy accessor for the workspace registry: resolved per request because the
 * web plugin typically loads before `workspaceRegistry` finishes starting.
 */
export type WorkspaceRegistrySource = () => WorkspaceRegistryLike | undefined

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
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
        const sessionId = url.searchParams.get('session')
        const workspace = sessionId
          ? workspaces?.()?.list().find((entry) => entry.sessionIds.includes(sessionId))
          : undefined
        if (sessionId && !workspace) {
          sendJson(res, 400, { error: `no workspace found for session: ${sessionId}` })
          return
        }
        const changeSet = await reviewPanel.collect({
          cwd: workspace?.path ?? process.cwd(),
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
