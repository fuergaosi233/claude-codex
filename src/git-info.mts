import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitInfo } from './types.mjs'

const execFileAsync = promisify(execFile)

// Thread.gitInfo is stored on the thread, so thread/list and thread/read never
// run git. Lookups happen when a thread starts, resumes without one, or ends a
// turn, and are cached per directory so a burst of them costs one lookup.
const GIT_INFO_TTL_MS = 30_000
const GIT_TIMEOUT_MS = 1_000
const MAX_CACHED_DIRECTORIES = 256

const gitInfoCache = new Map<string, { at: number; info: Promise<GitInfo | null> }>()

// The Codex GitInfo of a workspace: HEAD's sha, its branch (null when
// detached) and the origin remote without credentials; null outside a
// repository. `fresh` skips the cache, for when the branch may have moved.
export function gitInfoFor(
  cwd: string,
  options: { fresh?: boolean } = {},
): Promise<GitInfo | null> {
  const now = Date.now()
  const cached = gitInfoCache.get(cwd)
  if (cached && !options.fresh && now - cached.at < GIT_INFO_TTL_MS) return cached.info
  if (!cached && gitInfoCache.size >= MAX_CACHED_DIRECTORIES) {
    for (const [key, entry] of gitInfoCache)
      if (now - entry.at >= GIT_INFO_TTL_MS) gitInfoCache.delete(key)
    if (gitInfoCache.size >= MAX_CACHED_DIRECTORIES) gitInfoCache.clear()
  }
  const info = readGitInfo(cwd)
  gitInfoCache.set(cwd, { at: now, info })
  return info
}

async function readGitInfo(cwd: string): Promise<GitInfo | null> {
  const [sha, branch, origin] = await Promise.all([
    git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']),
    git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']),
    git(cwd, ['remote', 'get-url', 'origin']),
  ])
  const originUrl = origin ? sanitizeGitRemoteUrl(origin) : null
  if (!sha && !branch && !originUrl) return null
  return { sha, branch, originUrl }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    })
    return stdout.trim() || null
  } catch {
    // Outside a repository, on an unborn branch or without an origin.
    return null
  }
}

const REMOTE_HELPER = /^[A-Za-z0-9+.-]+::/

// Codex SanitizedGitUrl: removes the credentials from a Git remote, keeping
// SSH's conventional `git` user, which is no secret. Returns null for text
// that is not a remote, and for a remote-helper command line, which may hold
// secrets anywhere.
export function sanitizeGitRemoteUrl(value: string): string | null {
  const original = value.trim()
  if (!original || hasControlCharacter(original)) return null
  // Remote helpers (`hg::https://...`) wrap another remote: peel them off.
  let address = original
  let helper = REMOTE_HELPER.exec(address)
  while (helper) {
    const nested = address.slice(helper[0].length)
    if (address === original && /\s/.test(nested)) return null
    address = nested
    helper = REMOTE_HELPER.exec(address)
  }
  if (!address) return null
  const helperPrefix = original.slice(0, original.length - address.length)

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(address)
  if (scheme) {
    const rest = address.slice(scheme[0].length)
    const slash = rest.indexOf('/')
    const authority = slash === -1 ? rest : rest.slice(0, slash)
    const path = slash === -1 ? '' : rest.slice(slash)
    const at = authority.lastIndexOf('@')
    const host = authority.slice(at + 1)
    const name = (scheme[1] ?? '').toLowerCase()
    if (!host && name !== 'file') return null
    if (at === -1) return original
    const isSsh = name === 'ssh'
    const userinfo = authority.slice(0, at)
    if (isSsh && userinfo === 'git') return original
    const user = isSsh && userinfo.split(':')[0] === 'git' ? 'git@' : ''
    return `${helperPrefix}${scheme[0]}${user}${host}${path}`
  }

  // SCP-style `user@host:path`: only the user goes, the path stays as it is.
  const slash = address.indexOf('/')
  const head = slash === -1 ? address : address.slice(0, slash)
  const at = head.lastIndexOf('@')
  if (at > 0 && head.indexOf(':', at) !== -1) {
    if (address.slice(0, at) === 'git') return original
    return `${helperPrefix}${address.slice(at + 1)}`
  }
  return original
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

const GIT_INFO_FIELDS = ['sha', 'branch', 'originUrl'] as const

// Applies a Codex thread/metadata/update gitInfo patch: an omitted field stays,
// null clears it and a string replaces it. Throws with Codex's messages.
export function patchGitInfo(current: GitInfo | null, patch: unknown): GitInfo | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new Error('gitInfo must be an object')
  const fields = patch as Record<string, unknown>
  if (GIT_INFO_FIELDS.every((key) => fields[key] === undefined))
    throw new Error('gitInfo must include at least one field')
  const next: GitInfo = {
    sha: current?.sha ?? null,
    branch: current?.branch ?? null,
    originUrl: current?.originUrl ?? null,
  }
  for (const key of GIT_INFO_FIELDS) {
    const value = fields[key]
    if (value === undefined) continue
    if (value === null) {
      next[key] = null
      continue
    }
    if (typeof value !== 'string') throw new Error(`gitInfo.${key} must be a string or null`)
    const trimmed = value.trim()
    if (!trimmed) throw new Error(`gitInfo.${key} must not be empty`)
    if (key === 'originUrl') {
      const originUrl = sanitizeGitRemoteUrl(trimmed)
      if (!originUrl) throw new Error('gitInfo.originUrl must be a valid Git remote')
      next.originUrl = originUrl
    } else {
      next[key] = trimmed
    }
  }
  return next.sha || next.branch || next.originUrl ? next : null
}
