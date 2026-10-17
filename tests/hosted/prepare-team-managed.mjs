import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tokenRequest, client } from '@srcplugins/atlassian-forge-test-framework/jira';
import {
  activeTarget,
  fixtureProject,
  isMarker,
  markers,
  siteFor,
} from '@srcplugins/atlassian-forge-test-framework/core';
import { expect } from './support/expect.mjs';
import { teamManagedFixture } from './support/fixture.mjs';

// Creates once, or verifies, the marked team-managed space the team-managed journey uses, then
// does a space administrator's manual setup in it through Jira's own pages, as the README
// describes: the Agent Prompts field added to the space and placed on the Task layout only, a
// Prompt work type, a Prompt workflow whose work items start in Prompt available, and Prompt
// available hidden on the board. Each step first checks Jira and runs only when it is missing.
// The space is persistent: like the other prepared spaces it is never deleted.
// TEAM_MANAGED_FIXTURE names another configured team-managed space (team-managed-2, …) for
// manual multi-space checks; the journeys use only the first. Each name needs its space key under
// `projects` in dev-platform's catalog/test-fixtures.json, then `forge-test config agent-prompts`
// (or CI's FORGE_TEST_CONFIG); fixtureProject refuses an unlisted name before any request.
assert.equal(process.env.NATIVE_TEAM_MANAGED_PREPARE, '1', 'Explicit fixture preparation required');
const fixture = process.env.TEAM_MANAGED_FIXTURE ?? teamManagedFixture;
assert.match(fixture, /^team-managed(-\d+)?$/, 'Team-managed fixture names are team-managed[-N]');
const target = activeTarget();
assert.equal(target.host, siteFor('primary'), 'The team-managed fixture lives on the primary site');
const key = fixtureProject(fixture);
const marker = markers.browserProject(fixture);
const journal = `${target.directory}/project-${key}.json`;
const request = await tokenRequest();
const api = client(request);
const save = (data) => writeFileSync(journal, JSON.stringify(data), { mode: 0o600 });
let browser;
try {
  const user = await api('/myself');
  mkdirSync(target.directory, { recursive: true });
  let project = await api(`/project/${key}`);
  if (!project) {
    if (existsSync(journal)) throw Error(`Unresolved space creation ${key}; inspect before retry`);
    writeFileSync(journal, JSON.stringify({ key, status: 'creating' }), {
      flag: 'wx',
      mode: 0o600,
    });
    await api('/project', 'POST', {
      key,
      name: markers.browserProjectName(fixture),
      description: marker,
      projectTypeKey: 'software',
      projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-agility-kanban',
      leadAccountId: user.accountId,
      assigneeType: 'UNASSIGNED',
    });
    project = await api(`/project/${key}`);
  }
  assert.ok(
    isMarker(project?.description, marker) &&
      project.key === key &&
      project.style === 'next-gen' &&
      project.projectTypeKey === 'software',
    `Space ownership mismatch ${key}`,
  );
  const old = existsSync(journal) ? JSON.parse(readFileSync(journal, 'utf8')) : {};
  save({ ...old, key, id: project.id, status: 'verified' });

  const field = (await api('/field')).find((f) =>
    String(f.schema?.custom ?? '').endsWith('/native-prompts-field'),
  )?.id;
  assert.ok(field, 'The Agent Prompts field is missing; install the app first');
  const types = async () =>
    (await api(`/issuetype/project?projectId=${project.id}`)).filter(
      (t) => t.scope?.project?.id === project.id,
    );
  const type = async (name) => (await types()).find((t) => t.name === name);
  const createFields = async (id) =>
    (
      (await api(`/issue/createmeta/${project.id}/issuetypes/${id}?maxResults=200`))?.fields ?? []
    ).map((f) => f.fieldId);
  const statuses = async (name) =>
    (await api(`/project/${project.id}/statuses`))
      .find((t) => t.name === name)
      ?.statuses.map((s) => s.name)
      .sort();

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    storageState: target.auth,
    viewport: { width: 1440, height: 1000 },
  });
  assert.equal((await client(context.request)('/myself')).accountId, user.accountId);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const settings = `${target.site}/jira/software/projects/${key}/settings`;

  const task = await type('Task');
  assert.ok(task, 'The space has no Task work type');
  if (!(await createFields(task.id)).includes(field)) {
    await page.goto(`${settings}/fields`);
    const fields = page.getByRole('table');
    await expect(fields.getByRole('row').nth(1)).toBeVisible();
    if (!(await fields.getByRole('row', { name: /^Agent Prompts / }).count())) {
      await page.getByRole('button', { name: 'Add field' }).click();
      const panel = page.getByRole('complementary');
      await panel.getByRole('textbox', { name: 'Search fields' }).fill('Agent Prompts');
      await panel.getByRole('checkbox', { name: /^Agent Prompts field Agent Prompts/ }).check();
      await page.getByRole('button', { name: /^Add 1 field$/ }).click();
      await expect(fields.getByRole('row', { name: /^Agent Prompts / })).toBeVisible();
    }
    await page.goto(`${settings}/issuetypes/${task.id}`);
    await page.getByRole('heading', { name: 'Task', level: 1 }).waitFor();
    await page
      .getByRole('complementary')
      .getByRole('listitem')
      .filter({ hasText: /^Agent Prompts$/ })
      .dragTo(
        page
          .getByRole('main')
          .getByRole('listitem')
          .filter({ hasText: /^Labels/ }),
      );
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(async () => expect(await createFields(task.id)).toContain(field)).toPass();
    console.log('Agent Prompts placed on the Task layout');
  }

  if (!(await type('Prompt'))) {
    await page.goto(`${settings}/issuetypes/${task.id}`);
    await page.getByRole('heading', { name: 'Task', level: 1 }).waitFor();
    const expand = page.getByRole('button', { name: 'Expand sidebar' });
    if (await expand.isVisible()) await expand.click();
    await page
      .getByRole('navigation', { name: 'Sidebar' })
      .getByRole('button', { name: 'Add work type' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Create work type' });
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Prompt');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('heading', { name: 'Prompt', level: 1 }).waitFor();
    console.log('Prompt work type created');
  }
  const prompt = await type('Prompt');
  assert.equal(prompt?.hierarchyLevel, 0, 'Prompt must be a standard work type');

  if (JSON.stringify(await statuses('Prompt')) !== JSON.stringify(['Done', 'Prompt available'])) {
    assert.deepEqual(
      await statuses('Prompt'),
      ['Done', 'In Progress', 'In Review', 'To Do'],
      'The Prompt workflow differs from both the template and the prepared one; inspect it',
    );
    await page.goto(`${settings}/issuetypes/${prompt.id}/workflow`);
    await page.getByRole('button', { name: 'Add status' }).waitFor();
    const text = page.getByRole('radio', { name: 'Text' });
    if (!(await text.isChecked())) await text.check({ force: true });
    const editor = page.getByRole('dialog').first();
    await editor.getByText('To Do', { exact: true }).first().click();
    await page.getByRole('button', { name: 'Replace' }).click();
    const replace = page.getByRole('dialog', { name: 'Replace status' });
    await replace.getByRole('combobox', { name: 'Change to status' }).fill('Prompt available');
    // A new space has no Prompt available status yet: Jira offers to create it, then adds a
    // Status category field to the dialog. Wait for the menu to close before replacing.
    await page
      .getByRole('option', { name: /^(Create 'Prompt available' status|Prompt available)$/ })
      .click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await replace.getByRole('button', { name: 'Replace status' }).click();
    for (const status of ['In Progress', 'In Review']) {
      await editor.getByText(status, { exact: true }).first().click();
      await page.getByRole('button', { name: 'Remove' }).click();
      await expect(editor.getByText(status, { exact: true })).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Update workflow' }).click();
    const copy = page
      .getByRole('dialog')
      .filter({ hasText: 'Save workflow for selected work types' });
    for (const other of (await types()).filter((t) => t.id !== prompt.id))
      await copy.getByRole('button', { name: `${other.name}, remove` }).click();
    await copy.getByRole('button', { name: 'Next' }).click();
    await page
      .getByRole('dialog')
      .filter({ hasText: 'Move work items to new statuses' })
      .getByRole('button', { name: 'Update workflow' })
      .click();
    await expect(async () =>
      expect(await statuses('Prompt')).toEqual(['Done', 'Prompt available']),
    ).toPass();
    console.log('Prompt workflow starts in Prompt available');
  }

  // The board ID differs per site; Jira Software's board API (outside the v3 client) finds it.
  const boards = await request.fetch(
    `${target.site}/rest/agile/1.0/board?projectKeyOrId=${project.id}`,
    { timeout: 30000, maxRedirects: 0 },
  );
  assert.ok(boards.ok(), `Board lookup failed (HTTP ${boards.status()})`);
  const board = (await boards.json()).values?.find(
    (b) => String(b.location?.projectId) === project.id,
  )?.id;
  assert.ok(board, 'The space has no board');
  await page.goto(`${target.site}/jira/software/projects/${key}/boards/${board}`);
  await page.getByRole('heading', { name: 'To Do', level: 3 }).waitFor();
  if (await page.getByRole('heading', { name: 'Prompt available', level: 3 }).count()) {
    const done = page.getByRole('button', { name: 'Done', exact: true });
    if (await done.count()) await done.first().click();
    await page.getByRole('button', { name: 'More board view actions' }).click();
    await page.getByRole('menuitem', { name: 'Configure columns' }).click();
    const columns = page.getByRole('dialog', { name: 'Configure columns' });
    await columns
      .getByRole('listitem', { name: 'Status Prompt available' })
      .dragTo(columns.getByRole('listitem', { name: 'Column Hidden statuses' }));
    const empty = columns.getByRole('listitem', { name: 'Column Prompt available' });
    if (await empty.count()) {
      await empty.hover();
      await empty
        .getByRole('button', { name: 'More actions on column Prompt available' })
        .click({ force: true });
      await page.getByRole('menuitem', { name: 'Remove column' }).click();
    }
    await columns.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByRole('heading', { name: 'Prompt available', level: 3 })).toHaveCount(0);
    console.log('Prompt available hidden on the board');
  }
  console.log(`${key}: team-managed fixture ready`);
} finally {
  await browser?.close();
  await request.dispose();
}
