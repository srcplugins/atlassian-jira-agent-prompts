// Production smoke for Agent Prompts. Publish runs these checks through config/production-smoke.mjs
// right after the production deploy, against the production installation on an owned site, so a
// release that breaks the field or the Configure page fails within minutes. Read-only: pages and
// forms open and close unsaved, and the context's `get` only reads.
import { expect } from './support/expect.mjs';
import { agentPromptsField, fieldReadView } from './support/field.mjs';

export const app = 'agent-prompts';

const appFrame = (scope, t) =>
  scope.frameLocator(`iframe[src*="${t.appId}"][src*="${t.environmentId}"]`);
// Jira's flags when an app field fails, and Forge's message for a frame that fails to load.
const errorText =
  /with exceptions|something went wrong|couldn.t load|problem loading|error loading/i;

export const checks = [
  {
    title: 'Configure page renders the deployed build',
    async run({ page, site, target, build }) {
      const url = `${site}/jira/settings/apps/configure/${target.appId}/${target.environmentId}`;
      // Forge upgrades the installation shortly after the deploy; reload until it serves the build.
      // A major version waits for the site administrator's approval and never arrives here.
      await expect(async () => {
        await page.goto(url);
        await expect(page.getByRole('textbox', { name: 'Find a space', exact: true })).toBeEnabled({
          timeout: 60000,
        });
        if (build)
          await expect(page.getByText(`Build ${build}`, { exact: true })).toBeVisible({
            timeout: 5000,
          });
      }).toPass({ timeout: 300000, intervals: [15000] });
    },
  },
  {
    title: 'Field editor loads on a marked work item',
    async run({ page, site, target, issue, get }) {
      const field = await agentPromptsField(get, target);
      await page.goto(`${site}/browse/${issue.key}`);
      const readView = fieldReadView(page, field.id);
      const editor = appFrame(page, target);
      const combo = editor.getByRole('combobox', { name: 'Agent Prompts', exact: true });
      // Jira can drop a click on a freshly loaded work item; opening the editor only reads.
      await expect(async () => {
        if (!(await combo.isVisible()))
          await readView.click({ position: { x: 2, y: 2 }, timeout: 5000 });
        await expect(combo).toBeVisible({ timeout: 5000 });
      }).toPass({ timeout: 40000, intervals: [1000, 3000] });
      // Loaded, not failed: the actions show, and there is no load error to retry.
      await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
      await expect(editor.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
    },
  },
  {
    title: 'Create form leaves the field out, with no error flag',
    async run({ page, site, target, issue }) {
      await page.goto(`${site}/browse/${issue.key}`);
      const dialog = page.getByRole('dialog', { name: /^Create/ });
      await page.getByRole('banner').getByRole('button', { name: 'Create', exact: true }).click();
      await expect(
        dialog.getByRole('button', { name: new RegExp(`^Space: .*\\(${issue.spaceKey}\\)$`) }),
      ).toBeVisible({ timeout: 30000 });
      const opened = Date.now();
      const left = () => Math.max(0, 15000 - (Date.now() - opened));
      const type = dialog.getByRole('button', { name: `Type: ${issue.typeName}`, exact: true });
      if (!(await type.isVisible())) {
        await dialog.getByRole('button', { name: /^Type: / }).click();
        await page.getByRole('menuitem', { name: issue.typeName, exact: true }).click();
      }
      await expect(type).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: 'Summary', exact: true })).toBeVisible({
        timeout: left(),
      });
      // Watch until 15 s after the form opened: the field's display condition keeps it off the
      // form, so neither its label, its frame nor Jira's own label editor ever appears.
      await page.waitForTimeout(Math.max(2000, left()));
      await expect(dialog.getByText(/^Agent Prompts/)).toHaveCount(0);
      await expect(
        dialog.locator(`iframe[src*="${target.appId}"][src*="${target.environmentId}"]`),
      ).toHaveCount(0);
      await expect(dialog.getByText('Select label', { exact: true })).toHaveCount(0);
      await expect(page.getByText(errorText).filter({ visible: true })).toHaveCount(0);
      // Closed unsaved: nothing is created.
      await dialog
        .getByRole('button', { name: /^Close/ })
        .first()
        .click();
      const discard = page.getByRole('button', { name: 'Discard', exact: true });
      if (await discard.isVisible().catch(() => false)) await discard.click();
      await expect(dialog).toBeHidden();
    },
  },
];
