//! Diff rendering for the panel: per-file entries with fold/caret, status
//! badges, line-level coloring, and the finding cards anchored under diff
//! lines or at a file's top.

import type { CSSProperties, ReactNode } from 'react'

import type { ReviewFinding } from '../review/findings.js'
import type { FileChange } from '../service/types.js'
import {
  diffLineDomId,
  type DiffLine,
  type FindingGroup,
} from '../shared/diff.js'
import type { FindingMark } from './api.js'

const FILE_HEAD_CLASS = 'dsh-review-file-head'

export const COLORS = {
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
export const SEVERITY_STATS_ORDER = [
  { id: 'critical', label: '严重', color: '#d1242f' },
  { id: 'normal', label: '一般', color: '#bc4c00' },
  { id: 'suggestion', label: '建议', color: '#0969da' },
] as const

export const VERDICT_BADGES: Record<string, { label: string; color: string }> = {
  approve: { label: '可以提交', color: COLORS.add },
  'changes-suggested': { label: '建议修改后提交', color: '#9a6700' },
  'must-fix': { label: '必须修改', color: COLORS.del },
}

export const styles: Record<string, CSSProperties> = {
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

export function basename(path: string): string {
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

function badge(status: string) {
  const info = STATUS_BADGES[status] || { label: status, color: '#57606a' }
  return (
    <span
      style={Object.assign({}, styles.badge, {
        color: info.color,
        background: 'color-mix(in srgb, ' + info.color + ' 12%, transparent)',
      })}
    >
      {info.label}
    </span>
  )
}

function diffLineStyle(line: DiffLine): { color?: string; background?: string; opacity?: number } {
  if (line.kind === 'hunk') return { color: COLORS.hunk, background: COLORS.hunkBg }
  if (line.kind === 'add') return { color: COLORS.add, background: COLORS.addBg }
  if (line.kind === 'del') return { color: COLORS.del, background: COLORS.delBg }
  return { opacity: .8 }
}

/**
 * One finding group rendered as a card, inline below its diff line or at
 * the file's top. The element id anchors the prev/next jump buttons and
 * uses the representative's index; `mark` dims the card and swaps the
 * ignore toggle for a status badge. A deduped group lists its other
 * anchored occurrences as clickable line-number links.
 */
export function FindingCard(props: {
  group: FindingGroup
  mark: FindingMark | undefined
  active: boolean
  onToggleIgnore: (index: number) => void
  onJumpLine: (path: string, lineIndex: number) => void
}) {
  const { group, mark, active, onToggleIgnore, onJumpLine } = props
  const entry = group.rep
  const finding = entry.finding
  const severity = SEVERITY_BADGES[finding.severity] || SEVERITY_BADGES.normal
  const locations = group.count > 1
    ? group.members.filter((member) => member.lineIndex !== null && member.lineNo !== null)
    : []
  return (
    <div
      id={'dsh-finding-' + entry.index}
      style={Object.assign({}, styles.findingCard, {
        borderLeft: '3px solid ' + severity.color,
        background: 'color-mix(in srgb, ' + severity.color + ' 8%, transparent)',
        opacity: mark ? .55 : 1,
        outline: active ? '2px solid ' + severity.color : 'none',
        outlineOffset: '1px',
      })}
    >
      <div style={styles.findingHead}>
        <span style={Object.assign({}, styles.severityBadge, { background: severity.color })}>
          {severity.label}
        </span>
        <span style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{finding.title}</span>
        {mark === 'ignored' ? (
          <span
            style={Object.assign({}, styles.statChip, { color: '#57606a', background: 'rgba(128,128,128,.15)' })}
          >
            已忽略
          </span>
        ) : null}
        {mark === 'resolved' ? (
          <span style={Object.assign({}, styles.statChip, { color: '#fff', background: COLORS.add })}>
            已修改
          </span>
        ) : null}
        {mark === 'resolved' ? null : (
          <button
            style={styles.ignoreButton}
            title={mark === 'ignored' ? '恢复这条检视意见' : '忽略这条检视意见'}
            onClick={(event) => { event.stopPropagation(); onToggleIgnore(entry.index) }}
          >
            {mark === 'ignored' ? '恢复' : '忽略'}
          </button>
        )}
      </div>
      {finding.detail ? <div style={styles.findingDetail}>{finding.detail}</div> : null}
      {group.count > 1 ? (
        <div style={{ marginTop: '2px', fontSize: '11px', opacity: .85 }}>
          {'此文件中共出现 ' + group.count + ' 处' + (locations.length > 0 ? '：' : '')}
          {locations.map((member, i) => (
            <button
              key={'loc-' + i}
              style={Object.assign({}, styles.jumpButton, { padding: '0 4px', fontSize: '10px' })}
              title="跳转到该处代码"
              onClick={(event) => { event.stopPropagation(); onJumpLine(finding.path, member.lineIndex!) }}
            >
              {'第 ' + member.lineNo + ' 行'}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function FileEntry(props: {
  file: FileChange
  lines: DiffLine[] | undefined
  closed: boolean
  onToggle: () => void
  perLine?: Map<number, FindingGroup[]>
  fileLevel?: FindingGroup[]
  renderFinding?: (group: FindingGroup, key: string | number) => ReactNode
}) {
  const { file, lines, closed, onToggle, perLine, fileLevel, renderFinding } = props
  const body: ReactNode[] = []
  if (fileLevel && fileLevel.length > 0 && renderFinding) {
    fileLevel.forEach((group, index) => { body.push(renderFinding(group, 'file-' + index)) })
  }
  if (lines) {
    lines.forEach((line, index) => {
      body.push(
        <div
          key={'line-' + index}
          id={diffLineDomId(file.path, index)}
          style={Object.assign({}, styles.diffLine, diffLineStyle(line))}
        >
          <span style={styles.gutter}>{line.oldLine === null ? '' : String(line.oldLine)}</span>
          <span style={styles.gutter}>{line.newLine === null ? '' : String(line.newLine)}</span>
          {line.kind === 'hunk' ? line.content : line.content || ' '}
        </div>,
      )
      const anchored = perLine && perLine.get(index)
      if (anchored && renderFinding) {
        anchored.forEach((group, i) => { body.push(renderFinding(group, 'f-' + index + '-' + i)) })
      }
    })
  }
  return (
    <div>
      <div
        style={styles.fileHeader}
        title={file.path}
        onClick={onToggle}
        className={FILE_HEAD_CLASS}
      >
        <span style={styles.caret}>{closed ? '▸' : '▾'}</span>
        <span style={styles.filePath}>{file.path}</span>
        {badge(file.status)}
        <span style={styles.stats}>
          <span style={{ color: COLORS.add }}>+{file.additions}</span>{' '}
          <span style={{ color: COLORS.del }}>−{file.deletions}</span>
        </span>
      </div>
      {!closed && !lines ? (
        <div style={Object.assign({}, styles.diffBody, styles.diffEmpty)}>二进制文件或无文本差异</div>
      ) : null}
      {!closed && lines ? <div style={styles.diffBody}>{body}</div> : null}
    </div>
  )
}
