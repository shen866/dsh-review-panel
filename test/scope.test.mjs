import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveScope } from '../dist/tool/scope.js'

const defaults = { defaultScope: 'working-tree' }

test('defaults to the configured scope', () => {
  assert.deepEqual(resolveScope({}, defaults), { scope: 'working-tree', ref: null, baseBranch: null })
})

test('rejects an unknown scope', () => {
  assert.throws(() => resolveScope({ scope: 'everything' }, defaults), /unknown scope/)
})

test('since-ref requires ref', () => {
  assert.throws(() => resolveScope({ scope: 'since-ref' }, defaults), /`ref` is required/)
  assert.deepEqual(resolveScope({ scope: 'since-ref', ref: 'abc123' }, defaults), {
    scope: 'since-ref',
    ref: 'abc123',
    baseBranch: null,
  })
})

test('branch keeps an explicit base branch', () => {
  assert.deepEqual(resolveScope({ scope: 'branch', baseBranch: 'develop' }, defaults), {
    scope: 'branch',
    ref: null,
    baseBranch: 'develop',
  })
})
