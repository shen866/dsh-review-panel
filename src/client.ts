//! dsh-code-review client bundle — this file is the SOURCE of lib/client.js.
//! `pnpm build` (tsconfig.client.json) compiles it into lib/client.js, the
//! artifact referenced by package.json exports["./client"]. Edit here, never
//! in lib/.
//!
//! Registers a page-type tab into the host right sidebar:
//!   1. the tab type into `ctx.sidebarRightTabs` (stage one), with a guide
//!      entry so the user can add it from the sidebar's guide page;
//!   2. the body into the keyed `sidebar.right.pane.tab` seat under the same
//!      id (stage two).
//! The right sidebar itself provides expand/collapse, docking and floating.
//!
//! TAB_ID keeps the historical "dsh-review-panel" spelling so sidebar tabs
//! already added under that type id keep working after the package rename.

type SetState<T> = (next: T | ((prev: T) => T)) => void

/** Minimal face of the host-provided React (the shell supplies the module). */
interface ReactLike {
  createElement(...args: any[]): any
  useState<T>(initial: T | (() => T)): [T, SetState<T>]
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  useRef<T>(initial: T): { current: T }
  useCallback<F>(fn: F, deps: readonly unknown[]): F
  useMemo<T>(fn: () => T, deps: readonly unknown[]): T
}

/** Minimal face of the host client context used by `apply`. */
interface ClientContext {
  effect(fn: () => unknown, label?: string): void
  sidebarRightTabs: {
    register(tab: {
      id: string
      kind: string
      title(): string
      guide: { order: number; title(): string; description(): string }[]
    }): unknown
  }
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(seat: { name: string; key: string }, component: (props: any) => any): unknown
  }
}

interface Window {
  __ModuleLoader__: {
    load(definition: {
      id: string
      factory(require: (id: 'react') => ReactLike): unknown
    }): void
  }
}

/** Shapes of the plugin's JSON API (see src/web/routes.ts). */
type FileChange = {
  path: string
  status: string
  additions: number
  deletions: number
}

type ChangesBody = {
  files: FileChange[]
  patch: string
  truncated: boolean
  cwd: string
}

type ModelsBody = {
  default: { provider: string; model: string } | null
  providers: { id: string; name: string; models: { id: string; name: string }[] }[]
}

/** Structured review finding, mirroring src/review/findings.ts on the server. */
type ReviewFinding = {
  // `major`/`minor` only appear in records persisted by older versions.
  severity: 'critical' | 'normal' | 'suggestion' | 'major' | 'minor'
  path: string
  side: 'new' | 'old'
  line: number | null
  quote: string | null
  title: string
  detail: string
}

/** Manual/auto finding disposition, keyed by the finding's index in its review. */
type FindingMark = 'ignored' | 'resolved'

type ReviewState = {
  id?: string
  status: 'running' | 'done' | 'error'
  text?: string | null
  findings?: ReviewFinding[] | null
  verdict?: string | null
  error?: string | null
  model?: string | null
  startedAt?: number
}

type CommitState = {
  id?: string
  status: 'running' | 'done' | 'error'
  message?: string | null
  commit?: string | null
  pushed?: boolean | null
  pushError?: string | null
  error?: string | null
  startedAt?: number
}

window.__ModuleLoader__.load({
  id: 'dsh-code-review',
  factory: (require) => {
    const module = { exports: {} as Record<string, unknown> }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')
    const h = react.createElement

    const TAB_ID = 'dsh-review-panel'
    const KIND = 'review-panel'
    const POLL_MS = 4000
    const MODEL_KEY = 'dsh-code-review:model'
    const MARKS_KEY = 'dsh-code-review:marks:'
    const FILE_HEAD_CLASS = 'dsh-review-file-head'
    const MAX_REVIEW_POLL_FAILURES = 5

    const COLORS = {
      add: '#1a7f37',
      del: '#d1242f',
      hunk: '#8250df',
      addBg: 'rgba(46,160,67,.12)',
      delBg: 'rgba(248,81,73,.12)',
      hunkBg: 'rgba(130,80,223,.08)',
      border: 'rgba(128,128,128,.25)',
      hover: 'rgba(128,128,128,.10)',
    }

    const STATUS_BADGES: Record<string, { label: string; color: string }> = {
      added: { label: '新增', color: COLORS.add },
      modified: { label: '修改', color: '#9a6700' },
      deleted: { label: '删除', color: COLORS.del },
      renamed: { label: '重命名', color: '#8250df' },
    }

    const SEVERITY_BADGES: Record<string, { label: string; color: string }> = {
      critical: { label: '严重', color: '#d1242f' },
      normal: { label: '一般', color: '#bc4c00' },
      suggestion: { label: '建议', color: '#0969da' },
      // Severity ids persisted by older plugin versions, shown as 一般.
      major: { label: '一般', color: '#bc4c00' },
      minor: { label: '一般', color: '#bc4c00' },
    }

    /** Stats-bar order and colors for the three current severity levels. */
    const SEVERITY_STATS_ORDER = [
      { id: 'critical', label: '严重', color: '#d1242f' },
      { id: 'normal', label: '一般', color: '#bc4c00' },
      { id: 'suggestion', label: '建议', color: '#0969da' },
    ] as const

    /** Fold legacy severity ids into the current three levels. */
    function severityOf(finding: ReviewFinding): 'critical' | 'normal' | 'suggestion' {
      if (finding.severity === 'critical') return 'critical'
      if (finding.severity === 'suggestion') return 'suggestion'
      return 'normal'
    }

    const VERDICT_BADGES: Record<string, { label: string; color: string }> = {
      approve: { label: '可以提交', color: COLORS.add },
      'changes-suggested': { label: '建议修改后提交', color: '#9a6700' },
      'must-fix': { label: '必须修改', color: COLORS.del },
    }

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        fontSize: '13px',
        fontFamily: 'system-ui, sans-serif',
      },
      header: {
        padding: '10px 12px',
        borderBottom: '1px solid ' + COLORS.border,
        flexShrink: 0,
      },
      repoName: { fontWeight: 600, fontSize: '13px' },
      headerRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      reviewButton: {
        fontSize: '12px',
        padding: '3px 10px',
        borderRadius: '6px',
        border: '1px solid ' + COLORS.border,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        flexShrink: 0,
      },
      modelSelect: {
        fontSize: '11px',
        padding: '2px 4px',
        borderRadius: '6px',
        border: '1px solid ' + COLORS.border,
        background: 'transparent',
        color: 'inherit',
        maxWidth: '160px',
        flexShrink: 1,
        minWidth: 0,
      },
      headerMeta: { marginTop: '2px', fontSize: '11px', opacity: .6 },
      reviewBox: {
        flexShrink: 0,
        maxHeight: '45%',
        overflow: 'auto',
        borderBottom: '1px solid ' + COLORS.border,
        background: 'rgba(130,80,223,.05)',
      },
      reviewBoxHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 12px',
        fontSize: '12px',
        fontWeight: 600,
        position: 'sticky',
        top: 0,
        background: 'inherit',
      },
      reviewText: {
        margin: 0,
        padding: '0 12px 10px',
        fontSize: '12px',
        lineHeight: '1.6',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      list: { flex: 1, overflow: 'auto' },
      fileHeader: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '7px 12px',
        cursor: 'pointer',
        userSelect: 'none',
        borderBottom: '1px solid ' + COLORS.border,
      },
      caret: { fontSize: '10px', opacity: .5, width: '10px', flexShrink: 0 },
      filePath: {
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontFamily: 'ui-monospace, monospace',
        fontSize: '12px',
        direction: 'rtl',
        textAlign: 'left',
      },
      badge: {
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '8px',
        flexShrink: 0,
      },
      stats: {
        fontFamily: 'ui-monospace, monospace',
        fontSize: '11px',
        flexShrink: 0,
        whiteSpace: 'nowrap',
      },
      diffBody: {
        overflowX: 'auto',
        borderBottom: '1px solid ' + COLORS.border,
        fontFamily: 'ui-monospace, monospace',
        fontSize: '11px',
        lineHeight: '1.5',
      },
      diffLine: {
        whiteSpace: 'pre',
        paddingRight: '8px',
        minWidth: 'max-content',
      },
      gutter: {
        display: 'inline-block',
        width: '44px',
        paddingRight: '8px',
        textAlign: 'right',
        opacity: .45,
        userSelect: 'none',
        flexShrink: 0,
      },
      findingCard: {
        margin: '4px 8px 4px 12px',
        padding: '6px 10px',
        borderRadius: '0 6px 6px 0',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        lineHeight: '1.5',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        minWidth: 0,
      },
      findingHead: { display: 'flex', alignItems: 'center', gap: '6px' },
      findingDetail: { marginTop: '2px', opacity: .9 },
      severityBadge: {
        fontSize: '10px',
        padding: '0 6px',
        borderRadius: '8px',
        color: '#fff',
        flexShrink: 0,
      },
      statsBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
        padding: '4px 12px 8px',
      },
      statChip: { fontSize: '11px', padding: '0 8px', borderRadius: '8px', flexShrink: 0 },
      jumpButton: {
        fontSize: '11px',
        padding: '0 8px',
        borderRadius: '6px',
        border: '1px solid ' + COLORS.border,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      ignoreButton: {
        fontSize: '10px',
        padding: '0 6px',
        borderRadius: '6px',
        border: '1px solid ' + COLORS.border,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        opacity: .7,
        flexShrink: 0,
      },
      commitBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 12px',
        borderTop: '1px solid ' + COLORS.border,
        flexShrink: 0,
      },
      commitNote: {
        flex: 1,
        fontSize: '11px',
        opacity: .75,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
      },
      empty: { padding: '24px 12px', textAlign: 'center', opacity: .5, fontSize: '12px' },
      syncNote: { padding: '4px 12px', fontSize: '11px', color: '#9a6700', flexShrink: 0 },
      diffEmpty: { padding: '4px 12px', opacity: .6, userSelect: 'none' },
    }

    function basename(path: string): string {
      const normalized = String(path || '').replace(/\/+$/, '')
      const index = normalized.lastIndexOf('/')
      const base = index < 0 ? normalized : normalized.slice(index + 1)
      return base || normalized || path || 'root'
    }

    // :hover needs real CSS (inline styles can't express it); inject once.
    if (typeof document !== 'undefined' && !document.getElementById('dsh-code-review-styles')) {
      const styleEl = document.createElement('style')
      styleEl.id = 'dsh-code-review-styles'
      styleEl.textContent = '.' + FILE_HEAD_CLASS + ':hover{background:' + COLORS.hover + '}'
      document.head.appendChild(styleEl)
    }

    /**
     * Read a JSON response tolerantly: the host fallback answers unclaimed
     * routes with an EMPTY 404 body (e.g. this plugin's routes before a dsh
     * restart), which makes the native res.json() throw an opaque
     * "Unexpected end of JSON input". Surface a useful message instead.
     */
    function readJson(res: Response): Promise<any> {
      return res.text().then((text) => {
        let body: any = null
        try { body = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }
        if (!res.ok) {
          throw new Error((body && body.error) ||
            (res.status === 404 ? '接口不存在（HTTP 404）——请重启 dsh 实例以加载最新插件' : 'HTTP ' + res.status))
        }
        return body
      })
    }

    /**
     * Undo C-style quoting used by git for paths with spaces/non-ASCII: \NNN
     * octal escapes (runs of them decode as UTF-8 byte sequences, matching how
     * the server reports the same paths) plus \t \n \\ \" etc.
     */
    function unquoteGitPath(token: string): string {
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
    function parsePatchSections(patch: string): Record<string, string> {
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
    type DiffLine = {
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
    function parseFileDiff(section: string): DiffLine[] {
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

    /**
     * Find the diff line a finding anchors to: same side (`old` targets
     * removed lines, `new` added/context ones), verbatim quote first with a
     * trimmed fallback, and the advisory line number disambiguating duplicate
     * quotes by proximity. Returns the line index or null.
     */
    function locateLine(lines: DiffLine[], finding: ReviewFinding): number | null {
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
      if (candidates.length === 1 || finding.line === null) return candidates[0]
      let best = candidates[0]
      let bestDistance = Infinity
      for (const index of candidates) {
        const lineNo = finding.side === 'old' ? lines[index].oldLine : lines[index].newLine
        const distance = lineNo === null ? Infinity : Math.abs(lineNo - finding.line)
        if (distance < bestDistance) {
          best = index
          bestDistance = distance
        }
      }
      return best
    }

    /** A finding paired with its index in review.findings (stable across renders). */
    type IndexedFinding = {
      index: number
      finding: ReviewFinding
    }

    type FindingPlacement = {
      /** Per-file diff lines, parsed once and shared with the renderer. */
      parsed: Map<string, DiffLine[]>
      /** Anchored findings: file path -> diff line index -> findings. */
      perLine: Map<string, Map<number, IndexedFinding[]>>
      /** Quoteless findings for a file present in the diff. */
      fileLevel: Map<string, IndexedFinding[]>
      /** Findings that could not be anchored (code changed since the review). */
      unanchored: IndexedFinding[]
      /** Indices of findings placed somewhere in the current diff. */
      anchored: Set<number>
    }

    /** Anchor every finding to its diff line, file header, or the fallback list. */
    function placeFindings(findings: ReviewFinding[], sections: Record<string, string>): FindingPlacement {
      const placement: FindingPlacement = { parsed: new Map(), perLine: new Map(), fileLevel: new Map(), unanchored: [], anchored: new Set() }
      findings.forEach((finding, index) => {
        const entry: IndexedFinding = { index, finding }
        const section = sections[finding.path]
        if (!section) {
          placement.unanchored.push(entry)
          return
        }
        if (!finding.quote) {
          const list = placement.fileLevel.get(finding.path) || []
          list.push(entry)
          placement.fileLevel.set(finding.path, list)
          placement.anchored.add(index)
          return
        }
        let lines = placement.parsed.get(finding.path)
        if (!lines) {
          lines = parseFileDiff(section)
          placement.parsed.set(finding.path, lines)
        }
        const lineIndex = locateLine(lines, finding)
        if (lineIndex === null) {
          placement.unanchored.push(entry)
          return
        }
        let perLine = placement.perLine.get(finding.path)
        if (!perLine) {
          perLine = new Map()
          placement.perLine.set(finding.path, perLine)
        }
        const list = perLine.get(lineIndex) || []
        list.push(entry)
        perLine.set(lineIndex, list)
        placement.anchored.add(index)
      })
      return placement
    }

    function diffLineStyle(line: DiffLine): { color?: string; background?: string; opacity?: number } {
      if (line.kind === 'hunk') return { color: COLORS.hunk, background: COLORS.hunkBg }
      if (line.kind === 'add') return { color: COLORS.add, background: COLORS.addBg }
      if (line.kind === 'del') return { color: COLORS.del, background: COLORS.delBg }
      return { opacity: .8 }
    }

    /**
     * One review finding rendered as a card, inline below its diff line. The
     * element id anchors the prev/next jump buttons; `mark` dims the card and
     * swaps the ignore toggle for a status badge.
     */
    function findingCard(
      entry: IndexedFinding,
      key: string | number,
      mark: FindingMark | undefined,
      active: boolean,
      onToggleIgnore: (index: number) => void,
    ) {
      const finding = entry.finding
      const severity = SEVERITY_BADGES[finding.severity] || SEVERITY_BADGES.normal
      return h('div', {
        key: key,
        id: 'dsh-finding-' + entry.index,
        style: Object.assign({}, styles.findingCard, {
          borderLeft: '3px solid ' + severity.color,
          background: 'color-mix(in srgb, ' + severity.color + ' 8%, transparent)',
          opacity: mark ? .55 : 1,
          outline: active ? '2px solid ' + severity.color : 'none',
          outlineOffset: '1px',
        }),
      },
        h('div', { style: styles.findingHead },
          h('span', { style: Object.assign({}, styles.severityBadge, { background: severity.color }) }, severity.label),
          h('span', { style: { fontWeight: 600, flex: 1, minWidth: 0 } }, finding.title),
          mark === 'ignored' ? h('span', {
            style: Object.assign({}, styles.statChip, { color: '#57606a', background: 'rgba(128,128,128,.15)' }),
          }, '已忽略') : null,
          mark === 'resolved' ? h('span', {
            style: Object.assign({}, styles.statChip, { color: '#fff', background: COLORS.add }),
          }, '已修改') : null,
          mark === 'resolved' ? null : h('button', {
            style: styles.ignoreButton,
            title: mark === 'ignored' ? '恢复这条检视意见' : '忽略这条检视意见',
            onClick: (event: any) => { event.stopPropagation(); onToggleIgnore(entry.index) },
          }, mark === 'ignored' ? '恢复' : '忽略')),
        finding.detail ? h('div', { style: styles.findingDetail }, finding.detail) : null)
    }

    function badge(status: string) {
      const info = STATUS_BADGES[status] || { label: status, color: '#57606a' }
      return h('span', {
        style: Object.assign({}, styles.badge, {
          color: info.color,
          background: 'color-mix(in srgb, ' + info.color + ' 12%, transparent)',
        }),
      }, info.label)
    }

    function fileEntry(
      file: FileChange,
      lines: DiffLine[] | undefined,
      closed: boolean,
      onToggle: () => void,
      perLine?: Map<number, IndexedFinding[]>,
      fileLevel?: IndexedFinding[],
      renderFinding?: (entry: IndexedFinding, key: string | number) => any,
    ) {
      const children = [
        h('div', {
          key: 'head',
          style: styles.fileHeader,
          title: file.path,
          onClick: onToggle,
          className: FILE_HEAD_CLASS,
        },
          h('span', { style: styles.caret }, closed ? '▸' : '▾'),
          h('span', { style: styles.filePath }, file.path),
          badge(file.status),
          h('span', { style: styles.stats },
            h('span', { style: { color: COLORS.add } }, '+' + file.additions),
            ' ',
            h('span', { style: { color: COLORS.del } }, '−' + file.deletions))),
      ]
      if (!closed && !lines) {
        children.push(h('div', {
          key: 'empty',
          style: Object.assign({}, styles.diffBody, styles.diffEmpty),
        }, '二进制文件或无文本差异'))
      }
      if (!closed && lines) {
        const body: any[] = []
        if (fileLevel && fileLevel.length > 0 && renderFinding) {
          fileLevel.forEach((entry, index) => { body.push(renderFinding(entry, 'file-' + index)) })
        }
        lines.forEach((line, index) => {
          body.push(h('div', {
            key: 'line-' + index,
            style: Object.assign({}, styles.diffLine, diffLineStyle(line)),
          },
            h('span', { style: styles.gutter }, line.oldLine === null ? '' : String(line.oldLine)),
            h('span', { style: styles.gutter }, line.newLine === null ? '' : String(line.newLine)),
            line.kind === 'hunk' ? line.content : line.content || ' '))
          const anchored = perLine && perLine.get(index)
          if (anchored && renderFinding) {
            anchored.forEach((entry, i) => { body.push(renderFinding(entry, 'f-' + index + '-' + i)) })
          }
        })
        children.push(h('div', { key: 'body', style: styles.diffBody }, body))
      }
      return h('div', { key: file.path }, children)
    }

    /**
     * The changes tab body: the working-tree diff of the session's workspace.
     * No manual refresh — the view polls the API every few seconds and only
     * re-renders when the diff actually changed. The seat is session-scoped,
     * so the slot framework passes the session id in props; the host maps it
     * to the session workspace's repo path.
     */
    function ChangesPanelBody(props: { sessionId?: string } | undefined) {
      const sessionId = props && props.sessionId
      const [data, setData] = react.useState<ChangesBody | null>(null)
      const [error, setError] = react.useState<string | null>(null)
      const [closed, setClosed] = react.useState<Record<string, boolean>>({})
      const [review, setReview] = react.useState<ReviewState | null>(null)
      const [reviewClosed, setReviewClosed] = react.useState(false)
      const [models, setModels] = react.useState<ModelsBody | null>(null)
      // Finding dispositions (manual ignore / auto resolved), keyed by the
      // finding's index inside the current review.
      const [marks, setMarks] = react.useState<Record<number, FindingMark>>({})
      // Finding index the jump buttons last landed on (drives the highlight).
      const [activeFinding, setActiveFinding] = react.useState<number | null>(null)
      const [commit, setCommit] = react.useState<CommitState | null>(null)
      // Indices that anchored at least once; losing the anchor afterwards
      // means the reviewed code was edited, which auto-marks "已修改".
      const everAnchoredRef = react.useRef<Set<number>>(new Set())
      // The chosen model as a "provider/model" string; "" means the host default.
      const [choice, setChoice] = react.useState(() => {
        try { return localStorage.getItem(MODEL_KEY) || '' } catch { return '' }
      })
      const snapshotRef = react.useRef<string | null>(null)
      const inflightRef = react.useRef(false)

      // Load the selectable model catalog once; a failure just hides the picker.
      react.useEffect(() => {
        let cancelled = false
        fetch('/review-panel/api/models')
          .then(readJson)
          .then((body) => { if (!cancelled) setModels(body) }, () => {})
        return () => { cancelled = true }
      }, [])

      // Restore the repo's latest review (running or persisted) so the panel
      // survives reloads and dsh restarts. Never clobbers a run started here.
      react.useEffect(() => {
        let cancelled = false
        const params = new URLSearchParams()
        if (sessionId) params.set('session', sessionId)
        fetch('/review-panel/api/review/latest?' + params.toString())
          .then((res) => res.status === 404 ? null : readJson(res))
          .then((body) => {
            if (cancelled || !body) return
            setReview((prev) => prev ? prev : body)
          }, () => {})
        return () => { cancelled = true }
      }, [sessionId])

      // A persisted choice whose provider/model vanished falls back to default.
      const choiceValid = !choice || !!(models && models.providers.some((provider) => {
        return provider.models.some((model) => {
          return choice === provider.id + '/' + model.id
        })
      }))
      const effectiveChoice = choiceValid ? choice : ''

      const pickModel = react.useCallback((event: any) => {
        const value = event.target.value
        setChoice(value)
        try { localStorage.setItem(MODEL_KEY, value) } catch {}
      }, [])

      const startReview = react.useCallback(() => {
        if (review && review.status === 'running') return
        const params = new URLSearchParams()
        if (sessionId) params.set('session', sessionId)
        if (effectiveChoice) {
          const slash = effectiveChoice.indexOf('/')
          params.set('provider', effectiveChoice.slice(0, slash))
          params.set('model', effectiveChoice.slice(slash + 1))
        }
        setReview({ status: 'running' })
        setReviewClosed(false)
        fetch('/review-panel/api/review/start?' + params.toString(), { method: 'POST' })
          .then(readJson)
          .then((body) => { setReview({ id: body.id, status: 'running' }) },
            (err) => { setReview({ status: 'error', error: String(err && err.message || err) }) })
      }, [sessionId, review, effectiveChoice])

      // Poll a running review until the subagent settles.
      const reviewId = review && review.id
      const reviewRunning = review && review.status === 'running' && reviewId
      react.useEffect(() => {
        if (!reviewRunning) return
        let failures = 0
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          fetch('/review-panel/api/review/status?id=' + encodeURIComponent(reviewId))
            .then(readJson)
            .then((body) => {
              failures = 0
              setReview((prev) => {
                if (!prev || prev.id !== body.id) return prev
                if (body.status && body.status !== 'running') return body
                // Still running: adopt the resolved model label once the runner knows it.
                return body.model && !prev.model ? Object.assign({}, prev, { model: body.model }) : prev
              })
            }, (err) => {
              // Transient failures keep the run alive (compare the changes
              // poller); only a streak of misses gives up, and the functional
              // update drops the error if the user already started a new run.
              failures++
              if (failures < MAX_REVIEW_POLL_FAILURES) return
              setReview((prev) => {
                if (!prev || prev.id !== reviewId) return prev
                return { status: 'error', error: String(err && err.message || err) }
              })
            })
        }, 2000)
        return () => { clearInterval(timer) }
      }, [reviewRunning, reviewId])

      // Files that received findings are auto-expanded so their cards show.
      const reviewFindings = review && review.findings
      react.useEffect(() => {
        if (!reviewFindings || reviewFindings.length === 0) return
        setClosed((prev) => {
          const next = Object.assign({}, prev)
          for (const finding of reviewFindings) next[finding.path] = false
          return next
        })
      }, [reviewFindings])

      // A new review id resets the dispositions; a restored review (panel
      // reload, dsh restart) picks its saved marks back up.
      react.useEffect(() => {
        everAnchoredRef.current = new Set()
        setActiveFinding(null)
        if (!reviewId) {
          setMarks({})
          return
        }
        try {
          const saved: unknown = JSON.parse(localStorage.getItem(MARKS_KEY + reviewId) || '{}')
          setMarks(saved && typeof saved === 'object' ? saved as Record<number, FindingMark> : {})
        } catch {
          setMarks({})
        }
      }, [reviewId])

      react.useEffect(() => {
        if (!reviewId) return
        try { localStorage.setItem(MARKS_KEY + reviewId, JSON.stringify(marks)) } catch {}
      }, [reviewId, marks])

      const toggleIgnore = react.useCallback((index: number) => {
        setMarks((prev) => {
          const next = Object.assign({}, prev)
          if (next[index] === 'ignored') delete next[index]
          else next[index] = 'ignored'
          return next
        })
      }, [])

      const sync = react.useCallback(() => {
        if (inflightRef.current) return
        inflightRef.current = true
        const params = new URLSearchParams({ scope: 'working-tree' })
        if (sessionId) params.set('session', sessionId)
        fetch('/review-panel/api/changes?' + params.toString())
          .then(readJson)
          .then((body) => {
            const snapshot = JSON.stringify([body.files, body.patch, body.truncated, body.cwd])
            if (snapshotRef.current !== snapshot) {
              snapshotRef.current = snapshot
              setData(body)
            }
            setError(null)
          }, (err) => {
            // Keep the last good view; surface the failure as the header note
            // once data exists, or as the whole content before the first load.
            setError(String(err && err.message || err))
          })
          .then(() => { inflightRef.current = false })
      }, [sessionId])

      react.useEffect(() => {
        sync()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          sync()
        }, POLL_MS)
        return () => { clearInterval(timer) }
      }, [sync])

      const startCommit = react.useCallback((push: boolean) => {
        if (commit && commit.status === 'running') return
        const params = new URLSearchParams()
        if (sessionId) params.set('session', sessionId)
        if (push) params.set('push', '1')
        if (effectiveChoice) {
          const slash = effectiveChoice.indexOf('/')
          params.set('provider', effectiveChoice.slice(0, slash))
          params.set('model', effectiveChoice.slice(slash + 1))
        }
        setCommit({ status: 'running', pushed: push })
        fetch('/review-panel/api/commit/start?' + params.toString(), { method: 'POST' })
          .then(readJson)
          .then((body) => { setCommit({ id: body.id, status: 'running', pushed: push }) },
            (err) => { setCommit({ status: 'error', error: String(err && err.message || err) }) })
      }, [sessionId, commit, effectiveChoice])

      // Poll a running commit until the server finishes (message generation
      // plus the git operations), then refresh the diff right away.
      const commitRunning = commit && commit.status === 'running'
      const commitId = commit && commit.id
      react.useEffect(() => {
        if (!commitRunning || !commitId) return
        let failures = 0
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          fetch('/review-panel/api/commit/status?id=' + encodeURIComponent(commitId))
            .then(readJson)
            .then((body) => {
              failures = 0
              setCommit((prev) => {
                if (!prev || prev.id !== body.id) return prev
                return body
              })
              if (body.status && body.status !== 'running') sync()
            }, (err) => {
              failures++
              if (failures < MAX_REVIEW_POLL_FAILURES) return
              setCommit((prev) => {
                if (!prev || prev.id !== commitId) return prev
                return { status: 'error', error: String(err && err.message || err) }
              })
            })
        }, 2000)
        return () => { clearInterval(timer) }
      }, [commitRunning, commitId, sync])

      const toggle = react.useCallback((path: string) => {
        setClosed((prev) => ({ ...prev, [path]: !prev[path] }))
      }, [])

      // Parse the diff only when its inputs change; a render driven by the
      // collapse state or the polling flag must not re-parse a 512KB patch.
      const sections = react.useMemo(() => {
        return data && data.files.length > 0 ? parsePatchSections(data.patch) : null
      }, [data])
      const placement = react.useMemo(() => {
        return sections && reviewFindings && reviewFindings.length > 0
          ? placeFindings(reviewFindings, sections)
          : null
      }, [sections, reviewFindings])
      const parsedByPath = react.useMemo(() => {
        const map = new Map<string, DiffLine[]>()
        if (sections && data) {
          for (const file of data.files) {
            const section = sections[file.path]
            if (section) map.set(file.path, parseFileDiff(section))
          }
        }
        return map
      }, [sections, data])

      // A finding that anchored before but no longer matches the live diff
      // means its code was edited since the review: mark it 已修改 (sticky —
      // editing back does not reopen it).
      const anchoredNow = placement ? placement.anchored : null
      react.useEffect(() => {
        if (!anchoredNow || !reviewFindings) return
        const ever = everAnchoredRef.current
        const stale: number[] = []
        for (let i = 0; i < reviewFindings.length; i++) {
          if (anchoredNow.has(i)) ever.add(i)
          else if (ever.has(i)) stale.push(i)
        }
        if (stale.length === 0) return
        setMarks((prev) => {
          let changed = false
          const next = Object.assign({}, prev)
          for (const index of stale) {
            if (!next[index]) {
              next[index] = 'resolved'
              changed = true
            }
          }
          return changed ? next : prev
        })
      }, [anchoredNow, reviewFindings])

      // Finding indices in on-screen order: per file (file-level first, then
      // top to bottom), with the unanchored fallback last. Drives the jump.
      const jumpList = react.useMemo(() => {
        if (!reviewFindings || reviewFindings.length === 0) return [] as number[]
        const order: number[] = []
        if (data && placement) {
          for (const file of data.files) {
            const level = placement.fileLevel.get(file.path)
            if (level) for (const entry of level) order.push(entry.index)
            const perLine = placement.perLine.get(file.path)
            if (perLine) {
              const lineIndices = Array.from(perLine.keys()).sort((a, b) => a - b)
              for (const lineIndex of lineIndices) {
                for (const entry of perLine.get(lineIndex)!) order.push(entry.index)
              }
            }
          }
          for (const entry of placement.unanchored) order.push(entry.index)
        } else {
          for (let i = 0; i < reviewFindings.length; i++) order.push(i)
        }
        return order
      }, [data, placement, reviewFindings])

      const jumpToFinding = react.useCallback((delta: number) => {
        if (jumpList.length === 0) return
        let pos = activeFinding === null
          ? (delta > 0 ? 0 : jumpList.length - 1)
          : jumpList.indexOf(activeFinding) + delta
        pos = Math.min(jumpList.length - 1, Math.max(0, pos))
        const index = jumpList[pos]
        setActiveFinding(index)
        if (typeof document !== 'undefined') {
          const el = document.getElementById('dsh-finding-' + index)
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
      }, [jumpList, activeFinding])

      // Severity/mark counts for the stats bar on top of the review box.
      const findingStats = react.useMemo(() => {
        if (!reviewFindings || reviewFindings.length === 0) return null
        const counts = { critical: 0, normal: 0, suggestion: 0, ignored: 0, resolved: 0 }
        for (let i = 0; i < reviewFindings.length; i++) {
          counts[severityOf(reviewFindings[i])]++
          if (marks[i] === 'ignored') counts.ignored++
          else if (marks[i] === 'resolved') counts.resolved++
        }
        return counts
      }, [reviewFindings, marks])

      const renderFinding = react.useCallback((entry: IndexedFinding, key: string | number) => {
        return findingCard(entry, key, marks[entry.index], activeFinding === entry.index, toggleIgnore)
      }, [marks, activeFinding, toggleIgnore])

      let header: any = null
      let content: any
      if (!data && error) {
        content = h('div', { style: Object.assign({}, styles.empty, { color: COLORS.del, opacity: 1 }) }, error)
      } else if (!data) {
        content = h('div', { style: styles.empty }, '加载中…')
      } else {
        let modelPicker: any = null
        if (models && models.providers.some((provider) => provider.models.length > 0)) {
          const options = [h('option', {
            key: '',
            value: '',
          }, models.default
            ? '默认（' + models.default.provider + '/' + models.default.model + '）'
            : '默认模型')]
          models.providers.forEach((provider) => {
            provider.models.forEach((model) => {
              const value = provider.id + '/' + model.id
              options.push(h('option', { key: value, value: value, title: model.name }, value))
            })
          })
          modelPicker = h('select', {
            style: styles.modelSelect,
            value: effectiveChoice,
            disabled: !!(review && review.status === 'running'),
            title: '检视使用的模型',
            onChange: pickModel,
          }, options)
        }
        header = h('div', { style: styles.header },
          h('div', { style: styles.headerRow },
            h('div', { style: styles.repoName, title: data.cwd }, basename(data.cwd)),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 } },
              modelPicker,
              h('button', {
                style: styles.reviewButton,
                disabled: review && review.status === 'running',
                onClick: startReview,
              }, review && review.status === 'running' ? '检视中…' : '开始检视'))),
          h('div', { style: styles.headerMeta },
            data.files.length + ' 个文件变更 · 自动同步' + (data.truncated ? ' · diff 已截断' : '')))
        if (data.files.length === 0) {
          content = h('div', { style: styles.empty }, '工作区干净，没有未提交的变更')
        } else {
          content = h('div', { style: styles.list },
            data.files.map((file) => {
              const lines = parsedByPath.get(file.path)
              return fileEntry(file, lines, !!closed[file.path], () => { toggle(file.path) },
                placement ? placement.perLine.get(file.path) : undefined,
                placement ? placement.fileLevel.get(file.path) : undefined,
                renderFinding)
            }))
        }
      }

      let reviewSection: any = null
      if (review) {
        let reviewTitle = review.status === 'running' ? '智能体检视中…'
          : review.status === 'done' ? '检视结果'
          : '检视失败'
        if (review.model) reviewTitle += ' · ' + review.model
        if (review.startedAt) reviewTitle += ' · ' + new Date(review.startedAt).toLocaleString()
        const verdict = review.verdict ? VERDICT_BADGES[review.verdict] : undefined
        // Findings the anchoring pass could not place (code changed since the
        // review, or the file left the diff) still surface here, never lost.
        // Without a loaded diff at all, every finding falls back to this list.
        const unanchored: IndexedFinding[] = placement ? placement.unanchored
          : (data && review.status !== 'running' && review.findings
            ? review.findings.map((finding, index) => ({ index, finding }))
            : [])
        let reviewBody: any = null
        if (!reviewClosed) {
          if (review.status === 'running') {
            reviewBody = h('pre', { style: styles.reviewText }, '独立智能体正在阅读 diff，通常需要几十秒…')
          } else {
            const blocks: any[] = []
            if (review.status === 'error') {
              blocks.push(h('pre', {
                key: 'error',
                style: Object.assign({}, styles.reviewText, { color: COLORS.del }),
              }, review.error || '(无输出)'))
            } else if (findingStats) {
              const chips: any[] = SEVERITY_STATS_ORDER.map((item) => h('span', {
                key: item.id,
                style: Object.assign({}, styles.statChip, { color: '#fff', background: item.color }),
              }, item.label + ' ' + findingStats[item.id]))
              if (findingStats.ignored > 0) {
                chips.push(h('span', {
                  key: 'ignored',
                  style: Object.assign({}, styles.statChip, { color: '#57606a', background: 'rgba(128,128,128,.15)' }),
                }, '已忽略 ' + findingStats.ignored))
              }
              if (findingStats.resolved > 0) {
                chips.push(h('span', {
                  key: 'resolved',
                  style: Object.assign({}, styles.statChip, { color: '#fff', background: COLORS.add }),
                }, '已修改 ' + findingStats.resolved))
              }
              blocks.push(h('div', { key: 'stats', style: styles.statsBar }, chips))
            } else if (review.text) {
              // No structured block survived parsing (a malformed or very old
              // review): fall back to the raw text rather than showing nothing.
              blocks.push(h('pre', { key: 'text', style: styles.reviewText }, review.text))
            } else {
              blocks.push(h('div', { key: 'clean', style: styles.reviewText }, '未发现问题，没有检视意见'))
            }
            if (unanchored.length > 0) {
              blocks.push(h('div', { key: 'unanchored' },
                h('div', { style: { padding: '0 12px', fontSize: '11px', opacity: .6 } },
                  '以下意见未能定位到当前代码（可能在检视后已修改）：'),
                unanchored.map((entry) => renderFinding(entry, 'u-' + entry.index))))
            }
            reviewBody = h('div', null, blocks)
          }
        }
        const activePos = activeFinding === null ? -1 : jumpList.indexOf(activeFinding)
        reviewSection = h('div', { style: styles.reviewBox },
          h('div', { style: styles.reviewBoxHeader },
            h('span', { style: { minWidth: 0 } },
              verdict ? h('span', {
                style: Object.assign({}, styles.severityBadge, { background: verdict.color, marginRight: '6px' }),
              }, verdict.label) : null,
              reviewTitle),
            h('span', { style: { display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 } },
              jumpList.length > 0 ? h('button', {
                style: styles.jumpButton,
                title: '上一条检视意见',
                onClick: () => { jumpToFinding(-1) },
              }, '↑') : null,
              jumpList.length > 0 ? h('span', { style: { fontSize: '10px', opacity: .6 } },
                activePos >= 0 ? (activePos + 1) + '/' + jumpList.length : '共 ' + jumpList.length + ' 条') : null,
              jumpList.length > 0 ? h('button', {
                style: styles.jumpButton,
                title: '下一条检视意见',
                onClick: () => { jumpToFinding(1) },
              }, '↓') : null,
              h('span', {
                style: { cursor: 'pointer', opacity: .5, fontSize: '10px', flexShrink: 0 },
                onClick: () => { setReviewClosed(!reviewClosed) },
              }, reviewClosed ? '▸ 展开' : '▾ 收起'))),
          reviewBody)
      }

      // Bottom bar of the changes page: commit the working tree with an
      // auto-generated message, optionally pushing afterwards.
      let commitBar: any = null
      if (data && data.files.length > 0) {
        let note: any = null
        if (commit) {
          if (commit.status === 'running') {
            note = commit.pushed ? '正在生成 commit 信息并提交、推送…' : '正在生成 commit 信息并提交…'
          } else if (commit.status === 'error') {
            note = h('span', { style: { color: COLORS.del } }, '提交失败：' + (commit.error || '未知错误'))
          } else {
            note = '已提交 ' + (commit.commit || '') +
              (commit.pushed ? ' 并推送' : '') +
              (commit.pushError ? '（推送失败：' + commit.pushError + '）' : '') +
              (commit.message ? ' · ' + commit.message.split('\n', 1)[0] : '')
          }
        }
        commitBar = h('div', { style: styles.commitBar },
          h('span', {
            style: styles.commitNote,
            title: commit && commit.message ? commit.message : undefined,
          }, note),
          h('button', {
            style: styles.reviewButton,
            disabled: !!commitRunning,
            title: '自动生成 commit 信息并提交全部变更',
            onClick: () => { startCommit(false) },
          }, commitRunning && commit && commit.pushed === false ? '提交中…' : '提交'),
          h('button', {
            style: styles.reviewButton,
            disabled: !!commitRunning,
            title: '自动生成 commit 信息，提交并推送到远端',
            onClick: () => { startCommit(true) },
          }, commitRunning && commit && commit.pushed ? '提交并推送中…' : '提交并推送'))
      }

      return h('div', { style: styles.root },
        header,
        reviewSection,
        data && error ? h('div', { style: styles.syncNote }, '同步失败，稍后自动重试：' + error) : null,
        content,
        commitBar)
    }

    /** Required client services: the slot registry and the right-sidebar tab registry. */
    const inject = ['slots', 'sidebarRightTabs']

    /**
     * Client plugin body: register the tab type (stage one) and its body
     * (stage two). Both registrations live exactly as long as this plugin.
     */
    function apply(ctx: ClientContext) {
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

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
