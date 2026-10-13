import { REVIEW_SCOPES, type ReviewScope } from '../service/types.js'

export interface ScopeInput {
  scope?: string
  ref?: string
  baseBranch?: string
}

export interface ResolvedScope {
  scope: ReviewScope
  ref: string | null
  baseBranch: string | null
}

/**
 * Validate and normalize the scope arguments. `baseBranch` may stay `null`:
 * the reviewPanel service then falls back to its configured default.
 */
export function resolveScope(input: ScopeInput, defaults: { defaultScope: ReviewScope }): ResolvedScope {
  const scope = (input.scope ?? defaults.defaultScope) as ReviewScope
  if (!(REVIEW_SCOPES as readonly string[]).includes(scope)) {
    throw new Error(`code_review: unknown scope "${input.scope}", expected one of ${REVIEW_SCOPES.join(', ')}`)
  }
  const ref = input.ref ?? null
  if (scope === 'since-ref' && !ref) {
    throw new Error('code_review: `ref` is required when scope is "since-ref"')
  }
  return { scope, ref, baseBranch: input.baseBranch ?? null }
}
