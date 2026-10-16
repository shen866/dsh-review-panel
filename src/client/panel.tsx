//! The changes tab body: the working-tree diff of the session's workspace.
//! No manual refresh — the view polls the API every few seconds and only
//! re-renders when the diff actually changed. The seat is session-scoped,
//! so the slot framework passes the session id in props; the host maps it
//! to the session workspace's repo path.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { ReviewFinding } from '../review/findings.js'
import {
  diffLineDomId,
  parseFileDiff,
  parsePatchSections,
  placeFindings,
  severityOf,
} from '../shared/diff.js'
import type { DiffLine, FindingGroup } from '../shared/diff.js'
import { readJson } from './api.js'
import type { ChangesBody, CommitState, FindingMark, ModelsBody, ReviewState } from './api.js'
import { basename, COLORS, FileEntry, FindingCard, styles, SEVERITY_STATS_ORDER, VERDICT_BADGES } from './diff-view.js'

const POLL_MS = 4000
const MODEL_KEY = 'dsh-review-panel:model'
const MARKS_KEY = 'dsh-review-panel:marks:'
const MAX_REVIEW_POLL_FAILURES = 5

/**
 * Case-insensitive ordered-subsequence rank of `query` against `name`, in the
 * spirit of the host picker: exact prefix wins, then subsequence matches by
 * first-hit offset; -1 means no match. Lower is better, ties keep catalog order.
 */
function rankByQuery(name: string, query: string): number {
  const text = name.toLowerCase()
  const wanted = query.trim().toLowerCase()
  if (!wanted) return 0
  if (text.startsWith(wanted)) return 1
  let from = 0
  for (const char of wanted) {
    const at = text.indexOf(char, from)
    if (at < 0) return -1
    from = at + 1
  }
  return 2 + text.indexOf(wanted.charAt(0))
}

// The picker's hover/sticky/fixed-position styling follows the host `/model`
// popup, which class-based CSS provides; inject it once like the host client
// modules inject their plugin CSS.
let modelPickerCssInjected = false
function ensureModelPickerCss() {
  if (modelPickerCssInjected || typeof document === 'undefined') return
  modelPickerCssInjected = true
  const tag = document.createElement('style')
  tag.dataset.pluginCss = 'dsh-review-panel/model-picker'
  tag.textContent = `
.dsh-crp-modelRoot{position:relative;min-width:0;flex-shrink:1}
.dsh-crp-modelTrigger{display:flex;align-items:center;gap:4px;height:24px;max-width:200px;padding:0 4px 0 8px;border:none;border-radius:6px;background:transparent;color:inherit;font-size:12px;line-height:20px;cursor:pointer;min-width:0}
.dsh-crp-modelTrigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.10))}
.dsh-crp-modelTrigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color, #0969da)}
.dsh-crp-modelTrigger:disabled{opacity:.5;cursor:default}
.dsh-crp-modelTriggerLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dsh-crp-modelChevron{flex:none;font-size:10px;opacity:.6;transition:transform .12s}
.dsh-crp-modelChevronOpen{transform:rotate(180deg)}
.dsh-crp-modelMenu{position:fixed;z-index:1100;display:flex;flex-direction:column;padding:4px;min-width:200px;max-width:min(320px, calc(100vw - 32px));max-height:min(360px, calc(100vh - 96px));overflow:hidden;background:var(--dsh-bg, #fff);color:inherit;border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
.dsh-crp-modelSearchRow{position:relative;flex-shrink:0;margin:2px 0 3px}
.dsh-crp-modelSearch{width:100%;box-sizing:border-box;padding:5px 24px 5px 7px;border:none;border-radius:6px;background:transparent;color:inherit;font-size:12px;outline:none}
.dsh-crp-modelSearch::placeholder{color:inherit;opacity:.45}
.dsh-crp-modelSearch:focus{box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1, rgba(128,128,128,.25))}
.dsh-crp-modelSearchClear{position:absolute;top:50%;right:4px;transform:translateY(-50%);width:20px;height:20px;padding:0;border:none;border-radius:50%;background:transparent;color:inherit;opacity:.6;cursor:pointer;font-size:10px;line-height:1}
.dsh-crp-modelSearchClear:hover{opacity:1}
.dsh-crp-modelGroups{min-height:0;overflow-y:auto;padding-bottom:2px}
.dsh-crp-modelGroupLabel{position:sticky;top:0;z-index:1;padding:4px 8px 2px;font-size:11px;opacity:.55;background:var(--dsh-bg, #fff)}
.dsh-crp-modelOption{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;min-height:30px;padding:4px 8px;border:none;border-radius:6px;background:transparent;color:inherit;font-size:12px;text-align:left;cursor:pointer}
.dsh-crp-modelOption:hover,.dsh-crp-modelOptionActive{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.10))}
.dsh-crp-modelName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-crp-modelCheck{flex:none;width:14px;text-align:center;font-size:12px}
.dsh-crp-modelEmpty{padding:8px;font-size:12px;opacity:.55}
`
  document.head.appendChild(tag)
}

interface ModelRow { groupId: string; groupName: string; value: string; label: string }

/**
 * Model picker styled after the host `/model` dialog: a quiet trigger button
 * opens a popup with a search field and a provider-grouped model list (sticky
 * group headers, check mark on the current choice, keyboard navigation that
 * keeps focus in the search field). `value` is the "provider/model" string;
 * '' is the host default.
 */
function ModelPicker(props: { models: ModelsBody; value: string; disabled: boolean; onPick: (value: string) => void }) {
  const { models, value, disabled, onPick } = props
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  ensureModelPickerCss()

  const defaultLabel = models.default
    ? '默认（' + models.default.provider + '/' + models.default.model + '）'
    : '默认模型'

  // Provider groups, each filtered/sorted by the search query, with the
  // host-default row first — the one extra group the review flow needs.
  const groups = useMemo(() => {
    const list: { id: string; name: string; rows: ModelRow[] }[] = [
      { id: '', name: '默认', rows: [{ groupId: '', groupName: '默认', value: '', label: defaultLabel }] },
    ]
    for (const provider of models.providers) {
      const rows = provider.models
        .map((model) => ({ model, rank: rankByQuery(model.name, query) }))
        .filter((entry) => entry.rank >= 0)
        .sort((left, right) => left.rank - right.rank)
        .map((entry): ModelRow => ({
          groupId: provider.id,
          groupName: provider.name,
          value: provider.id + '/' + entry.model.id,
          label: entry.model.name,
        }))
      if (rows.length > 0) list.push({ id: provider.id, name: provider.name, rows })
    }
    return list
  }, [models, query, defaultLabel])

  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups])
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1))
  const activeRow = rows.length > 0 ? rows[activeIndex] : undefined

  // The trigger shows the catalog name when the choice resolves, else the raw
  // "provider/model" id, else the default label.
  const currentLabel = useMemo(() => {
    if (!value) return defaultLabel
    const slash = value.indexOf('/')
    const provider = models.providers.find((entry) => entry.id === value.slice(0, slash))
    const model = provider && provider.models.find((entry) => entry.id === value.slice(slash + 1))
    return model ? model.name : value
  }, [value, models, defaultLabel])

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }, [])

  const pick = useCallback((row: ModelRow) => {
    onPick(row.value)
    close(true)
  }, [onPick, close])

  const show = useCallback(() => {
    setQuery('')
    const index = rows.findIndex((row) => row.value === value)
    setActive(index < 0 ? 0 : index)
    setOpen(true)
    // Opening loads nothing here (the catalog loads once at mount), but the
    // focus move mirrors the host picker: a drilled pane focuses its search.
    queueMicrotask(() => { searchRef.current?.focus() })
  }, [rows, value])

  // Close on a click outside the trigger and the popup.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Node && rootRef.current?.contains(target)) return
      if (target instanceof Node && menuRef.current?.contains(target)) return
      close(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [open, close])

  // Place the popup above the trigger, right edges aligned, like the host
  // composer menu; clamp it into the viewport and follow scroll/resize.
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null)
      return
    }
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = menuRef.current?.offsetWidth ?? 0
      const height = menuRef.current?.offsetHeight ?? 0
      const margin = 12
      let x = rect.right - width
      let y = rect.top - 8 - height
      if (width > 0) x = Math.min(Math.max(x, margin), window.innerWidth - width - margin)
      if (height > 0) y = Math.min(Math.max(y, margin), window.innerHeight - height - margin)
      setMenuPos({ left: x, top: y })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, query, groups])

  // Keep the highlighted row visible while arrowing through the list.
  useLayoutEffect(() => {
    if (open) itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  const onSearchKeyDown = (event: any) => {
    if (event.nativeEvent && event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length === 0) return
      setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (activeRow) pick(activeRow)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'Tab') {
      // Keep Tab inside the popup like the host picker: leave on shift only.
      if (event.shiftKey) {
        event.preventDefault()
        close(true)
      }
    }
  }

  itemRefs.current = []
  let rowIndex = 0
  return (
    <div ref={rootRef} className="dsh-crp-modelRoot" title="检视使用的模型">
      <button
        ref={triggerRef}
        type="button"
        className="dsh-crp-modelTrigger"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { open ? close(true) : show() }}
      >
        <span className="dsh-crp-modelTriggerLabel">{currentLabel}</span>
        <span className={'dsh-crp-modelChevron' + (open ? ' dsh-crp-modelChevronOpen' : '')}>▾</span>
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="dsh-crp-modelMenu"
          role="menu"
          aria-label="选择检视模型"
          style={menuPos ?? { visibility: 'hidden' as const, left: 0, top: 0 }}
        >
          <div className="dsh-crp-modelSearchRow">
            <input
              ref={searchRef}
              className="dsh-crp-modelSearch"
              type="text"
              role="searchbox"
              placeholder="搜索模型…"
              value={query}
              onChange={(event: any) => { setQuery(event.target.value); setActive(0) }}
              onKeyDown={onSearchKeyDown}
            />
            {query ? (
              <button
                type="button"
                className="dsh-crp-modelSearchClear"
                title="清除搜索"
                onClick={() => { setQuery(''); setActive(0); searchRef.current?.focus() }}
              >
                ✕
              </button>
            ) : null}
          </div>
          <div className="dsh-crp-modelGroups">
            {groups.map((group) => (
              <div key={group.id || '__default__'}>
                <div className="dsh-crp-modelGroupLabel">{group.name}</div>
                {group.rows.map((row) => {
                  const index = rowIndex++
                  const selected = row.value === value
                  return (
                    <button
                      key={row.value || '__default__'}
                      ref={(node: HTMLButtonElement | null) => { itemRefs.current[index] = node }}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className={'dsh-crp-modelOption' + (index === activeIndex ? ' dsh-crp-modelOptionActive' : '')}
                      title={row.label}
                      onMouseEnter={() => { setActive(index) }}
                      onClick={() => { pick(row) }}
                    >
                      <span className="dsh-crp-modelName">{row.label}</span>
                      <span className="dsh-crp-modelCheck">{selected ? '✓' : ''}</span>
                    </button>
                  )
                })}
              </div>
            ))}
            {rows.length === 0 ? (
              <div className="dsh-crp-modelEmpty" role="status">
                {models.providers.length > 0 ? '没有匹配的模型。' : '没有可用的模型。'}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function ChangesPanelBody(props: { sessionId?: string } | undefined) {
  const sessionId = props && props.sessionId
  const [data, setData] = useState<ChangesBody | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const [review, setReview] = useState<ReviewState | null>(null)
  const [reviewClosed, setReviewClosed] = useState(false)
  const [models, setModels] = useState<ModelsBody | null>(null)
  // Finding dispositions (manual ignore / auto resolved), keyed by the
  // finding's index inside the current review.
  const [marks, setMarks] = useState<Record<number, FindingMark>>({})
  // Finding index the jump buttons last landed on (drives the highlight).
  const [activeFinding, setActiveFinding] = useState<number | null>(null)
  const [commit, setCommit] = useState<CommitState | null>(null)
  // Commit dialog: open state, the message draft, the mode of the run in
  // flight ('message' = generation only, 'commit' = the git operations), and
  // the "no message yet" hint shown when 提交/提交并推送 is clicked too early.
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [commitMode, setCommitMode] = useState<'message' | 'commit' | null>(null)
  const [commitWarn, setCommitWarn] = useState<string | null>(null)
  // Indices that anchored at least once; losing the anchor afterwards
  // means the reviewed code was edited, which auto-marks "已修改".
  const everAnchoredRef = useRef<Set<number>>(new Set())
  // The chosen model as a "provider/model" string; "" means the host default.
  const [choice, setChoice] = useState(() => {
    try { return localStorage.getItem(MODEL_KEY) || '' } catch { return '' }
  })
  const snapshotRef = useRef<string | null>(null)
  const inflightRef = useRef(false)

  // Load the selectable model catalog once; a failure just hides the picker.
  useEffect(() => {
    let cancelled = false
    fetch('/review-panel/api/models')
      .then(readJson)
      .then((body) => { if (!cancelled) setModels(body) }, () => {})
    return () => { cancelled = true }
  }, [])

  // Restore the repo's latest review (running or persisted) so the panel
  // survives reloads and dsh restarts. Never clobbers a run started here.
  useEffect(() => {
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

  const pickModel = useCallback((value: string) => {
    setChoice(value)
    try { localStorage.setItem(MODEL_KEY, value) } catch {}
  }, [])

  const startReview = useCallback(() => {
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
  useEffect(() => {
    if (!reviewRunning || !reviewId) return
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
  useEffect(() => {
    if (!reviewFindings || reviewFindings.length === 0) return
    setClosed((prev) => {
      const next = Object.assign({}, prev)
      for (const finding of reviewFindings) next[finding.path] = false
      return next
    })
  }, [reviewFindings])

  // A new review id resets the dispositions; a restored review (panel
  // reload, dsh restart) picks its saved marks back up.
  useEffect(() => {
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

  useEffect(() => {
    if (!reviewId) return
    try { localStorage.setItem(MARKS_KEY + reviewId, JSON.stringify(marks)) } catch {}
  }, [reviewId, marks])

  const toggleIgnore = useCallback((index: number) => {
    setMarks((prev) => {
      const next = Object.assign({}, prev)
      if (next[index] === 'ignored') delete next[index]
      else next[index] = 'ignored'
      return next
    })
  }, [])

  const sync = useCallback(() => {
    if (inflightRef.current) return
    inflightRef.current = true
    const params = new URLSearchParams({ scope: 'working-tree' })
    if (sessionId) params.set('session', sessionId)
    fetch('/review-panel/api/changes?' + params.toString())
      .then(readJson)
      .then((body) => {
        // repo status rides along: a finished merge, a new upstream ahead
        // count or a resolved conflict must re-render even when the diff
        // itself is unchanged, so it joins the snapshot comparison.
        const snapshot = JSON.stringify([body.files, body.patch, body.truncated, body.cwd, body.repo])
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

  useEffect(() => {
    sync()
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      sync()
    }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [sync])

  // Step two of the dialog: commit (and optionally push) with the draft. The
  // draft must exist — generation is step one's button, so an empty draft
  // only shows a hint instead of starting a run.
  const startCommit = useCallback((push: boolean) => {
    if (commit && commit.status === 'running') return
    const message = commitMsg.trim()
    if (!message) {
      setCommitWarn('请先生成或填写 commit 信息')
      return
    }
    setCommitWarn(null)
    const params = new URLSearchParams()
    if (sessionId) params.set('session', sessionId)
    if (push) params.set('push', '1')
    params.set('message', commitMsg)
    setCommitMode('commit')
    setCommit({ status: 'running', pushed: push })
    fetch('/review-panel/api/commit/start?' + params.toString(), { method: 'POST' })
      .then(readJson)
      .then((body) => { setCommit({ id: body.id, status: 'running', pushed: push }) },
        (err) => { setCommit({ status: 'error', error: String(err && err.message || err) }) })
  }, [sessionId, commit, commitMsg])

  // Step one of the dialog: generate the commit message only. The run never
  // touches git; when it settles the message lands in the draft textarea.
  const startCommitMsg = useCallback(() => {
    if (commit && commit.status === 'running') return
    setCommitWarn(null)
    const params = new URLSearchParams()
    if (sessionId) params.set('session', sessionId)
    if (effectiveChoice) {
      const slash = effectiveChoice.indexOf('/')
      params.set('provider', effectiveChoice.slice(0, slash))
      params.set('model', effectiveChoice.slice(slash + 1))
    }
    setCommitMode('message')
    setCommit({ status: 'running' })
    fetch('/review-panel/api/commit/message?' + params.toString(), { method: 'POST' })
      .then(readJson)
      .then((body) => { setCommit({ id: body.id, status: 'running' }) },
        (err) => { setCommit({ status: 'error', error: String(err && err.message || err) }) })
  }, [sessionId, commit, effectiveChoice])

  // Close the dialog on Escape unless a commit is in flight.
  useEffect(() => {
    if (!commitOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !(commit && commit.status === 'running')) setCommitOpen(false)
    }
    if (typeof document !== 'undefined') document.addEventListener('keydown', onKey)
    return () => { if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey) }
  }, [commitOpen, commit])

  // Poll a running commit until the server finishes (message generation
  // plus the git operations), then refresh the diff right away.
  const commitRunning = commit && commit.status === 'running'
  const commitId = commit && commit.id
  useEffect(() => {
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
          // The generation finished mid-run: the server exposes the message
          // before it commits, so surface it in the (disabled) input for a
          // moment instead of committing with invisible text. A user-typed
          // draft always wins; the input is disabled while running anyway.
          if (body.status === 'running' && body.message) {
            setCommitMsg((prev) => prev || body.message)
          }
          if (body.status && body.status !== 'running') {
            if (body.status === 'done' && commitMode === 'message') {
              // Generation finished: the draft (filled above or here) is the
              // result; drop the run so the buttons come back.
              if (body.message) setCommitMsg((prev) => prev || body.message)
              setCommit(null)
              return
            }
            if (body.status === 'done') {
              // The changes just landed: drop the review (findings can no
              // longer anchor to an empty diff) along with its marks so a
              // reload cannot resurrect them; the server clears its copy
              // of the persisted record.
              setReview((prev) => {
                if (prev && prev.id) {
                  try { localStorage.removeItem(MARKS_KEY + prev.id) } catch {}
                }
                return null
              })
            }
            sync()
          }
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

  // A finished commit closes the dialog shortly after showing its result; a
  // finished generation run never reaches this (it clears itself in the
  // poller). A failed run stays open so the error is visible (and retryable).
  const commitDone = !!(commit && commit.status === 'done')
  useEffect(() => {
    if (!commitDone) return
    const timer = setTimeout(() => {
      setCommitOpen(false)
      setCommitMsg('')
      setCommit(null)
      setCommitMode(null)
    }, 1500)
    return () => { clearTimeout(timer) }
  }, [commitDone])

  const toggle = useCallback((path: string) => {
    setClosed((prev) => ({ ...prev, [path]: !prev[path] }))
  }, [])

  // Parse the diff only when its inputs change; a render driven by the
  // collapse state or the polling flag must not re-parse a 512KB patch.
  const sections = useMemo(() => {
    return data && data.files.length > 0 ? parsePatchSections(data.patch) : null
  }, [data])
  const placement = useMemo(() => {
    return sections && reviewFindings && reviewFindings.length > 0
      ? placeFindings(reviewFindings, sections)
      : null
  }, [sections, reviewFindings])
  const parsedByPath = useMemo(() => {
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
  useEffect(() => {
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

  // Representative indices in on-screen order: per file (file-top cards
  // first, then top to bottom). Drives the jump buttons.
  const jumpList = useMemo(() => {
    if (!reviewFindings || reviewFindings.length === 0) return [] as number[]
    const order: number[] = []
    if (data && placement) {
      for (const file of data.files) {
        const level = placement.fileLevel.get(file.path)
        if (level) for (const group of level) order.push(group.rep.index)
        const perLine = placement.perLine.get(file.path)
        if (perLine) {
          const lineIndices = Array.from(perLine.keys()).sort((a, b) => a - b)
          for (const lineIndex of lineIndices) {
            for (const group of perLine.get(lineIndex)!) order.push(group.rep.index)
          }
        }
      }
    } else {
      for (let i = 0; i < reviewFindings.length; i++) order.push(i)
    }
    return order
  }, [data, placement, reviewFindings])

  const jumpToFinding = useCallback((delta: number) => {
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

  // A group's location link scrolls to that occurrence's diff line.
  const scrollToDiffLine = useCallback((path: string, lineIndex: number) => {
    if (typeof document === 'undefined') return
    const el = document.getElementById(diffLineDomId(path, lineIndex))
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  // Severity/mark counts for the stats bar on top of the review box.
  const findingStats = useMemo(() => {
    if (!reviewFindings || reviewFindings.length === 0) return null
    const counts = { critical: 0, normal: 0, suggestion: 0, ignored: 0, resolved: 0 }
    for (let i = 0; i < reviewFindings.length; i++) {
      counts[severityOf(reviewFindings[i])]++
      if (marks[i] === 'ignored') counts.ignored++
      else if (marks[i] === 'resolved') counts.resolved++
    }
    return counts
  }, [reviewFindings, marks])

  const renderFinding = useCallback((group: FindingGroup, key: string | number) => {
    return (
      <FindingCard
        key={key}
        group={group}
        mark={marks[group.rep.index]}
        active={activeFinding === group.rep.index}
        onToggleIgnore={toggleIgnore}
        onJumpLine={scrollToDiffLine}
      />
    )
  }, [marks, activeFinding, toggleIgnore, scrollToDiffLine])

  let header: any = null
  let content: any
  if (!data && error) {
    content = <div style={Object.assign({}, styles.empty, { color: COLORS.del, opacity: 1 })}>{error}</div>
  } else if (!data) {
    content = <div style={styles.empty}>加载中…</div>
  } else {
    let modelPicker: any = null
    if (models && models.providers.some((provider) => provider.models.length > 0)) {
      modelPicker = (
        <ModelPicker
          models={models}
          value={effectiveChoice}
          disabled={!!(review && review.status === 'running')}
          onPick={pickModel}
        />
      )
    }
    const repo = data.repo
    const badges: string[] = []
    if (repo) {
      if (repo.operation) {
        badges.push(
          repo.conflicts.length > 0
            ? `${repo.operation} 中 · ${repo.conflicts.length} 个文件冲突`
            : `${repo.operation} 中`,
        )
      }
      if (repo.unborn) badges.push('尚无提交')
      else if (repo.detached) badges.push('游离 HEAD')
      if (repo.ahead > 0) badges.push(`领先 ${repo.upstream} ${repo.ahead} 个提交`)
      if (repo.behind > 0) badges.push(`落后 ${repo.behind} 个提交`)
      if (repo.stashes > 0) badges.push(`${repo.stashes} 个 stash`)
    }
    header = (
      <div style={styles.header}>
        <div style={styles.headerRow}>
          <div style={styles.repoName} title={data.cwd}>{basename(data.cwd)}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            {modelPicker}
            <button
              style={styles.reviewButton}
              disabled={!!(review && review.status === 'running')}
              onClick={startReview}
            >
              {review && review.status === 'running' ? '检视中…' : '开始检视'}
            </button>
          </div>
        </div>
        <div style={styles.headerMeta}>
          {data.files.length + ' 个文件变更 · 自动同步' + (data.truncated ? ' · diff 已截断' : '')}
          {badges.length > 0 ? ' · ' + badges.join(' · ') : ''}
        </div>
      </div>
    )
    if (repo && repo.isRepo === false) {
      content = <div style={styles.empty}>当前目录不是 git 仓库</div>
    } else if (data.files.length === 0) {
      content = (
        <div style={styles.empty}>
          {repo && repo.ahead > 0
            ? `工作区干净，但有 ${repo.ahead} 个提交尚未推送`
            : repo && repo.operation
              ? '当前操作没有产生工作区变更'
              : '工作区干净，没有未提交的变更'}
        </div>
      )
    } else {
      content = (
        <div style={styles.list}>
          {data.files.map((file) => {
            const lines = parsedByPath.get(file.path)
            return (
              <FileEntry
                key={file.path}
                file={file}
                lines={lines}
                closed={!!closed[file.path]}
                onToggle={() => { toggle(file.path) }}
                perLine={placement ? placement.perLine.get(file.path) : undefined}
                fileLevel={placement ? placement.fileLevel.get(file.path) : undefined}
                renderFinding={renderFinding}
              />
            )
          })}
        </div>
      )
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
    let reviewBody: any = null
    if (!reviewClosed) {
      if (review.status === 'running') {
        reviewBody = <pre style={styles.reviewText}>独立智能体正在阅读 diff，通常需要几十秒…</pre>
      } else {
        const blocks: any[] = []
        if (review.status === 'error') {
          blocks.push(
            <pre key="error" style={Object.assign({}, styles.reviewText, { color: COLORS.del })}>
              {review.error || '(无输出)'}
            </pre>,
          )
        } else if (findingStats) {
          const chips: any[] = SEVERITY_STATS_ORDER.map((item) => (
            <span
              key={item.id}
              style={Object.assign({}, styles.statChip, { color: '#fff', background: item.color })}
            >
              {item.label + ' ' + findingStats[item.id]}
            </span>
          ))
          if (findingStats.ignored > 0) {
            chips.push(
              <span
                key="ignored"
                style={Object.assign({}, styles.statChip, { color: '#57606a', background: 'rgba(128,128,128,.15)' })}
              >
                {'已忽略 ' + findingStats.ignored}
              </span>,
            )
          }
          if (findingStats.resolved > 0) {
            chips.push(
              <span
                key="resolved"
                style={Object.assign({}, styles.statChip, { color: '#fff', background: COLORS.add })}
              >
                {'已修改 ' + findingStats.resolved}
              </span>,
            )
          }
          blocks.push(<div key="stats" style={styles.statsBar}>{chips}</div>)
        } else if (review.text) {
          // No structured block survived parsing (a malformed or very old
          // review): fall back to the raw text rather than showing nothing.
          blocks.push(<pre key="text" style={styles.reviewText}>{review.text}</pre>)
        } else {
          blocks.push(<div key="clean" style={styles.reviewText}>未发现问题，没有检视意见</div>)
        }
        reviewBody = <div>{blocks}</div>
      }
    }
    const activePos = activeFinding === null ? -1 : jumpList.indexOf(activeFinding)
    reviewSection = (
      <div style={styles.reviewBox}>
        <div style={styles.reviewBoxHeader}>
          <span style={{ minWidth: 0 }}>
            {verdict ? (
              <span
                style={Object.assign({}, styles.severityBadge, { background: verdict.color, marginRight: '6px' })}
              >
                {verdict.label}
              </span>
            ) : null}
            {reviewTitle}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
            {jumpList.length > 0 ? (
              <button style={styles.jumpButton} title="上一条检视意见" onClick={() => { jumpToFinding(-1) }}>↑</button>
            ) : null}
            {jumpList.length > 0 ? (
              <span style={{ fontSize: '10px', opacity: .6 }}>
                {activePos >= 0 ? (activePos + 1) + '/' + jumpList.length : '共 ' + jumpList.length + ' 条'}
              </span>
            ) : null}
            {jumpList.length > 0 ? (
              <button style={styles.jumpButton} title="下一条检视意见" onClick={() => { jumpToFinding(1) }}>↓</button>
            ) : null}
            <span
              style={{ cursor: 'pointer', opacity: .5, fontSize: '10px', flexShrink: 0 }}
              onClick={() => { setReviewClosed(!reviewClosed) }}
            >
              {reviewClosed ? '▸ 展开' : '▾ 收起'}
            </span>
          </span>
        </div>
        {reviewBody}
      </div>
    )
  }

  // Bottom bar of the changes page: a single commit button that opens the
  // commit dialog (stats + message + commit/push choices). Unresolved merge
  // conflicts block committing (the server rejects it too) — the auto-stage
  // would happily record conflict markers as content.
  let commitBar: any = null
  let commitModal: any = null
  if (data && data.files.length > 0) {
    const conflicts = data.repo ? data.repo.conflicts.length : 0
    commitBar = (
      <div style={styles.commitBar}>
        <button
          style={styles.reviewButton}
          disabled={!!commitRunning || conflicts > 0}
          title={conflicts > 0 ? `存在 ${conflicts} 个未解决冲突的文件，无法提交` : '提交全部变更'}
          onClick={() => { setCommitWarn(null); setCommitOpen(true) }}
        >
          提交
        </button>
      </div>
    )

    if (commitOpen) {
      let additions = 0
      let deletions = 0
      for (const file of data.files) {
        additions += file.additions
        deletions += file.deletions
      }
      let statusLine: any = null
      if (commitWarn && !commitRunning) {
        statusLine = <span style={styles.modalError}>{commitWarn}</span>
      } else if (commit) {
        if (commit.status === 'running') {
          // Generation runs surface '正在生成'; commit runs with a message
          // in hand go straight to the git phase.
          statusLine = commitMode === 'message' || !commit.message
            ? '正在生成 commit 信息…'
            : (commit.pushed ? '正在提交并推送…' : '正在提交…')
        } else if (commit.status === 'error') {
          statusLine = <span style={styles.modalError}>
            {(commitMode === 'message' ? '生成失败：' : '提交失败：') + (commit.error || '未知错误')}
          </span>
        } else {
          statusLine = '已提交 ' + (commit.commit || '') +
            (commit.pushed ? ' 并推送' : '') +
            (commit.pushError ? '（推送失败：' + commit.pushError + '）' : '') +
            (commit.message ? ' · ' + commit.message.split('\n', 1)[0] : '')
        }
      }
      commitModal = (
        <div
          style={styles.modalOverlay}
          onClick={() => { if (!commitRunning) setCommitOpen(false) }}
        >
          <div style={styles.modal} onClick={(event: any) => { event.stopPropagation() }}>
            <div style={styles.modalTitle}>提交变更</div>
            <div style={styles.modalBody}>
              <div style={styles.modalStats}>
                <span>{data.files.length + ' 个文件'}</span>
                <span style={{ color: COLORS.add }}>{'+' + additions}</span>
                <span style={{ color: COLORS.del }}>{'-' + deletions}</span>
              </div>
              <textarea
                style={styles.modalInput}
                value={commitMsg}
                disabled={!!commitRunning}
                placeholder="commit 信息（点击「生成 commit 信息」或手动输入）"
                onChange={(event: any) => { setCommitMsg(event.target.value) }}
              />
              {statusLine ? <div style={styles.modalStatus}>{statusLine}</div> : null}
            </div>
            <div style={styles.modalFooter}>
              <button
                style={styles.reviewButton}
                disabled={!!commitRunning}
                title="根据当前变更自动生成 commit 信息"
                onClick={startCommitMsg}
              >
                {commitMode === 'message' && commitRunning ? '生成中…' : '生成 commit 信息'}
              </button>
              <button
                style={styles.reviewButton}
                disabled={!!commitRunning}
                onClick={() => { startCommit(false) }}
              >
                提交
              </button>
              <button
                style={styles.reviewButton}
                disabled={!!commitRunning}
                onClick={() => { startCommit(true) }}
              >
                提交并推送
              </button>
            </div>
          </div>
        </div>
      )
    }
  }

  return (
    <div style={styles.root}>
      {header}
      {reviewSection}
      {data && error ? <div style={styles.syncNote}>{'同步失败，稍后自动重试：' + error}</div> : null}
      {content}
      {commitBar}
      {commitModal}
    </div>
  )
}
