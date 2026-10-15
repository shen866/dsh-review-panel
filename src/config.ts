import Schema from '@deepseek-ai/schemastery'

/**
 * `Config` is exported TWICE, under the same name:
 *   - a TypeScript `interface`, for `apply(ctx, config: Config)` / class ctor
 *   - a runtime Schemastery schema, which is what Cordis validates against
 * Declaration merging keeps them a single name.
 */
export interface Config {
  /** Base branch used by the "branch" scope when the caller omits one. */
  defaultBaseBranch: string
  /** Patches longer than this (bytes) are truncated and flagged, never silently. */
  maxPatchBytes: number
  /** Directory holding the persisted latest review record per repo. */
  storageDir: string
}

export const Config: Schema<Config> = Schema.object({
  defaultBaseBranch: Schema.string()
    .default('main')
    .description('Base branch for the "branch" review scope when none is given.'),
  maxPatchBytes: Schema.number()
    .min(1024)
    .default(512 * 1024)
    .description('Maximum patch size in bytes. Longer patches are truncated and flagged.'),
  storageDir: Schema.string()
    .default('~/.dsh-code-review')
    .description('Directory where the latest review record per repo is persisted.'),
})
