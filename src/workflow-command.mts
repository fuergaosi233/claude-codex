const WORKFLOWS_COMMAND = /^\s*\/workflows(?=$|\s)([\s\S]*)$/

export type WorkflowCommand =
  | { readonly type: 'list' }
  | { readonly type: 'run'; readonly prompt: string }

export function parseWorkflowCommand(prompt: string): WorkflowCommand | null {
  const match = prompt.match(WORKFLOWS_COMMAND)
  if (!match) return null
  const task = (match[1] ?? '').trim()
  // `/workflows list` asks for the list, not for a workflow about "list".
  return task && !/^list$/i.test(task) ? { type: 'run', prompt: task } : { type: 'list' }
}

export function workflowRuntimePrompt(prompt: string): string {
  const command = parseWorkflowCommand(prompt)
  if (command?.type !== 'run') return prompt
  return [
    `ultracode: ${command.prompt}`,
    '',
    'Keep the launched workflow attached to this turn: wait for every workflow task to finish before returning the final response.',
  ].join('\n')
}
