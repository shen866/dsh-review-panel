import Schema from '@deepseek-ai/schemastery'
import { REVIEW_SCOPES, type ReviewScope } from '../service/types.js'

/**
 * `Config` is exported TWICE, under the same name:
 *   - a TypeScript `interface`, for `apply(ctx, config: Config)`
 *   - a runtime Schemastery schema, which is what Cordis validates against
 */
export interface Config {
  /** Scope applied when the tool call omits `scope`. */
  defaultScope: ReviewScope
}

export const Config: Schema<Config> = Schema.object({
  defaultScope: Schema.union(REVIEW_SCOPES)
    .default('working-tree')
    .description('Review scope used when the tool call omits `scope`.'),
})
