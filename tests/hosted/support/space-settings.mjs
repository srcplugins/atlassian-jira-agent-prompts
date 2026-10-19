import { installation } from '@srcplugins/atlassian-forge-test-framework/jira';
import { activeTarget } from '@srcplugins/atlassian-forge-test-framework/core';
import { checkSpace } from './team-managed.mjs';

/** The app's space settings page: it calls `setup` on load and renders Space configuration. */
export async function spaceSettings(page, key) {
  const t = installation('agent-prompts');
  await page.goto(
    `${activeTarget().site}/jira/software/projects/${key}/settings/apps/${t.appId}/${t.environmentId}`,
    { waitUntil: 'domcontentloaded' },
  );
}

/**
 * The space's health as Check selected reads it on its settings page; `state.data.type` is the
 * configured prompt work type. The page's `setup` reply carries only the space.
 */
export async function spaceHealth(page, project) {
  await spaceSettings(page, project.key);
  return checkSpace(page, installation('agent-prompts'), project.key, project.id);
}

/**
 * Space settings must be refused to a non-administrator. Jira itself answers the settings URL
 * with its not-found page before the app loads; if a future Jira renders the app instead, the
 * app's own check must refuse. The app's check is proven separately by the access runner.
 */
export async function expectSpaceSettingsRefused(page, expect) {
  const t = installation('agent-prompts');
  const app = page.frameLocator(`iframe[src*="${t.appId}"][src*="${t.environmentId}"]`);
  const appDenied = app.getByText('This needs the Jira permission Administer Jira.', {
    exact: true,
  });
  const jiraDenied = page.getByRole('heading', {
    name: /can.t find the page|access|permission/i,
  });
  // The app's text is inside its iframe and Jira's heading is on the host page; a locator `or`
  // cannot span frames, so poll both.
  await expect
    .poll(async () => (await appDenied.isVisible()) || (await jiraDenied.first().isVisible()), {
      timeout: 60000,
    })
    .toBe(true);
  if (await jiraDenied.first().isVisible()) {
    expect(new URL(page.url()).pathname).not.toContain('/settings/apps/');
    await expect(page.locator(`iframe[src*="${t.appId}"]`)).toHaveCount(0);
  }
  await expect(
    app
      .getByRole('button', { name: 'Configure selected', exact: true })
      .and(app.locator(':enabled')),
  ).toHaveCount(0);
}
