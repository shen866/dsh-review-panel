import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseFileDiff,
  parsePatchSections,
  placeFindings,
  locateLine,
  severityOf,
} from '../dist/shared/diff.js'

function finding(overrides) {
  return {
    severity: 'normal',
    path: 'src/a.ts',
    side: 'new',
    line: null,
    quote: null,
    title: '问题',
    detail: 'detail',
    ...overrides,
  }
}

const SECTION = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
-line2
+line2 modified
+line3
 line4
`

test('hunk header: single hunk with counts advances both line counters', () => {
  const lines = parseFileDiff(SECTION)
  assert.deepEqual(lines.map((line) => line.kind), ['hunk', 'ctx', 'del', 'add', 'add', 'ctx'])
  assert.deepEqual(lines.map((line) => line.oldLine), [null, 1, 2, null, null, 3])
  assert.deepEqual(lines.map((line) => line.newLine), [null, 1, null, 2, 3, 4])
  assert.equal(lines[1].content, 'line1')
  assert.equal(lines[3].content, 'line2 modified')
  assert.equal(lines[0].content, '@@ -1,3 +1,4 @@')
})

test('hunk header: omitted counts (@@ -1 +1 @@) parse', () => {
  const lines = parseFileDiff('@@ -1 +1 @@\n-a\n+b\n')
  assert.deepEqual(lines.map((line) => line.oldLine), [null, 1, null])
  assert.deepEqual(lines.map((line) => line.newLine), [null, null, 1])
})

test('hunk header: multiple hunks restart the counters', () => {
  const section = `${SECTION}@@ -10,2 +11,1 @@\n later1\n-later2\n`
  const lines = parseFileDiff(section)
  const secondHunk = lines.findIndex((line, index) => index > 0 && line.kind === 'hunk')
  assert.notEqual(secondHunk, -1)
  assert.deepEqual(lines[secondHunk].content, '@@ -10,2 +11,1 @@')
  assert.deepEqual(lines[secondHunk + 1].oldLine, 10)
  assert.deepEqual(lines[secondHunk + 1].newLine, 11)
  assert.deepEqual(lines[secondHunk + 2].oldLine, 11)
  assert.equal(lines[secondHunk + 2].newLine, null)
})

test('hunk header: new file (--- /dev/null) and deleted file (+++ /dev/null)', () => {
  const added = parseFileDiff('diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+foo\n+bar\n')
  assert.deepEqual(added.map((line) => [line.kind, line.newLine]), [['hunk', null], ['add', 1], ['add', 2]])
  const deleted = parseFileDiff('diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-foo\n-bar\n')
  assert.deepEqual(deleted.map((line) => [line.kind, line.oldLine]), [['hunk', null], ['del', 1], ['del', 2]])
})

test('line numbers: ctx advances both, add advances new only, del advances old only', () => {
  const lines = parseFileDiff('@@ -5,3 +5,3 @@\n keep\n-gone\n+added\n tail\n')
  assert.deepEqual(lines.map((line) => [line.oldLine, line.newLine]), [
    [null, null],
    [5, 5],
    [6, null],
    [null, 6],
    [7, 7],
  ])
})

test('line numbers: "\\ No newline" marker is a numberless ctx line', () => {
  const lines = parseFileDiff('@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n')
  const marker = lines[2]
  assert.equal(marker.kind, 'ctx')
  assert.equal(marker.oldLine, null)
  assert.equal(marker.newLine, null)
})

test('anchoring: exact quote hit returns the line index and display number', () => {
  const lines = parseFileDiff(SECTION)
  const hit = locateLine(lines, finding({ quote: 'line2 modified', side: 'new', line: 2 }))
  assert.deepEqual(hit, { index: 3, lineNo: 2 })
})

test('anchoring: trimmed fallback matches a loosely-quoted line', () => {
  const lines = parseFileDiff(SECTION)
  const hit = locateLine(lines, finding({ quote: '  line2 modified  ', side: 'new' }))
  assert.equal(hit.index, 3)
})

test('anchoring: side=new never matches a del line, side=old does', () => {
  const lines = parseFileDiff(SECTION)
  assert.equal(locateLine(lines, finding({ quote: 'line2', side: 'new' })), null)
  const oldHit = locateLine(lines, finding({ quote: 'line2', side: 'old' }))
  assert.deepEqual(oldHit, { index: 2, lineNo: 2 })
})

test('anchoring: duplicate quotes disambiguate by advisory line proximity', () => {
  const section = '@@ -1,0 +1,3 @@\n+same\n+mid\n+same\n'
  const lines = parseFileDiff(section)
  const far = locateLine(lines, finding({ quote: 'same', side: 'new', line: 3 }))
  assert.deepEqual(far, { index: 3, lineNo: 3 })
  const near = locateLine(lines, finding({ quote: 'same', side: 'new', line: 1 }))
  assert.deepEqual(near, { index: 1, lineNo: 1 })
})

test('anchoring: a quote that matches nothing lands in the file-level (未锚定) list', () => {
  const sections = parsePatchSections(SECTION)
  const placement = placeFindings([finding({ quote: 'no such line' })], sections)
  assert.deepEqual([...placement.anchored], [0])
  assert.equal(placement.perLine.get('src/a.ts'), undefined)
  assert.equal(placement.fileLevel.get('src/a.ts').length, 1)
  assert.equal(placement.fileLevel.get('src/a.ts')[0].rep.index, 0)
})

test('anchoring: findings for a file outside the diff are dropped from placement', () => {
  const sections = parsePatchSections(SECTION)
  const placement = placeFindings([finding({ path: 'src/other.ts', quote: 'line1' })], sections)
  assert.equal(placement.anchored.size, 0)
  assert.equal(placement.fileLevel.size, 0)
})

test('anchoring: parsePatchSections keys sections by the post-image path', () => {
  const multi = `${SECTION}diff --git a/b.ts b/b.ts\nindex 1..2 100644\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n`
  const sections = parsePatchSections(multi)
  assert.deepEqual(Object.keys(sections).sort(), ['b.ts', 'src/a.ts'])
  assert.ok(sections['src/a.ts'].startsWith('diff --git a/src/a.ts b/src/a.ts'))
})

test('severity: legacy major/minor fold into normal', () => {
  assert.equal(severityOf(finding({ severity: 'major' })), 'normal')
  assert.equal(severityOf(finding({ severity: 'minor' })), 'normal')
  assert.equal(severityOf(finding({ severity: 'critical' })), 'critical')
  assert.equal(severityOf(finding({ severity: 'suggestion' })), 'suggestion')
  assert.equal(severityOf(finding({ severity: 'bogus' })), 'normal')
})
