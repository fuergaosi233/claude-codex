import assert from 'node:assert/strict'
import test from 'node:test'
import { CronJobs, nextCronFire, RECURRING_MAX_AGE_MS } from '../src/cron-jobs.mjs'

const HOUR_MS = 60 * 60 * 1000
// Saturday, 17 October 2026, 10:05 local time.
const saturday = new Date(2026, 9, 17, 10, 5).getTime()

function local(...parts: [number, number, number, number, number]): number {
  return new Date(...parts).getTime()
}

test('nextCronFire finds the next local time a 5-field expression matches', () => {
  assert.equal(nextCronFire('23 */2 * * *', saturday), local(2026, 9, 17, 10, 23))
  assert.equal(nextCronFire('23 */2 * * *', local(2026, 9, 17, 10, 23)), local(2026, 9, 17, 12, 23))
  assert.equal(nextCronFire('0 9 * * 1-5', saturday), local(2026, 9, 19, 9, 0))
  assert.equal(nextCronFire('0 9 * * 7', saturday), local(2026, 9, 18, 9, 0))
  assert.equal(nextCronFire('15,45 8-10/2 * * *', saturday), local(2026, 9, 17, 10, 15))
  assert.equal(nextCronFire('30 14 28 2 *', saturday), local(2027, 1, 28, 14, 30))
  assert.equal(nextCronFire('0 0 29 2 *', saturday), local(2028, 1, 29, 0, 0))
  // Day of month or day of week when both are restricted, as in cron.
  assert.equal(nextCronFire('0 0 1 * *', saturday), local(2026, 10, 1, 0, 0))
  assert.equal(nextCronFire('0 0 1 * 0', saturday), local(2026, 9, 18, 0, 0))
})

test('nextCronFire gives up on expressions it does not understand', () => {
  for (const expr of ['', '* * *', '61 * * * *', '0 9 * * MON', '*/0 * * * *', '5-1 * * * *']) {
    assert.equal(nextCronFire(expr, saturday), null, expr)
  }
})

function createCron(
  toolUseId: string,
  input: Record<string, unknown>,
  result: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown>[] {
  return [
    {
      type: 'assistant',
      ...extra,
      message: { content: [{ type: 'tool_use', id: toolUseId, name: 'CronCreate', input }] },
    },
    {
      type: 'user',
      ...extra,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: 'Scheduled',
            ...(result ? {} : { is_error: true }),
          },
        ],
      },
      ...(result ? { tool_use_result: result } : {}),
    },
  ]
}

test('CronJobs holds a recurring job until the CLI retires it, and drops deleted ones', () => {
  const jobs = new CronJobs()
  for (const message of createCron(
    'use-1',
    { cron: '23 */2 * * *', prompt: 'check', recurring: true },
    { id: 'job-1', recurring: true, durable: false },
  ))
    jobs.observe(message, saturday)
  assert.equal(jobs.until(saturday), saturday + RECURRING_MAX_AGE_MS + HOUR_MS)
  assert.equal(jobs.until(saturday + RECURRING_MAX_AGE_MS + HOUR_MS), null)

  for (const message of createCron(
    'use-2',
    { cron: '23 */2 * * *', prompt: 'check' },
    { id: 'job-2', recurring: true, durable: false },
  ))
    jobs.observe(message, saturday)
  jobs.observe({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'use-3', name: 'CronDelete', input: { id: 'job-2' } }],
    },
  })
  assert.equal(jobs.until(saturday), null)
})

test('CronJobs holds a one-shot job until it fires and ignores durable or failed ones', () => {
  const jobs = new CronJobs()
  for (const message of [
    ...createCron('durable', { cron: '0 9 * * *', durable: true }, { id: 'd', durable: true }),
    ...createCron('failed', { cron: '0 9 * * *' }, null),
  ])
    jobs.observe(message, saturday)
  assert.equal(jobs.until(saturday), null)

  for (const message of createCron(
    'once',
    { cron: '30 14 18 10 *', prompt: 'remind', recurring: false },
    { id: 'once', recurring: false, durable: false },
  ))
    jobs.observe(message, saturday)
  assert.equal(jobs.until(saturday), local(2026, 9, 18, 14, 30) + HOUR_MS)
})

test('CronJobs replays a transcript up to the message a resume stops at', () => {
  const now = Date.now()
  const hourAgo = now - HOUR_MS
  const line = (message: Record<string, unknown>) => JSON.stringify(message)
  const created = (toolUseId: string, jobId: string, timestamp: number) =>
    createCron(
      toolUseId,
      { cron: '23 */2 * * *', recurring: true },
      { id: jobId, humanSchedule: 'Every 2 hours at :23', recurring: true, durable: false },
      { timestamp: new Date(timestamp).toISOString() },
    ).map((message, index) => line({ ...message, uuid: `${toolUseId}-${index}` }))
  const transcript = [
    line({ type: 'user', uuid: 'u0', message: { content: 'schedule a check' } }),
    ...created('stale', 'old-job', now - RECURRING_MAX_AGE_MS - 2 * HOUR_MS),
    ...created('live', 'live-job', hourAgo),
    line({ type: 'assistant', uuid: 'rewind-point', message: { content: [] } }),
    ...created('later', 'later-job', now),
  ].join('\n')

  const resumed = new CronJobs()
  resumed.scanTranscript(transcript)
  assert.equal(resumed.until(now), now + RECURRING_MAX_AGE_MS + HOUR_MS)

  const rewound = new CronJobs()
  rewound.scanTranscript(transcript, 'rewind-point')
  assert.equal(rewound.until(now), hourAgo + RECURRING_MAX_AGE_MS + HOUR_MS)

  const none = new CronJobs()
  none.scanTranscript(transcript.replaceAll('CronCreate', 'Bash'))
  assert.equal(none.until(now), null)
})
