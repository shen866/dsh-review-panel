import { homedir } from 'node:os'

import { Service, type Context } from '@deepseek-ai/cordis'

import { Config } from '../config.js'
import { ReviewStore } from '../review/store.js'
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
  /** Cordis reads the schema from the class itself; without it no defaults apply. */
  static Config = Config

  readonly config: Config
  /** Latest-review persistence; consumed by the web plugin's runner/routes. */
  readonly reviewStore: ReviewStore

  constructor(ctx: Context, config: Config) {
    super(ctx, 'reviewPanel')
    this.config = config
    const dir = (config.storageDir ?? '~/.dsh-code-review').replace(/^~(?=$|\/)/, homedir())
    this.reviewStore = new ReviewStore(dir)
  }

  /**
   * Collect the code changes for a scope. `baseBranch` and `maxPatchBytes`
   * fall back to the plugin config when omitted or null (the web routes pass
   * `null` for a missing query param, which must NOT override the default —
   * the fallback has to sit AFTER the spread).
   */
  collect(options: CollectOptions): Promise<ChangeSet> {
    return collectChanges({
      ...options,
      baseBranch: options.baseBranch ?? this.config.defaultBaseBranch,
      maxPatchBytes: options.maxPatchBytes ?? this.config.maxPatchBytes,
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    reviewPanel: ReviewPanelService
  }
}
