import type { Context } from '@deepseek-ai/cordis'

import { changesRoute, type WebServerRoute, type WorkspaceRegistryLike } from './routes.js'

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

    // `workspaceRegistry` usually starts AFTER this plugin, so it is resolved
    // lazily per request instead of once at registration time.
    const workspaces = () =>
      (wctx.get as (name: string) => unknown).call(wctx, 'workspaceRegistry') as
        | WorkspaceRegistryLike
        | undefined

    // `webServer.register` returns a plain disposer, not a fiber-owned one,
    // so it must be wrapped in `wctx.effect`. The panel UI itself ships as a
    // client module (lib/client.js) registered into the host right sidebar.
    wctx.effect(() => webServer.register(changesRoute(ctx.reviewPanel, workspaces)))
  })
}
