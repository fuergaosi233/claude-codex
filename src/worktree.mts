import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { adapterHome, stableHash } from './util.mjs'

const labelHashLength = 16
const labelPrefixLength = 48

export interface WorktreeResult {
  cwd: string
  created: boolean
}

export function maybeCreateThreadWorktree(threadId: string, cwd: string): WorktreeResult {
  if (process.env.CLAUDE_CODEX_AUTO_WORKTREE !== '1') {
    return { cwd, created: false }
  }
  const root = resolve(process.env.CLAUDE_CODEX_WORKTREE_ROOT || join(adapterHome(), 'worktrees'))
  mkdirSync(root, { recursive: true })
  const label = worktreeLabel(threadId)
  const worktreePath = join(root, label)
  if (isExistingWorktree(worktreePath)) return { cwd: worktreePath, created: false }
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    execFileSync('git', ['worktree', 'add', '-b', `claude-codex/${label}`, worktreePath, 'HEAD'], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    return { cwd: worktreePath, created: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `[claude-codex-adapter] failed to create worktree for ${threadId}: ${message}\n`,
    )
    return { cwd, created: false }
  }
}

export function worktreeLabel(threadId: string): string {
  const readable = threadId
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, labelPrefixLength)
  const prefix = readable.length > 0 ? readable : 'thread'
  return `${prefix}-${stableHash(threadId).slice(0, labelHashLength)}`
}

function isExistingWorktree(path: string): boolean {
  try {
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: path,
      encoding: 'utf8',
    }).trim()
    return realpathSync(topLevel) === realpathSync(path)
  } catch (error) {
    if (error instanceof Error) return false
    throw error
  }
}
