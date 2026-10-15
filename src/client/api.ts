//! JSON API shapes and helpers for the panel. Types mirror the server's
//! web routes (src/web/routes.ts) and reuse the shared server type modules
//! instead of hand-maintained copies.

import type { ReviewFinding } from '../review/findings.js'
import type { ChangeSet } from '../service/types.js'

/** Response of `/review-panel/api/changes` (a serialized `ChangeSet`). */
export type ChangesBody = Pick<ChangeSet, 'files' | 'patch' | 'truncated' | 'cwd'>

/** Response of `/review-panel/api/models`. */
export type ModelsBody = {
  default: { provider: string; model: string } | null
  providers: { id: string; name: string; models: { id: string; name: string }[] }[]
}

/** Run JSON from the review status/latest routes (a live run or a record). */
export type ReviewState = {
  id?: string
  status: 'running' | 'done' | 'error'
  text?: string | null
  findings?: ReviewFinding[] | null
  verdict?: string | null
  error?: string | null
  model?: string | null
  startedAt?: number
}

/** Run JSON from the commit status route. */
export type CommitState = {
  id?: string
  status: 'running' | 'done' | 'error'
  message?: string | null
  commit?: string | null
  pushed?: boolean | null
  pushError?: string | null
  error?: string | null
  startedAt?: number
}

/** Manual/auto finding disposition, keyed by the finding's index in its review. */
export type FindingMark = 'ignored' | 'resolved'

/** Minimal face of the host client context used by `apply`. */
export interface ClientContext {
  effect(fn: () => unknown, label?: string): void
  sidebarRightTabs: {
    register(tab: {
      id: string
      kind: string
      title(): string
      guide: { order: number; title(): string; description(): string }[]
    }): unknown
  }
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(seat: { name: string; key: string }, component: (props: any) => any): unknown
  }
}

/**
 * Read a JSON response tolerantly: the host fallback answers unclaimed
 * routes with an EMPTY 404 body (e.g. this plugin's routes before a dsh
 * restart), which makes the native res.json() throw an opaque
 * "Unexpected end of JSON input". Surface a useful message instead.
 */
export function readJson(res: Response): Promise<any> {
  return res.text().then((text) => {
    let body: any = null
    try { body = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }
    if (!res.ok) {
      throw new Error((body && body.error) ||
        (res.status === 404 ? '接口不存在（HTTP 404）——请重启 dsh 实例以加载最新插件' : 'HTTP ' + res.status))
    }
    return body
  })
}
