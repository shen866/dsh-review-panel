import type { Context } from '@deepseek-ai/cordis'

import { CommitRunner } from '../review/commit.js'
import { ReviewRunner } from '../review/runner.js'
import {
  changesRoute,
  commitStartRoute,
  commitStatusRoute,
  modelsRoute,
  reviewLatestRoute,
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
  // Host services typically start AFTER this plugin, so every one of them
  // is resolved lazily per request / per run instead of once at startup.
  const lazy = <T>(service: string) => () => ctx.get(service) as T | undefined

  // The runner and store live in `apply` scope, NOT inside the webServer
  // inject callback below: a webServer reload would otherwise rebuild the
  // runner and orphan in-flight runs from every route.
  const runner = new ReviewRunner({
    agents: lazy('agents'),
    subagents: lazy('subagents'),
    agentDefaultModel: lazy('agentDefaultModel'),
    store: ctx.reviewPanel.reviewStore,
  })
  const commitRunner = new CommitRunner({
    agents: lazy('agents'),
    subagents: lazy('subagents'),
    agentDefaultModel: lazy('agentDefaultModel'),
    store: ctx.reviewPanel.reviewStore,
  })

  // `webServer` is web-profile only, so it is an OPTIONAL dependency reached
  // through `ctx.inject`: this sub-plugin simply never loads under headless.
  ctx.inject(['webServer'], (wctx) => {
    const webServer = (wctx as Context & { webServer?: WebServerLike }).webServer
    if (!webServer) return

    const workspaces = lazy<WorkspaceRegistryLike>('workspaceRegistry')

    // `webServer.register` returns a plain disposer, not a fiber-owned one,
    // so it must be wrapped in `wctx.effect`. The panel UI itself ships as a
    // client module (lib/client.js) registered into the host right sidebar.
    wctx.effect(() => webServer.register(changesRoute(ctx.reviewPanel, workspaces)))
    wctx.effect(() => webServer.register(modelsRoute(lazy<LlmLike>('llm'), lazy<AgentDefaultModelLike>('agentDefaultModel'))))
    wctx.effect(() => webServer.register(reviewStartRoute(ctx.reviewPanel, runner, workspaces)))
    wctx.effect(() => webServer.register(reviewStatusRoute(runner)))
    wctx.effect(() => webServer.register(reviewLatestRoute(runner, ctx.reviewPanel.reviewStore, workspaces)))
    wctx.effect(() => webServer.register(commitStartRoute(ctx.reviewPanel, commitRunner, workspaces)))
    wctx.effect(() => webServer.register(commitStatusRoute(commitRunner)))
  })
}
