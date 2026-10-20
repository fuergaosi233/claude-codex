import assert from 'node:assert/strict'
import test from 'node:test'
import {
  accountUsage,
  dayStreaks,
  hostMethod,
  localDay,
  methodNotFound,
  RpcError,
} from '../src/host-methods.mjs'

test('hostMethod answers only the methods it owns', () => {
  assert.equal(hostMethod('thread/start', {}), undefined)
  assert.deepEqual(hostMethod('app/read', { appIds: ['a', 'a', 'b', 3] }), {
    apps: [],
    missingAppIds: ['a', 'b'],
  })
  assert.deepEqual(hostMethod('plugin/search', { query: 'x' }), { data: [], nextCursor: null })
  assert.deepEqual(hostMethod('environment/status', {}), { status: 'ready' })
  const info = hostMethod('environment/info', {}) as { cwd: string; shell: { path: string } }
  assert.match(info.cwd, /^file:\/\//)
  assert.ok(info.shell.path)
})

test('remote control reports a disabled, stable installation', () => {
  const status = hostMethod('remoteControl/status/read', {}) as Record<string, unknown>
  assert.equal(status.status, 'disabled')
  assert.equal(status.environmentId, null)
  assert.match(
    String(status.installationId),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  )
  assert.deepEqual(hostMethod('remoteControl/disable', {}), status)
  assert.throws(() => hostMethod('remoteControl/enable', {}), /not available with Claude Code/)
  assert.throws(
    () => hostMethod('remoteControl/client/revoke', { clientId: 'c1' }),
    /remote control client not found: c1/,
  )
})

test('passkey verification is unavailable, with the reason the App reads', () => {
  assert.equal(
    (hostMethod('userVerification/status', {}) as Record<string, unknown>).unavailableReason,
    'providerUnavailable',
  )
  for (const method of ['userVerification/enroll', 'userVerification/verify']) {
    assert.throws(
      () => hostMethod(method, {}),
      (error: unknown) =>
        error instanceof RpcError &&
        JSON.stringify(error.data) ===
          JSON.stringify({ type: 'unavailable', reason: 'providerUnavailable' }),
    )
  }
  assert.deepEqual(hostMethod('userVerification/cancel', {}), {})
})

test('a Bedrock account passes the GovCloud check of the App', () => {
  assert.deepEqual(hostMethod('account/bedrock/checkGovCloudRequirements', {}), {
    isGovCloud: false,
    shouldWarn: false,
  })
})

test('an unknown method is a JSON-RPC method-not-found error; others are server errors', () => {
  const missing = methodNotFound('thread/prediction/request')
  assert.ok(missing instanceof RpcError)
  assert.equal(missing.code, -32601)
  assert.equal(missing.message, 'method not found: thread/prediction/request')
  assert.equal(missing.data, undefined)
  assert.equal(new RpcError('failed', { reason: 'x' }).code, -32000)
})

test('dayStreaks counts consecutive days, the current run ending today or yesterday', () => {
  const days = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-04', '2026-10-05']
  assert.deepEqual(dayStreaks(days, '2026-10-05'), { current: 2, longest: 3 })
  assert.deepEqual(dayStreaks(days, '2026-10-06'), { current: 2, longest: 3 })
  assert.deepEqual(dayStreaks(days, '2026-10-07'), { current: 0, longest: 3 })
  assert.deepEqual(dayStreaks([], '2026-10-07'), { current: 0, longest: 0 })
})

test('accountUsage reports turn history, never invented token counts', () => {
  assert.deepEqual(
    accountUsage({ days: ['2026-10-12', '2026-10-13'], longestTurnMs: 1500 }, '2026-10-13'),
    {
      summary: {
        lifetimeTokens: null,
        peakDailyTokens: null,
        longestRunningTurnSec: 2,
        currentStreakDays: 2,
        longestStreakDays: 2,
      },
      dailyUsageBuckets: null,
      threadUsage: null,
    },
  )
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
})
