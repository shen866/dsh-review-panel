/**
 * Pure diff parsing and finding-anchoring logic, shared between the client
 * bundle (src/client/) and the unit tests (test/diff.test.mjs). Nothing here
 * touches the DOM, React, storage or the network, so the module compiles
 * under both the server tsconfig (NodeNext) and the client tsconfig.
 */

import type { ReviewFinding, ReviewSeverity } from '../review/findings.js'

/**
 * Undo C-style quoting used by git for paths with spaces/non-ASCII: \NNN
 * octal escapes (runs of them decode as UTF-8 byte sequences, matching how
 * the server reports the same paths) plus \t \n \\ \" etc.
 */
export function unquoteGitPath(token: string): string {
  const inner = token.length >= 2 && token.charAt(0) === '"' && token.charAt(token.length - 1) === '"'
    ? token.slice(1, -1)
    : token
  let out = ''
  let bytes: number[] = []
  const flushBytes = () => {
    if (bytes.length === 0) return
    out += new TextDecoder('utf-8').decode(new Uint8Array(bytes))
    bytes = []
  }
  const re = /\\([0-7]{1,3})|\\([\s\S])/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(inner)) !== null) {
    out += inner.slice(last, match.index)
    last = match.index + match[0].length
    if (match[1] !== undefined) {
      // Octal bytes accumulate until a plain escape or the end, so a
      // multi-byte char split across \NNN escapes decodes as one unit.
      bytes.push(parseInt(match[1], 8))
    } else {
      switch (match[2]) {
        case 'a': out += '\x07'; break
        case 'b': out += '\b'; break
        case 'f': out += '\f'; break
        case 'n': out += '\n'; break
        case 'r': out += '\r'; break
        case 't': out += '\t'; break
        case 'v': out += '\v'; break
        default: out += match[2]
      }
    }
  }
  flushBytes()
  out += inner.slice(last)
  return out
}

/** Split a unified diff into per-file sections keyed by the post-image path. */
export function parsePatchSections(patch: string): Record<string, string> {
  const sections: Record<string, string> = {}
  if (!patch) return sections
  const parts = patch.split(/^diff --git /m)
  for (let i = 1; i < parts.length; i++) {
    const firstLine = parts[i].split('\n', 1)[0]
    // Quoted ("a/…" "b/…") and plain (a/… b/…) forms share one code path.
    const match = /^"a\/(.*)" "b\/(.*)"$/.exec(firstLine) || /^a\/(.*) b\/(.*)$/.exec(firstLine)
    const path = match ? unquoteGitPath(match[2]) : firstLine
    sections[path] = 'diff --git ' + parts[i]
  }
  return sections
}

/** A parsed diff line with its old/new file line numbers (null when N/A). */
export type DiffLine = {
  kind: 'hunk' | 'add' | 'del' | 'ctx'
  oldLine: number | null
  newLine: number | null
  /** Line content WITHOUT the leading +/-/space marker. */
  content: string
}

/**
 * Parse one file's diff section into structured lines, tracking the
 * old/new line numbers from the `@@ -a,b +c,d @@` hunk headers. File
 * headers are dropped; the "\ No newline at end of file" marker renders
 * as a numberless context line.
 */
export function parseFileDiff(section: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  for (const raw of section.split('\n')) {
    if (/^(diff --git |index |--- |\+\+\+ )/.test(raw) || raw === '') continue
    if (raw.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (match) {
        oldLine = parseInt(match[1], 10)
        newLine = parseInt(match[2], 10)
      }
      lines.push({ kind: 'hunk', oldLine: null, newLine: null, content: raw })
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'add', oldLine: null, newLine: newLine++, content: raw.slice(1) })
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', oldLine: oldLine++, newLine: null, content: raw.slice(1) })
    } else if (raw.startsWith('\\')) {
      lines.push({ kind: 'ctx', oldLine: null, newLine: null, content: raw })
    } else {
      lines.push({ kind: 'ctx', oldLine: oldLine++, newLine: newLine++, content: raw.slice(1) })
    }
  }
  return lines
}

/** A diff line hit: the line index plus its display/jump line number. */
export type LocatedLine = { index: number; lineNo: number | null }

/**
 * L1 anchor — find the diff line a finding targets by its quote: same
 * side (`old` targets removed lines, `new` added/context ones), verbatim
 * quote first with a trimmed fallback, and the advisory line number
 * disambiguating duplicate quotes by proximity.
 */
export function locateLine(lines: DiffLine[], finding: ReviewFinding): LocatedLine | null {
  const kinds = finding.side === 'old' ? ['del'] : ['add', 'ctx']
  let candidates: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (kinds.indexOf(lines[i].kind) >= 0 && lines[i].content === finding.quote) candidates.push(i)
  }
  if (candidates.length === 0) {
    const quote = (finding.quote || '').trim()
    for (let i = 0; i < lines.length; i++) {
      if (kinds.indexOf(lines[i].kind) >= 0 && lines[i].content.trim() === quote) candidates.push(i)
    }
  }
  if (candidates.length === 0) return null
  const lineNoOf = (index: number) => {
    const lineNo = finding.side === 'old' ? lines[index].oldLine : lines[index].newLine
    return lineNo === undefined ? null : lineNo
  }
  if (candidates.length === 1 || finding.line === null) {
    return { index: candidates[0], lineNo: lineNoOf(candidates[0]) }
  }
  let best = candidates[0]
  let bestDistance = Infinity
  for (const index of candidates) {
    const lineNo = lineNoOf(index)
    const distance = lineNo === null ? Infinity : Math.abs(lineNo - finding.line)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  }
  return { index: best, lineNo: lineNoOf(best) }
}

/**
 * L2 anchor — fall back to the advisory line number when quote matching
 * fails: a normalized (all-whitespace-collapsed) quote match first, then
 * the side-appropriate line nearest `finding.line` within a small window.
 */
export function locateByProximity(lines: DiffLine[], finding: ReviewFinding): LocatedLine | null {
  const kinds = finding.side === 'old' ? ['del'] : ['add', 'ctx']
  let candidates: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (kinds.indexOf(lines[i].kind) >= 0) candidates.push(i)
  }
  if (candidates.length === 0) return null
  const lineNoOf = (index: number) => {
    const lineNo = finding.side === 'old' ? lines[index].oldLine : lines[index].newLine
    return lineNo === undefined ? null : lineNo
  }
  const normalized = (finding.quote || '').replace(/\s+/g, ' ')
  if (normalized.trim()) {
    let best: LocatedLine | null = null
    let bestDistance = Infinity
    for (const index of candidates) {
      if (lines[index].content.replace(/\s+/g, ' ') !== normalized) continue
      const lineNo = lineNoOf(index)
      const distance = finding.line === null || lineNo === null ? 0 : Math.abs(lineNo - finding.line)
      if (distance < bestDistance) {
        best = { index, lineNo }
        bestDistance = distance
      }
    }
    if (best) return best
  }
  if (finding.line === null) return null
  let best: LocatedLine | null = null
  let bestDistance = Infinity
  for (const index of candidates) {
    const lineNo = lineNoOf(index)
    if (lineNo === null) continue
    const distance = Math.abs(lineNo - finding.line)
    if (distance <= 5 && distance < bestDistance) {
      best = { index, lineNo }
      bestDistance = distance
    }
  }
  return best
}

/** DOM id of a rendered diff line, the scroll target of location links. */
export function diffLineDomId(path: string, lineIndex: number): string {
  return 'dsh-dl-' + path + '-' + lineIndex
}

/** A finding paired with its index in review.findings (stable across renders). */
export type IndexedFinding = {
  index: number
  finding: ReviewFinding
}

/** A placed finding: its diff line (null = the file's top card) and line number. */
export type PlacedFinding = IndexedFinding & {
  lineIndex: number | null
  lineNo: number | null
}

/**
 * Same-file same-title findings collapse into one card so the panel does
 * not repeat identical issues. The representative is always the member
 * with the lowest finding index; dedup happens AFTER indexing, so the
 * marks/everAnchored bookkeeping keyed by finding index never shifts
 * between renders of the same review. Members keep their own placements
 * purely to populate the card's "N 处" location list.
 */
export type FindingGroup = {
  rep: IndexedFinding
  members: PlacedFinding[]
  count: number
}

/** Group key: path plus whitespace-normalized title (order-stable). */
export function findingGroupKey(finding: ReviewFinding): string {
  return finding.path + '' + finding.title.trim().replace(/\s+/g, ' ')
}

export type FindingPlacement = {
  /** Per-file diff lines, parsed once and shared with the renderer. */
  parsed: Map<string, DiffLine[]>
  /** Line-anchored groups (L1/L2): file path -> diff line index -> groups. */
  perLine: Map<string, Map<number, FindingGroup[]>>
  /** File-top groups (L3): the file is in the diff but no line matched. */
  fileLevel: Map<string, FindingGroup[]>
  /** Indices of findings placed at L1/L2/L3 in the current diff. */
  anchored: Set<number>
}

/**
 * Anchor every finding with increasing tolerance: quote match (L1), then
 * the advisory line number / normalized content (L2), then the top of the
 * file's diff section (L3). A finding whose file is not in the current
 * diff at all is not displayed anywhere and stays out of `anchored`, so
 * the sticky auto-`resolved` logic treats it as gone. Groups are formed
 * first, but each member locates independently.
 */
export function placeFindings(findings: ReviewFinding[], sections: Record<string, string>): FindingPlacement {
  const placement: FindingPlacement = { parsed: new Map(), perLine: new Map(), fileLevel: new Map(), anchored: new Set() }
  const groups = new Map<string, IndexedFinding[]>()
  findings.forEach((finding, index) => {
    const entry: IndexedFinding = { index, finding }
    const key = findingGroupKey(finding)
    const list = groups.get(key)
    if (list) list.push(entry)
    else groups.set(key, [entry])
  })
  for (const entries of groups.values()) {
    const path = entries[0].finding.path
    const section = sections[path]
    // L4: the file left the diff entirely — hide the whole group.
    if (!section) continue
    let lines = placement.parsed.get(path)
    if (!lines) {
      lines = parseFileDiff(section)
      placement.parsed.set(path, lines)
    }
    const members: PlacedFinding[] = entries.map((entry) => {
      let located: LocatedLine | null = null
      if (entry.finding.quote) {
        located = locateLine(lines!, entry.finding) || locateByProximity(lines!, entry.finding)
      }
      placement.anchored.add(entry.index)
      return {
        index: entry.index,
        finding: entry.finding,
        lineIndex: located ? located.index : null,
        lineNo: located ? located.lineNo : null,
      }
    })
    const group: FindingGroup = { rep: entries[0], members, count: entries.length }
    if (members[0].lineIndex === null) {
      const list = placement.fileLevel.get(path) || []
      list.push(group)
      placement.fileLevel.set(path, list)
    } else {
      let perLine = placement.perLine.get(path)
      if (!perLine) {
        perLine = new Map()
        placement.perLine.set(path, perLine)
      }
      const lineIndex = members[0].lineIndex!
      const list = perLine.get(lineIndex) || []
      list.push(group)
      perLine.set(lineIndex, list)
    }
  }
  return placement
}

/**
 * Fold a finding's severity into the current three levels; ids persisted
 * by older versions (major/minor) count as `normal` — the same mapping as
 * the server's LEGACY_SEVERITIES in src/review/findings.ts.
 */
export function severityOf(finding: { severity: string }): ReviewSeverity {
  if (finding.severity === 'critical') return 'critical'
  if (finding.severity === 'suggestion') return 'suggestion'
  return 'normal'
}
