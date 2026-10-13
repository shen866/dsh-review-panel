import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { FILE_STATUSES, REVIEW_SCOPES, type ChangeSet } from '../service/index.js'

import type { Config } from './config.js'
import { resolveScope } from './scope.js'

export function createCodeReviewTool(ctx: Context, config: Config) {
  return defineTool({
    name: 'code_review',
    description:
      'Collect code changes so you can review them. Call this when the user asks for a code review. ' +
      'Pick `scope` by intent: "working-tree" for uncommitted changes, "since-ref" for everything ' +
      'after a given commit up to HEAD, "branch" for the full branch against its base branch. ' +
      'Returns the changed files and the unified diff; review the returned patch and report findings.',

    parameters: {
      scope: {
        type: 'string',
        enum: REVIEW_SCOPES,
        description: 'Review scope. Defaults to the configured defaultScope.',
      },
      ref: {
        type: 'string',
        description: 'Base commit (sha / tag) for scope "since-ref"; the diff is `ref..HEAD`.',
      },
      baseBranch: {
        type: 'string',
        description: 'Base branch for scope "branch"; the diff is `baseBranch...HEAD`. Defaults to the review panel config.',
      },
      cwd: {
        type: 'string',
        description: 'Repository root. Defaults to the current working directory.',
      },
    },

    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', enum: REVIEW_SCOPES, required: true },
          cwd: { type: 'string', required: true },
          ref: { type: 'json', required: true },
          baseBranch: { type: 'json', required: true },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                status: { type: 'string', enum: FILE_STATUSES, required: true },
                additions: { type: 'number', required: true },
                deletions: { type: 'number', required: true },
              },
            },
            required: true,
          },
          patch: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `${value.files.length} file(s) changed (scope: ${value.scope})` +
            (value.truncated ? ' — diff truncated' : '') +
            `\n\n${value.patch || '(no changes)'}`,
        },
      ],
    },

    // Pure read: never touches parent-owned state.
    isConcurrencySafe: () => true,

    async execute(args, exec: ToolRunContext): Promise<ChangeSet> {
      // `exec.signal` is a REQUIRED AbortSignal: thread it into the git subprocesses.
      if (exec.signal.aborted) throw new Error('code_review: aborted before start')
      const resolved = resolveScope(args, config)
      return ctx.reviewPanel.collect({
        cwd: args.cwd ?? process.cwd(),
        scope: resolved.scope,
        ref: resolved.ref,
        baseBranch: resolved.baseBranch,
        signal: exec.signal,
      })
    },
  })
}
