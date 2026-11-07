import assert from 'node:assert/strict'
import test from 'node:test'
import { formatAskUserQuestionAnswers, parseAskUserQuestions } from '../src/native-runtime.mjs'
import { userInputAnswersAsContent } from '../src/server-helpers.mjs'

const input = {
  questions: [
    {
      header: 'OS',
      question: 'Which OS?',
      options: [{ label: 'macOS' }, { label: 'Other' }],
    },
  ],
}
const questions = parseAskUserQuestions(input)

test('AskUserQuestion offers native free text without adding an Other option', () => {
  assert.equal(questions[0]?.isOther, true)
  assert.deepEqual(
    questions[0]?.options?.map((option) => option.label),
    ['macOS', 'Other'],
  )
  assert.equal(parseAskUserQuestions({ questions: [{ question: 'Free text?' }] })[0]?.isOther, true)
})

for (const [label, selected, legacyNotes, expected, notes] of [
  ['literal Other', ['Other'], undefined, 'Other', undefined],
  ['free text', ['user_note: BSD'], undefined, 'BSD', 'BSD'],
  ['Other with note', ['Other', 'user_note: BSD'], undefined, 'BSD', 'BSD'],
  ['native choice with note', ['None of the above', 'user_note: BSD'], undefined, 'BSD', 'BSD'],
  ['multiple selections', ['macOS', 'Other', 'user_note: BSD'], undefined, 'macOS, BSD', 'BSD'],
  ['annotation on selection', ['macOS', 'user_note: laptop'], undefined, 'macOS', 'laptop'],
  ['legacy notes', ['Other'], 'BSD', 'BSD', 'BSD'],
  ['prefer protocol note', ['Other', 'user_note: BSD'], 'old note', 'BSD', 'BSD'],
] as const) {
  test(`AskUserQuestion preserves ${label} for Claude and the answer card`, () => {
    const answers = {
      answers: { q0: { answers: [...selected], ...(legacyNotes ? { notes: legacyNotes } : {}) } },
    }
    const result = JSON.parse(formatAskUserQuestionAnswers(input, questions, answers))
    assert.equal(result.answers['Which OS?'], expected)
    assert.equal(result.annotations?.['Which OS?']?.notes, notes)
    assert.deepEqual(userInputAnswersAsContent(questions, answers), [
      { type: 'inputText', text: `OS: ${expected}` },
    ])
    assert.ok(!JSON.stringify(result).includes('user_note: '))
  })
}
