import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { codexHome } from './util.mjs'

// Instructions the Claude CLI does not read on its own, gathered for a thread's
// folder so a Claude thread follows what a Codex thread there would.
//
// AGENTS.md: Codex reads these itself (codex-rs core/src/agents_md.rs) and the
// Claude CLI never does, so they are read the Codex way:
// - the Codex home's AGENTS.override.md, else its AGENTS.md;
// - from the project root (the nearest folder at or above the thread's folder
//   that holds .git, else the thread's folder alone) down to the thread's
//   folder, each folder's AGENTS.override.md, else its AGENTS.md, 32 KiB in all.
// An AGENTS.md a CLAUDE.md already @imports is left to the CLI.
//
// Claude Code's own files, when CLAUDE_CODEX_CLAUDE_CONFIG_DIR names the user's
// Claude Code folder: a CLI started without setting sources, such as one
// behind a launcher passing --setting-sources "", reads no CLAUDE.md, rules or
// skills. They are read the way the CLI would read them:
// - the folder's CLAUDE.md and rules/;
// - in each folder from the filesystem root down to the thread's folder,
//   CLAUDE.md, .claude/CLAUDE.md, .claude/rules/ and CLAUDE.local.md;
// - the files these @import, five levels deep;
// - skills from the folder's skills/ and the project's .claude/skills/.
// Rules scoped to `paths` are listed for Claude to read when it works on
// matching files, as the CLI loads them only then.

const AGENTS_MD_NAMES = ['AGENTS.override.md', 'AGENTS.md'] as const
const PROJECT_DOC_MAX_BYTES = 32 * 1024
const PROJECT_DOC_SEPARATOR = '\n\n--- project-doc ---\n\n'
const MAX_IMPORT_DEPTH = 5
// Bounds what the Claude Code files can add to the prompt.
const CLAUDE_FILES_MAX_BYTES = 256 * 1024
// The App reads a thread several times a turn; the files rarely change.
const CACHE_MS = 3_000

export interface ProjectInstructions {
  // Every file the prompt carries text from, for instructionSources.
  readonly sources: readonly string[]
  // The system prompt sections, or null when no file applies.
  readonly prompt: string | null
}

export interface ProjectSkill {
  readonly name: string
  readonly description: string
  // The skill's SKILL.md; the rest of the skill sits beside it.
  readonly path: string
}

interface InstructionFile {
  readonly path: string
  readonly text: string
}

type ClaudeFileKind = 'user' | 'project' | 'local'

interface ClaudeFile extends InstructionFile {
  readonly kind: ClaudeFileKind
}

interface ScopedRule {
  readonly path: string
  readonly globs: readonly string[]
}

const CLAUDE_FILE_LABELS: Record<ClaudeFileKind, string> = {
  user: "user's private global instructions for all projects",
  project: 'project instructions, checked into the codebase',
  local: "user's private project instructions, not checked in",
}

const cache = new Map<string, { at: number; value: ProjectInstructions }>()

// The user's Claude Code folder the adapter reads on the CLI's behalf, or null
// when the CLI reads its own.
export function bridgedClaudeConfigDir(): string | null {
  const raw = process.env.CLAUDE_CODEX_CLAUDE_CONFIG_DIR?.trim()
  if (!raw) return null
  return resolve(raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw)
}

export function projectInstructions(cwd: string): ProjectInstructions {
  const bridged = bridgedClaudeConfigDir()
  const key = JSON.stringify([cwd, bridged, codexHome(), process.env.CLAUDE_CONFIG_DIR ?? null])
  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const value = readProjectInstructions(cwd, bridged)
  cache.set(key, { at: Date.now(), value })
  return value
}

function readProjectInstructions(cwd: string, bridged: string | null): ProjectInstructions {
  const sections: string[] = []
  const sources: string[] = []
  // Without a bridge the CLI reads its own CLAUDE.md files, so an AGENTS.md
  // they import is already in its context.
  const cliReads = bridged
    ? new Set<string>()
    : new Set(
        claudeCodeFiles(cwd, cliClaudeConfigDir(), new Set()).files.map((file) =>
          realPath(file.path),
        ),
      )
  const agents = agentsMdFiles(cwd, cliReads)
  if (agents.global || agents.project.length > 0) {
    sections.push(agentsMdPrompt(cwd, agents.global, agents.project))
    for (const file of [agents.global, ...agents.project]) if (file) sources.push(file.path)
  }
  if (bridged) {
    const claude = claudeCodeFiles(cwd, bridged, new Set(sources.map(realPath)))
    if (claude.files.length > 0 || claude.scopedRules.length > 0) {
      sections.push(claudeFilesPrompt(claude.files, claude.scopedRules))
      sources.push(...claude.files.map((file) => file.path))
    }
    const skills = projectSkills(cwd, bridged)
    if (skills.length > 0) sections.push(claudeSkillsPrompt(skills))
  }
  return { sources, prompt: sections.length > 0 ? sections.join('\n\n') : null }
}

function cliClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
}

// The nearest folder at or above `cwd` holding .git.
export function gitRoot(cwd: string): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return null
  }
}

// The folders from `cwd`'s project root, its git root or else `cwd` itself,
// down to `cwd`, outermost first.
function projectFolders(cwd: string): string[] {
  return foldersDownTo(gitRoot(cwd) ?? cwd, cwd)
}

// The folders whose .claude/skills the CLI reads: from `cwd` up to its git
// root, short of the home folder, outermost first.
export function claudeSkillFolders(cwd: string): string[] {
  const home = resolve(homedir())
  const root = gitRoot(cwd)
  const folders: string[] = []
  for (let dir = resolve(cwd); dir !== home; dir = dirname(dir)) {
    folders.unshift(dir)
    if (dir === root || dirname(dir) === dir) break
  }
  return folders
}

// `top` and every folder below it down to `cwd`, outermost first; the
// filesystem root down when `top` is null.
function foldersDownTo(top: string | null, cwd: string): string[] {
  const folders: string[] = []
  for (let dir = cwd; ; dir = dirname(dir)) {
    folders.unshift(dir)
    if (dir === top || dirname(dir) === dir) return folders
  }
}

function agentsMdFiles(
  cwd: string,
  skip: ReadonlySet<string>,
): { global: InstructionFile | null; project: InstructionFile[] } {
  const firstOf = (dir: string): InstructionFile | null => {
    const file = firstFile(dir, AGENTS_MD_NAMES)
    return file && !skip.has(realPath(file.path)) ? file : null
  }
  const global = firstOf(codexHome())
  const project: InstructionFile[] = []
  let remaining = PROJECT_DOC_MAX_BYTES
  for (const dir of projectFolders(cwd)) {
    if (remaining <= 0) break
    const file = firstOf(dir)
    if (!file || (global && realPath(file.path) === realPath(global.path))) continue
    const bytes = Buffer.from(file.text)
    project.push(
      bytes.length > remaining
        ? { path: file.path, text: bytes.subarray(0, remaining).toString() }
        : file,
    )
    remaining -= bytes.length
  }
  return { global, project }
}

// Codex's own framing: the global file, then the project's after the
// project-doc marker.
function agentsMdPrompt(
  cwd: string,
  global: InstructionFile | null,
  project: readonly InstructionFile[],
): string {
  const parts: string[] = []
  if (global) parts.push(global.text)
  if (project.length > 0) parts.push(project.map((file) => file.text).join('\n\n'))
  return `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\n${parts.join(PROJECT_DOC_SEPARATOR)}\n</INSTRUCTIONS>`
}

function claudeCodeFiles(
  cwd: string,
  claudeConfig: string,
  seen: Set<string>,
): { files: ClaudeFile[]; scopedRules: ScopedRule[] } {
  const files: ClaudeFile[] = []
  const scopedRules: ScopedRule[] = []
  let budget = CLAUDE_FILES_MAX_BYTES
  const add = (path: string, kind: ClaudeFileKind, depth = 0): void => {
    const key = realPath(path)
    if (seen.has(key) || budget <= 0) return
    const text = readText(path)
    if (text == null) return
    seen.add(key)
    budget -= Buffer.byteLength(text)
    const body = withoutFrontmatter(text).trim()
    if (body) files.push({ path, text: body, kind })
    if (depth >= MAX_IMPORT_DEPTH) return
    for (const imported of importsOf(text, dirname(path))) add(imported, kind, depth + 1)
  }
  const addRules = (dir: string, kind: ClaudeFileKind): void => {
    for (const path of markdownFiles(dir)) {
      const text = readText(path)
      if (text == null) continue
      const globs = ruleGlobs(text)
      if (globs.length === 0) add(path, kind)
      else if (!seen.has(realPath(path))) {
        seen.add(realPath(path))
        scopedRules.push({ path, globs })
      }
    }
  }
  add(join(claudeConfig, 'CLAUDE.md'), 'user')
  addRules(join(claudeConfig, 'rules'), 'user')
  for (const dir of foldersDownTo(null, cwd)) {
    add(join(dir, 'CLAUDE.md'), 'project')
    add(join(dir, '.claude', 'CLAUDE.md'), 'project')
    addRules(join(dir, '.claude', 'rules'), 'project')
    add(join(dir, 'CLAUDE.local.md'), 'local')
  }
  return { files, scopedRules }
}

// Claude Code's own framing for the files it loads into context.
function claudeFilesPrompt(
  files: readonly ClaudeFile[],
  scopedRules: readonly ScopedRule[],
): string {
  const parts = [
    '# Claude Code instructions\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.',
  ]
  for (const file of files)
    parts.push(`Contents of ${file.path} (${CLAUDE_FILE_LABELS[file.kind]}):\n\n${file.text}`)
  if (scopedRules.length > 0)
    parts.push(
      [
        "These rules apply only to some files. Before reading or changing a file matching a rule's patterns, read the rule in full with the Read tool and follow it:",
        ...scopedRules.map((rule) => `- ${rule.path} (${rule.globs.join(', ')})`),
      ].join('\n'),
    )
  return parts.join('\n\n')
}

// The user's and the project's Claude Code skills, user skills first.
export function projectSkills(cwd: string, claudeConfig: string): ProjectSkill[] {
  const skills: ProjectSkill[] = []
  const seen = new Set<string>()
  const dirs = [
    join(claudeConfig, 'skills'),
    ...claudeSkillFolders(cwd).map((dir) => join(dir, '.claude', 'skills')),
  ]
  for (const dir of dirs) {
    for (const skill of skillsIn(dir)) {
      const key = realPath(skill.path)
      if (seen.has(key)) continue
      seen.add(key)
      skills.push(skill)
    }
  }
  return skills
}

// Listed the way the Codex App lists its skills, for Claude to read when a
// request calls for one.
function claudeSkillsPrompt(skills: readonly ProjectSkill[]): string {
  return [
    '# Claude Code skills',
    "These are the user's Claude Code skills. Each is a folder holding a SKILL.md and the files it refers to. When a request matches a skill's description, or the user names or links a skill, read its SKILL.md in full with the Read tool before starting, then follow it, resolving the relative paths it mentions against its folder. Leave a skill unread when no request calls for it.",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description} (file: ${skill.path})`),
  ].join('\n')
}

function skillsIn(dir: string): ProjectSkill[] {
  const skills: ProjectSkill[] = []
  for (const entry of listDir(dir)) {
    const path = join(dir, entry, 'SKILL.md')
    const text = readText(path)
    if (text == null) continue
    const frontmatter = frontmatterFields(text)
    skills.push({
      name: frontmatter.name || entry,
      description: frontmatter.description || '',
      path,
    })
  }
  return skills
}

// The existing files `@path` mentions outside code name.
function importsOf(text: string, base: string): string[] {
  const paths: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const prose = line.replace(/`[^`]*`/g, '')
    for (const match of prose.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)) {
      const raw = (match[1] ?? '').replace(/\\ /g, ' ').replace(/[),.;:]+$/, '')
      if (!raw || raw.includes('@')) continue
      const path = raw.startsWith('~/')
        ? join(homedir(), raw.slice(2))
        : isAbsolute(raw)
          ? raw
          : resolve(base, raw)
      if (isFile(path)) paths.push(path)
    }
  }
  return paths
}

// A rule's `paths` patterns, from a YAML list or a comma-separated value.
function ruleGlobs(text: string): string[] {
  const body = frontmatterBody(text)
  if (body == null) return []
  const lines = body.split('\n')
  const index = lines.findIndex((line) => /^paths\s*:/.test(line))
  if (index < 0) return []
  const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, '')
  const inline = (lines[index] ?? '').replace(/^paths\s*:/, '').trim()
  if (inline)
    return inline
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(unquote)
      .filter(Boolean)
  const globs: string[] = []
  for (const line of lines.slice(index + 1)) {
    const item = /^\s*-\s*(.+)$/.exec(line)
    if (!item) break
    globs.push(unquote(item[1] ?? ''))
  }
  return globs.filter(Boolean)
}

function frontmatterFields(text: string): { name?: string; description?: string } {
  const body = frontmatterBody(text)
  if (body == null) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of body.split('\n')) {
    const match = /^(name|description)\s*:\s*(.+?)\s*$/.exec(line)
    if (!match) continue
    const value = (match[2] ?? '').replace(/^["']|["']$/g, '')
    if (match[1] === 'name') out.name = value
    else out.description = value
  }
  return out
}

export function frontmatterBody(text: string): string | null {
  if (!/^---\r?\n/.test(text)) return null
  const end = text.indexOf('\n---', 3)
  return end < 0 ? null : text.slice(text.indexOf('\n') + 1, end)
}

export function withoutFrontmatter(text: string): string {
  if (frontmatterBody(text) == null) return text
  const end = text.indexOf('\n---', 3)
  const next = text.indexOf('\n', end + 4)
  return next < 0 ? '' : text.slice(next + 1)
}

export function markdownFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of listDir(dir)) {
    const path = join(dir, entry)
    if (isDirectory(path)) files.push(...markdownFiles(path))
    else if (entry.endsWith('.md')) files.push(path)
  }
  return files
}

function firstFile(dir: string, names: readonly string[]): InstructionFile | null {
  for (const name of names) {
    const path = join(dir, name)
    const text = readText(path)
    if (text?.trim()) return { path, text }
  }
  return null
}

export function readText(path: string): string | null {
  try {
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}
