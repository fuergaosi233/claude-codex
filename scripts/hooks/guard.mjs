#!/usr/bin/env node
// Claude Code hook: enforce project conventions on file edits.
//
// Registered in .claude/settings.json for two events (one script, branches on
// hook_event_name):
//   PreToolUse  (Edit|Write|MultiEdit) -> hard-block edits to build artifacts.
//   PostToolUse (Edit|Write|MultiEdit) -> advise on architecture + file length.
//
// Hook I/O contract: read one JSON object on stdin, optionally print one JSON
// object on stdout. `decision: "block"` rejects the call (PreToolUse) or feeds
// the reason back to Claude (PostToolUse); `additionalContext` is non-blocking
// guidance. Any error exits 0 so a buggy hook never wedges the session.

import { readFileSync, statSync } from 'node:fs'
import { relative, isAbsolute, extname } from 'node:path'

// Soft cap: server.mts is the known outlier (~3.4k lines). Files past this get
// a nudge to split, not a block.
const MAX_SOURCE_LINES = 1000

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

function emit(out) {
  if (out) process.stdout.write(JSON.stringify(out))
  process.exit(0)
}

const input = readStdin()
const event = input.hook_event_name ?? ''
const cwd = input.cwd ?? process.cwd()
const filePath = input.tool_input?.file_path ?? ''
if (!filePath) emit(null)

const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath

// --- PreToolUse: block build artifacts ----------------------------------
if (event === 'PreToolUse') {
  if (/^(dist|generated)\//.test(rel)) {
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Refusing edit to build artifact "${rel}". dist/ is produced by ` +
          `\`npm run build\` and generated/ by \`npm run generate:schema\` — edit the source instead.`,
      },
    })
  }
  emit(null)
}

// --- PostToolUse: architecture + length advisories ----------------------
if (event === 'PostToolUse') {
  const notes = []

  // src/ is TypeScript ESM only (.mts -> .mjs).
  if (/^src\//.test(rel) && extname(rel) !== '.mts' && /\.(ts|js|mjs|cjs|jsx|tsx)$/.test(rel)) {
    notes.push(
      `"${rel}" is under src/ but not a .mts file — this project is .mts ESM only (compiled to dist/*.mjs).`,
    )
  }

  // New Claude backends belong in *-runtime.mts behind the ClaudeRuntime interface.
  if (
    /^src\/.*runtime.*\.mts$/.test(rel) &&
    !/-runtime\.mts$|runtime-(config|factory)\.mts$/.test(rel)
  ) {
    notes.push(
      `Runtime code should live in a \`*-runtime.mts\` file wired through runtime-factory.mts (ClaudeRuntime interface).`,
    )
  }

  // Length + erasable-syntax nudges (read the edited file once).
  try {
    if (extname(rel) === '.mts') {
      const source = readFileSync(filePath, 'utf8')

      const lines = source.split('\n').length
      if (lines > MAX_SOURCE_LINES) {
        notes.push(
          `"${rel}" is ${lines} lines (> ${MAX_SOURCE_LINES}). Consider splitting it into focused modules.`,
        )
      }

      // tsconfig is erasableSyntaxOnly: no enum / namespace / constructor
      // parameter properties (they have runtime semantics and break tsx /
      // Node native type stripping). tsc enforces it; nudge early here too.
      if (/\bconstructor\s*\([^)]*\b(private|public|protected|readonly)\b/.test(source)) {
        notes.push(
          `"${rel}" looks like it uses a constructor parameter property — not erasable. Declare the field and assign in the body instead.`,
        )
      }
      if (/^\s*(export\s+)?(const\s+)?enum\s/m.test(source) || /^\s*namespace\s/m.test(source)) {
        notes.push(
          `"${rel}" uses enum/namespace — not erasable syntax. Use unions/objects or modules.`,
        )
      }
    }
  } catch {
    // file may have been removed; ignore.
  }

  if (notes.length) {
    emit({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'Project conventions:\n- ' + notes.join('\n- '),
      },
    })
  }
  emit(null)
}

emit(null)
