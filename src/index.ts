/**
 * Package entry: the ReviewPanel service plugin (class form, default export).
 * Implementation lives in ./service; this file only wires the public surface.
 */
export { default, collectChanges, DEFAULT_MAX_PATCH_BYTES, REVIEW_SCOPES } from './service/index.js'
export type { CollectOptions } from './service/index.js'
export { Config } from './config.js'
export * from './service/types.js'
export { parseReviewFindings, REVIEW_SEVERITIES, REVIEW_VERDICTS } from './review/findings.js'
export type { ParsedReview, ReviewFinding, ReviewSeverity, ReviewVerdict } from './review/findings.js'
export { ReviewStore } from './review/store.js'
export type { ReviewRecord, ReviewStoreLike } from './review/store.js'
