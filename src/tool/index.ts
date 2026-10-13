import type { Context } from '@deepseek-ai/cordis'

import { Config } from './config.js'
import { createCodeReviewTool } from './code-review.js'

export { Config }

export const name = 'dsh-code-review-tool'

/**
 * Every entry is REQUIRED and blocking: the framework waits for `tools` and
 * the `reviewPanel` service before running `apply`, disposes this plugin when
 * one disappears, and re-runs `apply` when it returns.
 */
export const inject = ['tools', 'reviewPanel']

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(createCodeReviewTool(ctx, config))
}
