import type { Context } from '@deepseek-ai/cordis'

import { ReviewRunner } from '../review/runner.js'
import {
  changesRoute,
  modelsRoute,
  reviewStartRoute,
  reviewStatusRoute,
  type AgentDefaultModelLike,
  type LlmLike,
  type WebServerRoute,
  type WorkspaceRegistryLike,
} from './routes.js'

export const name = 'dsh-code-review-web'

export const inject = ['reviewPanel']

interface WebServerLike {
  register(route: WebServerRoute): () => void
}

export function apply(ctx: Context) {
  // `webServer` is web-profile only, so it is an OPTIONAL dependency reached
  // through `ctx.inject`: this sub-plugin simply never loads under headless.
  ctx.inject(['webServer'], (wctx) => {
    const webServer = (wctx as Context & { webServer?: WebServerLike }).webServer
    if (!webServer) return

    // Host services typically start AFTER this plugin, so every one of them
    // is resolved lazily per request / per run instead of once at startup.
    const lazy = <T>(service: string) => () => (wctx.get as (name: string) => unknown).call(wctx, service) as T | undefined
    const workspaces = lazy<WorkspaceRegistryLike>('workspaceRegistry')
    const runner = new ReviewRunner({
      agents: lazy('agents'),
      subagents: lazy('subagents'),
      agentDefaultModel: lazy('agentDefaultModel'),
    })

    // `webServer.register` returns a plain disposer, not a fiber-owned one,
    // so it must be wrapped in `wctx.effect`. The panel UI itself ships as a
    // client module (lib/client.js) registered into the host right sidebar.
    wctx.effect(() => webServer.register(changesRoute(ctx.reviewPanel, workspaces)))
    wctx.effect(() => webServer.register(modelsRoute(lazy<LlmLike>('llm'), lazy<AgentDefaultModelLike>('agentDefaultModel'))))
    wctx.effect(() => webServer.register(reviewStartRoute(ctx.reviewPanel, runner, workspaces)))
    wctx.effect(() => webServer.register(reviewStatusRoute(runner)))
  })
}
