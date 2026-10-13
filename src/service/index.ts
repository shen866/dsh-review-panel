import { Service, type Context } from '@deepseek-ai/cordis'

import { Config } from '../config.js'
import { collectChanges, DEFAULT_MAX_PATCH_BYTES, type CollectOptions } from './git.js'
import { REVIEW_SCOPES, type ChangeSet } from './types.js'

export { Config, collectChanges, DEFAULT_MAX_PATCH_BYTES, REVIEW_SCOPES }
export type { CollectOptions }
export * from './types.js'

/**
 * Service form is required because the bundled code_review tool consumes this
 * plugin through `inject: ['reviewPanel']`. The service name is the
 * consumption path (`ctx.reviewPanel`) and must never be renamed once
 * published.
 */
export default class ReviewPanelService extends Service {
  readonly config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'reviewPanel')
    this.config = config
  }

  /**
   * Collect the code changes for a scope. `baseBranch` and `maxPatchBytes`
   * fall back to the plugin config when omitted.
   */
  collect(options: Omit<CollectOptions, 'maxPatchBytes'> & { maxPatchBytes?: number }): Promise<ChangeSet> {
    return collectChanges({
      baseBranch: this.config.defaultBaseBranch,
      ...options,
      maxPatchBytes: options.maxPatchBytes ?? this.config.maxPatchBytes,
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    reviewPanel: ReviewPanelService
  }
}
