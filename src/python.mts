import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export function resolvePythonCommand(): string {
  const candidates = [
    process.env.CLAUDE_CODEX_PYTHON,
    resolve('.venv/bin/python'),
    'python3.12',
    'python3.11',
    'python3.10',
    'python3',
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue
    const result = spawnSync(candidate, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'], {
      encoding: 'utf8',
    })
    if (result.status === 0) return candidate
  }
  return process.env.CLAUDE_CODEX_PYTHON || 'python3'
}
