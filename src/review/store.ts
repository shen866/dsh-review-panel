/**
 * File-backed persistence for review records: each repo keeps only its LATEST
 * settled review (done or error) so the panel can restore it after a restart.
 * The whole table lives in a single JSON document (`<dir>/reviews.json`) keyed
 * by the repo's real path; writes go through a temp file + rename so a crash
 * mid-write never corrupts the table. Any I/O or JSON failure degrades to an
 * empty table / `null` — persistence must never break a review.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ReviewFinding, ReviewVerdict } from './findings.js'

/** A settled review run, fully JSON-serializable (no `settled` promise). */
export interface ReviewRecord {
  id: string
  status: 'done' | 'error'
  model: string | null
  text: string | null
  findings: ReviewFinding[] | null
  verdict: ReviewVerdict | null
  error: string | null
  startedAt: number
  finishedAt: number
  /** Repo the review ran against; also the lookup key (realpath-normalized). */
  cwd: string
}

/** Minimal face consumed by the runner / routes / commit flow, faked in tests. */
export interface ReviewStoreLike {
  put(cwd: string, record: ReviewRecord): Promise<void>
  get(cwd: string): Promise<ReviewRecord | null>
  clear(cwd: string): Promise<void>
}

export class ReviewStore implements ReviewStoreLike {
  private readonly file: string
  private chain: Promise<void> = Promise.resolve()

  constructor(dir: string) {
    this.file = join(dir, 'reviews.json')
  }

  /** Stable table key: the repo's real path, falling back to the raw one. */
  private async key(cwd: string): Promise<string> {
    try {
      return await realpath(cwd)
    } catch {
      return cwd
    }
  }

  private async read(): Promise<Record<string, ReviewRecord>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, ReviewRecord>)
        : {}
    } catch {
      return {}
    }
  }

  /** Insert or replace the repo's record, keeping only the latest per repo. */
  async put(cwd: string, record: ReviewRecord): Promise<void> {
    const task = this.chain.then(() => this.write(cwd, record))
    this.chain = task.catch(() => {})
    await task
  }

  private async write(cwd: string, record: ReviewRecord): Promise<void> {
    const table = await this.read()
    table[await this.key(cwd)] = record
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(table))
      await rename(tmp, this.file)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }

  /** The repo's latest record, or null when none was ever persisted. */
  async get(cwd: string): Promise<ReviewRecord | null> {
    const table = await this.read()
    return table[await this.key(cwd)] ?? null
  }

  /** Drop the repo's record; persistence failures degrade to a no-op. */
  async clear(cwd: string): Promise<void> {
    const task = this.chain.then(() => this.remove(cwd)).catch(() => {})
    this.chain = task
    await task
  }

  private async remove(cwd: string): Promise<void> {
    const table = await this.read()
    const key = await this.key(cwd)
    if (!(key in table)) return
    delete table[key]
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(table))
      await rename(tmp, this.file)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }
}
