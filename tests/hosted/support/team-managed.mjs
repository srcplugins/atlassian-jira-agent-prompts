// The team-managed space's steps shared by AP-12 and the Rovo runner.
import { activeTarget } from '@srcplugins/atlassian-forge-test-framework/core';
import { observeAction } from '@srcplugins/atlassian-forge-test-framework/jira';
import { expect } from './expect.mjs';

/**
 * Jira's own configuration of a space, read independently of the app: its work types and each
 * type's create fields. Setting up a team-managed space never changes it.
 */
export async function jiraConfiguration(api, projectId) {
  const space = await api(`/project/${projectId}`);
  const layouts = {};
  for (const type of space.issueTypes) {
    const meta = await api(`/issue/createmeta/${projectId}/issuetypes/${type.id}?maxResults=200`);
    layouts[type.name] = meta.fields.map((f) => f.fieldId).sort();
  }
  return { types: space.issueTypes.map((type) => [type.id, type.name]), layouts };
}

/** Opens the global configuration page and returns the space inventory it loads. */
export function globalConfiguration(page, t) {
  return observeAction(
    page,
    'settings-projects',
    () =>
      page.goto(
        `${activeTarget().site}/jira/settings/apps/configure/${t.appId}/${t.environmentId}`,
      ),
    t,
  );
}

/**
 * On the configuration page, finds and selects one space and returns its checked health. A space
 * of the kind the page is not showing is reached through the search's link to the other tab.
 */
export async function checkSpace(page, t, key, projectId) {
  const search = page.getByRole('textbox', { name: 'Find a space', exact: true });
  await expect(search).toBeEnabled({ timeout: 60000 });
  await search.fill(key);
  const box = page.getByRole('checkbox', { name: `Select ${key}`, exact: true });
  const other = page.getByRole('button', { name: /^Show (company|team)-managed$/ });
  await expect(box.or(other).first()).toBeVisible();
  if (!(await box.isVisible())) await other.click();
  await box.click();
  return observeAction(
    page,
    'settings-health',
    () => page.getByRole('button', { name: 'Check selected', exact: true }).click(),
    t,
    projectId,
  );
}

/** Opens a listed space's details. */
export async function details(page, key) {
  await page
    .getByRole('row')
    .filter({ has: page.getByRole('checkbox', { name: `Select ${key}`, exact: true }) })
    .getByRole('button', { name: 'View details', exact: true })
    .click();
}

/**
 * From a team-managed space's open details, sets its own prompt work type in the team-managed
 * dialog: one screen, then a confirmation that names that type and no Jira change before Save.
 */
export async function configureOwnType(page, t, { key, type, name }) {
  await page.getByRole('button', { name: 'Configure space', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: /^Configure 1 team-managed space$/ }),
  ).toBeVisible();
  const choice = page.getByRole('combobox', {
    name: new RegExp(`^Prompt work type for ${key} — `),
  });
  await expect(choice).toBeEnabled({ timeout: 60000 });
  await choice.click();
  await page.getByRole('option', { name, exact: true }).click();
  const plan = await observeAction(
    page,
    'configuration-preview',
    () => page.getByRole('button', { name: 'Review changes', exact: true }).click(),
    t,
  );
  expect(plan.teamManaged).toBe(true);
  expect(plan.type).toBe(type);
  await expect(page.getByRole('heading', { name: 'Confirm changes', exact: true })).toBeVisible();
  await expect(page.getByText(`Prompt type: ${name}`, { exact: true })).toBeVisible();
  await expect(page.getByText(/Nothing in these spaces’ Jira settings changes/)).toBeVisible();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
}

/** Removes a listed team-managed space's setup through its details and the removal confirmation. */
export async function removeSetup(page, t, key) {
  await details(page, key);
  await page.getByRole('button', { name: 'Reconfigure space', exact: true }).click();
  const remove = page.getByRole('button', { name: 'Remove setup…', exact: true });
  await expect(remove).toBeEnabled({ timeout: 60000 });
  const plan = await observeAction(page, 'configuration-preview', () => remove.click(), t);
  expect(plan.unlink).toBe(true);
  await expect(page.getByRole('heading', { name: 'Remove setup?', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove setup', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
}
