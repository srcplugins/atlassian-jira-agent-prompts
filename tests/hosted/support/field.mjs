import { installation } from '@srcplugins/atlassian-forge-test-framework/jira';

/**
 * The Agent Prompts field of one installation. A site with both a development and a production
 * installation has one field per environment, with the same name, so match the app and the
 * environment exactly and require one. `get` reads a Jira REST path (`owned.api`, a `client`).
 */
export async function agentPromptsField(get, t = installation('agent-prompts')) {
  const matches = (await get('/field')).filter((f) =>
    String(f.schema?.custom ?? '').includes(`/${t.appId}/${t.environmentId}/`),
  );
  if (matches.length !== 1)
    throw Error(`Expected one Agent Prompts field for this installation, found ${matches.length}`);
  return matches[0];
}

/**
 * The field's read view on a work item, inside Jira's own container for that field ID, so another
 * installation's field of the same name on the same work item never matches.
 */
export function fieldReadView(page, fieldId) {
  return page
    .getByTestId(`issue.views.field.select.common.select-inline-edit.${fieldId}`)
    .locator('[data-component-selector="jira-issue-view-select-inline-edit-read-view-container"]');
}
