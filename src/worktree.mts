import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { adapterHome } from './util.mjs'

export interface WorktreeResult {
  cwd: string
  created: boolean
}

export function maybeCreateThreadWorktree(threadId: string, cwd: string): WorktreeResult {
  if (process.env.CLAUDE_CODEX_AUTO_WORKTREE !== '1') {
    return { cwd, created: false }
  }
  const root = process.env.CLAUDE_CODEX_WORKTREE_ROOT || join(adapterHome(), 'worktrees')
  mkdirSync(root, { recursive: true })
  const worktreePath = join(root, threadId)
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    execFileSync(
      'git',
      ['worktree', 'add', '-b', `claude-codex/${threadId.slice(0, 8)}`, worktreePath, 'HEAD'],
      {
        cwd,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    return { cwd: worktreePath, created: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `[claude-codex-adapter] failed to create worktree for ${threadId}: ${message}\n`,
    )
    return { cwd, created: false }
  }
}
