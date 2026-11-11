/** Jira's built-in work types, in lower case. They already mean something else in Jira, so the app
 * refuses them as a space's prompt type: every work item of the prompt type becomes a prompt. Epic
 * and subtasks are never eligible anyway, and stay listed so this reads as the whole set. A
 * built-in type an administrator renamed can't be recognized by its name, and is accepted. */
const builtIn = new Set([
  'epic',
  'story',
  'task',
  'bug',
  'subtask',
  'sub-task',
  'incident',
  'service request',
  'service request with approvals',
  'change',
  'problem',
  'post-incident review',
  'it help',
  'emailed request',
  'improvement',
  'feature',
  'new feature',
  'idea',
]);
export function builtInType(name: string) {
  return builtIn.has(
    name
      .trim()
      .replace(/^\[system\]\s*/i, '')
      .toLowerCase(),
  );
}
export const builtInRefusal =
  'Choose or create a work type only for prompts, such as Prompt. Jira’s built-in work types like Story or Task are already used for other work.';
export const builtInConfigured =
  'Agent Prompts isn’t set up for this space: its prompt type is one of Jira’s built-in work types. Ask a Jira administrator to choose a dedicated prompt type.';
