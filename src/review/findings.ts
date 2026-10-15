/**
 * Structured review findings: the reviewer ends its answer with a fenced
 * `review-findings` JSON block so the panel can anchor each finding to a diff
 * line. This module extracts the block, validates the entries, and hands back
 * the stripped body text (older reviews carried a free-form summary before
 * the block; current reviews are findings-only). Anything malformed degrades
 * to `null` / dropped entries, never to a failed review.
 */

export const REVIEW_SEVERITIES = ['critical', 'normal', 'suggestion'] as const
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number]

/** Severity ids persisted by older plugin versions, folded into `normal`. */
const LEGACY_SEVERITIES: Record<string, ReviewSeverity> = { major: 'normal', minor: 'normal' }

function normalizeSeverity(value: unknown): ReviewSeverity {
  if ((REVIEW_SEVERITIES as readonly string[]).includes(value as string)) return value as ReviewSeverity
  return LEGACY_SEVERITIES[value as string] ?? 'normal'
}

export const REVIEW_VERDICTS = ['approve', 'changes-suggested', 'must-fix'] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

/**
 * Output-facing shape: absent values are `null`, not `undefined` (an
 * `undefined` property fails a JSON node).
 */
export type ReviewFinding = {
  severity: ReviewSeverity
  /** File path as it appears in the diff (the `b/` side). */
  path: string
  /** Whether the finding targets an added/context line or a removed one. */
  side: 'new' | 'old'
  /** Advisory new-file line number; only disambiguates duplicate quotes. */
  line: number | null
  /** Verbatim diff line content (without the +/-/space marker) used to anchor. */
  quote: string | null
  title: string
  detail: string
}

export type ParsedReview = {
  /** Review markdown with the findings fence removed. */
  text: string
  verdict: ReviewVerdict | null
  findings: ReviewFinding[]
}

const CLOSED_FENCE = /```review-findings[^\n`]*\n([\s\S]*?)```/g
const OPEN_FENCE = /```review-findings[^\n`]*\n([\s\S]*)$/

function normalizeFinding(entry: unknown): ReviewFinding | null {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry as Record<string, unknown>
  if (typeof raw.path !== 'string' || !raw.path) return null
  const title = typeof raw.title === 'string' && raw.title ? raw.title : null
  const detail = typeof raw.detail === 'string' ? raw.detail : ''
  if (!title && !detail) return null
  return {
    severity: normalizeSeverity(raw.severity),
    path: raw.path,
    side: raw.side === 'old' ? 'old' : 'new',
    line: typeof raw.line === 'number' && Number.isInteger(raw.line) && raw.line > 0 ? raw.line : null,
    quote: typeof raw.quote === 'string' && raw.quote.trim() ? raw.quote : null,
    title: title ?? detail.split('\n', 1)[0].slice(0, 80),
    detail,
  }
}

/**
 * Extracts the last `review-findings` fence from a review text. Returns `null`
 * when there is no block or its JSON is broken — the caller then keeps the
 * raw text and no findings, which is the pre-structured behavior.
 */
export function parseReviewFindings(text: string): ParsedReview | null {
  const closed = [...text.matchAll(CLOSED_FENCE)]
  const last = closed[closed.length - 1]
  const open = last ? null : OPEN_FENCE.exec(text)
  const block = last ?? open
  if (!block) return null
  let parsed: unknown
  try {
    // Tolerate an unclosed fence's trailing junk by trimming a dangling ```.
    parsed = JSON.parse(block[1].replace(/\n?```\s*$/, ''))
  } catch {
    // A ``` inside a JSON string (e.g. a quote) ends the lazy match early;
    // retry up to the LAST fence close before giving up on the block.
    const contentAt = (block.index ?? 0) + block[0].indexOf(block[1])
    const close = text.lastIndexOf('```')
    if (close <= contentAt) return null
    try {
      parsed = JSON.parse(text.slice(contentAt, close))
    } catch {
      return null
    }
  }
  const root = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  const findings = Array.isArray(root.findings) ? root.findings : []
  const start = block.index ?? 0
  return {
    text: (text.slice(0, start) + text.slice(start + block[0].length)).trim(),
    verdict: (REVIEW_VERDICTS as readonly string[]).includes(root.verdict as string)
      ? (root.verdict as ReviewVerdict)
      : null,
    findings: findings.map(normalizeFinding).filter((finding) => finding !== null),
  }
}
