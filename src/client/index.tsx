//! dsh-review-panel client bundle entry — compiles to lib/client.js (tsdown),
//! the artifact referenced by package.json exports["./client"]. Registers a
//! page-type tab into the host right sidebar:
//!   1. the tab type into `ctx.sidebarRightTabs` (stage one), with a guide
//!      entry so the user can add it from the sidebar's guide page;
//!   2. the body into the keyed `sidebar.right.pane.tab` seat under the same
//!      id (stage two).
//! The right sidebar itself provides expand/collapse, docking and floating.
//!
//! TAB_ID keeps the historical "dsh-review-panel" spelling so sidebar tabs
//! already added under that type id keep working after the package rename.

import type { ClientContext } from './api.js'
import { ChangesPanelBody } from './panel.js'

const TAB_ID = 'dsh-review-panel'
const KIND = 'review-panel'

/** Required client services: the slot registry and the right-sidebar tab registry. */
export const inject = ['slots', 'sidebarRightTabs']

/**
 * Client plugin body: register the tab type (stage one) and its body
 * (stage two). Both registrations live exactly as long as this plugin.
 */
export function apply(ctx: ClientContext) {
  ctx.effect(() => {
    return ctx.sidebarRightTabs.register({
      id: TAB_ID,
      kind: KIND,
      title: () => '代码变更',
      guide: [{
        order: 100,
        title: () => '代码变更',
        description: () => '查看当前仓库未提交的代码变更（diff）',
      }],
    })
  }, 'dsh-review-panel: tab type')
  ctx.effect(() => {
    return ctx.slots.inject('sidebar.right.pane.tab', () => {
      return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, ChangesPanelBody)
    })
  }, 'dsh-review-panel: tab body')
}
