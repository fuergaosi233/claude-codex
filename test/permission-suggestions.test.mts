import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appliedPermissionUpdates,
  bashRulePrefix,
  mcpToolAllowRule,
  savedAllowRules,
  savedCommandPrefix,
  sessionApproval,
  sessionPermissionUpdates,
} from '../src/permission-suggestions.mjs'
import type { ClaudePermissionUpdate } from '../src/types.mjs'

const bash = (ruleContent: string, destination = 'localSettings'): ClaudePermissionUpdate => ({
  type: 'addRules',
  rules: [{ toolName: 'Bash', ruleContent }],
  behavior: 'allow',
  destination,
})

test('a Bash rule gives the command prefix "Allow similar commands" shows', () => {
  assert.deepEqual(bashRulePrefix('npm test *'), ['npm', 'test'])
  assert.deepEqual(bashRulePrefix('npm test:*'), ['npm', 'test'])
  assert.deepEqual(bashRulePrefix('  git   status  '), ['git', 'status'])
  // An exact command: all its words, which covers less than the card says.
  assert.deepEqual(bashRulePrefix('npm run build --watch'), ['npm', 'run', 'build', '--watch'])
  // Nothing the App could show as a prefix.
  for (const content of ['*', ':*', '', 'git * main', 'rm -rf *.tmp *', 'echo a\necho b'])
    assert.equal(bashRulePrefix(content), null, JSON.stringify(content))
})

test('the rules Claude offers to save go to the local settings, as one change', () => {
  assert.deepEqual(savedAllowRules([bash('npm test *', 'userSettings')]), bash('npm test *'))
  assert.deepEqual(
    savedAllowRules([
      bash('npm test *', 'projectSettings'),
      {
        type: 'addRules',
        rules: [{ toolName: 'Read' }],
        behavior: 'allow',
        destination: 'session',
      },
      { ...bash('rm *'), behavior: 'deny' },
      { type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' },
      { type: 'addDirectories', directories: ['/repo'], destination: 'localSettings' },
      bash('npm run lint'),
    ]),
    {
      type: 'addRules',
      rules: [
        { toolName: 'Bash', ruleContent: 'npm test *' },
        { toolName: 'Bash', ruleContent: 'npm run lint' },
      ],
      behavior: 'allow',
      destination: 'localSettings',
    },
  )
  assert.equal(savedAllowRules([bash('npm test *', 'session')]), null)
  assert.equal(savedAllowRules(undefined), null)

  // One Bash rule shows as a prefix; several (a compound command line) or
  // another tool's rule do not.
  assert.deepEqual(savedCommandPrefix(savedAllowRules([bash('npm test:*')])), ['npm', 'test'])
  assert.equal(savedCommandPrefix(savedAllowRules([bash('npm test *'), bash('git push')])), null)
  assert.equal(
    savedCommandPrefix(
      savedAllowRules([
        {
          type: 'addRules',
          rules: [{ toolName: 'WebFetch' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ]),
    ),
    null,
  )
  assert.equal(savedCommandPrefix(null), null)
})

test('"for this session" adds the session rules and folders, no mode', () => {
  const rule: ClaudePermissionUpdate = {
    type: 'addRules',
    rules: [{ toolName: 'Read', ruleContent: '//repo/docs/**' }],
    behavior: 'allow',
    destination: 'session',
  }
  const folder = { type: 'addDirectories', directories: ['/repo/docs'], destination: 'session' }
  const suggestions = [
    rule,
    folder,
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    bash('npm test *'),
    { ...rule, behavior: 'deny' },
  ]
  assert.deepEqual(sessionPermissionUpdates(suggestions), [rule, folder])
  assert.deepEqual(sessionApproval(suggestions), {
    decision: 'acceptForSession',
    updatedPermissions: [rule, folder],
  })
  assert.deepEqual(sessionApproval([bash('npm test *')]), { decision: 'acceptForSession' })
})

test('an MCP tool rule names the whole server and the tool', () => {
  assert.deepEqual(mcpToolAllowRule('mcp__git__status'), {
    type: 'addRules',
    rules: [{ toolName: 'mcp__git__status' }],
    behavior: 'allow',
    destination: 'localSettings',
  })
})

test('Claude Code applies changes to the local settings and the session only', () => {
  const folder = { type: 'addDirectories', directories: ['/repo'], destination: 'session' }
  assert.deepEqual(
    appliedPermissionUpdates([
      bash('npm test *'),
      bash('npm test *', 'userSettings'),
      bash('npm test *', 'projectSettings'),
      bash('npm test *', 'cliArg'),
      folder,
    ]),
    [bash('npm test *'), folder],
  )
  assert.deepEqual(appliedPermissionUpdates(undefined), [])
})
