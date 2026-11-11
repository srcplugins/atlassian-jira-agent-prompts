// Hosted check of an upgrade from a version that accepted a built-in prompt type (v1.0.5 allowed
// Story). `before` runs on the old version: a marked empty space set up with Story as its prompt
// type, the field on its Task screens, and a Task whose saved prompt is a Story. Deploy the current
// version, then `after <id>` checks what the upgrade shows, removes setup through the app, sets the
// space up again with a dedicated type, removes it, and cleans up. `cleanup <id>` recovers a run.
// The deploys between the phases are made by hand; this runner never deploys.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { chromium } from '@playwright/test';
import { expect } from './support/expect.mjs';
import { activeTarget, siteFor } from '@srcplugins/atlassian-forge-test-framework/core';
import {
  adf,
  tokenRequest,
  client,
  installation,
  observeAction,
} from '@srcplugins/atlassian-forge-test-framework/jira';
import { spaceSettings } from './support/space-settings.mjs';
import { setupRunSpace } from './support/fixture.mjs';
import { setupCleanup } from './support/setup-cleanup.mjs';
import { agentPromptsField, fieldReadView } from './support/field.mjs';
import { editor, openField } from './support/snapshots.mjs';
import { chooseScreenTypes, nextStep, reviewStep } from './support/configuration-dialog.mjs';

const [phase, given] = process.argv.slice(2);
assert.ok(
  ['before', 'after', 'cleanup'].includes(phase),
  'Phase: before, after <id> or cleanup <id>',
);
assert.equal(process.env.NATIVE_UPGRADE_TESTS, '1', 'Explicit NATIVE_UPGRADE_TESTS=1 required');
assert.equal(activeTarget().host, siteFor('primary'));
assert.equal(process.env.PLUGIN_TEST_ENVIRONMENT ?? 'development', 'development');
const directory = `${activeTarget().directory}/native-upgrade-runs`;
mkdirSync(directory, { recursive: true });
const id = phase === 'before' ? randomUUID() : given;
assert.match(id, /^[0-9a-f-]{36}$/);
const path = `${directory}/${id}.json`;
const lock = `${directory}/upgrade.lock`;
assert.ok(!existsSync(lock), 'Another upgrade run holds the lock; inspect it first');
for (const name of readdirSync(directory).filter((x) => x.endsWith('.json'))) {
  const previous = JSON.parse(readFileSync(`${directory}/${name}`, 'utf8'));
  assert.ok(previous.clean || previous.id === id, 'Resolve the previous upgrade journal first');
}
writeFileSync(lock, JSON.stringify({ id, pid: process.pid }), { flag: 'wx', mode: 0o600 });
const j =
  phase === 'before'
    ? {
        id,
        site: activeTarget().site,
        fixtures: [
          {
            key: `NU${id.replaceAll('-', '').slice(0, 7).toUpperCase()}0`,
            marker: setupRunSpace(id, 0),
          },
        ],
        // The dedicated type the space is set up with again after the upgrade.
        existing: { name: `Existing ${id}`, marker: `Upgrade run ${id} existing type.` },
        items: [],
        stage: 'preflight',
        clean: false,
      }
    : JSON.parse(readFileSync(path, 'utf8'));
assert.equal(j.id, id);
assert.equal(j.site, activeTarget().site);
// `after` starts on a prepared run, or again after stopping in one of its read-only stages.
if (phase === 'after')
  assert.ok(
    [
      'awaiting-upgrade',
      'upgraded-health',
      'upgraded-field',
      'upgraded-offer',
      'reconfigure',
      'reconfigured-field',
    ].includes(j.stage),
    'Run after only on a prepared run, or one stopped before its first write',
  );
const persist = () => {
  writeFileSync(`${path}.tmp`, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};
persist();
const r = await tokenRequest();
const api = client(r);
const { pages, mappings, known, emptyProject, fieldTab, cleanup } = setupCleanup({
  j,
  api,
  persist,
});
const stage = (value) => {
  j.stage = value;
  persist();
};
const space = j.fixtures[0];
const t = installation('agent-prompts');
let browser;
let page;

/**
 * Deletes the run's space with its work items, once every work item in it is one the run
 * journaled: the site's permission scheme doesn't let the owner delete work items one by one.
 * The shared cleanup then removes what the space leaves behind.
 */
async function deleteSpace() {
  if (!space.project || space.projectDeleted) return;
  const p = await api(`/project/${space.project.id}`);
  if (p === null) {
    assert.equal(space.projectDeleteIntent, true);
  } else {
    assert.equal(p.key, space.key);
    assert.equal(p.description, space.marker);
    const found = await api('/search/jql', 'POST', {
      jql: `project = ${space.project.id}`,
      fields: ['summary'],
      maxResults: 10,
    });
    assert.equal(found.isLast, true);
    const ours = new Set(j.items.map((x) => x.summary));
    for (const issue of found.issues)
      assert.ok(ours.has(issue.fields.summary), `${issue.key} isn’t the run’s own`);
    space.projectDeleteIntent = true;
    persist();
    await api(`/project/${space.project.id}?enableUndo=false`, 'DELETE');
    assert.equal(await api(`/project/${space.project.id}`), null);
  }
  space.projectDeleted = true;
  persist();
}

/** Every screen of the space's own screen schemes; the run's space owns them all. */
async function spaceScreens() {
  const assigned = await pages(`/issuetypescreenscheme/project?projectId=${space.project.id}`);
  assert.equal(assigned.length, 1);
  const itss = assigned[0].issueTypeScreenScheme;
  assert.ok(itss.name.startsWith(`${space.key}:`), 'Fixture screens must be the run’s own');
  const rows = await pages(`/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${itss.id}`);
  const screens = new Set();
  for (const schemeId of new Set(rows.map((x) => x.screenSchemeId))) {
    const scheme = (await pages(`/screenscheme?id=${schemeId}`))[0];
    assert.ok(scheme.name.startsWith(`${space.key}:`));
    for (const screen of Object.values(scheme.screens)) screens.add(String(screen));
  }
  for (const screen of screens) {
    const found = await pages(`/screens?id=${screen}`);
    assert.ok(found[0].name.startsWith(`${space.key}:`), 'Fixture screens must be the run’s own');
  }
  return [...screens].sort();
}

/** The space's checked health from its settings page. */
async function health() {
  await spaceSettings(page, space.key);
  const search = page.getByRole('textbox', { name: 'Find a space', exact: true });
  await expect(search).toBeEnabled({ timeout: 60000 });
  await search.fill(space.key);
  await page.getByRole('checkbox', { name: `Select ${space.key}`, exact: true }).click();
  const checked = await observeAction(
    page,
    'settings-health',
    () => page.getByRole('button', { name: 'Check selected', exact: true }).click(),
    t,
    space.project.id,
  );
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  return checked;
}

/** Opens the configuration dialog for the space, from its settings page. */
async function dialog() {
  await spaceSettings(page, space.key);
  await page.getByRole('textbox', { name: 'Find a space', exact: true }).fill(space.key);
  await page.getByRole('checkbox', { name: `Select ${space.key}`, exact: true }).click();
  await observeAction(
    page,
    'configuration-catalog',
    () => page.getByRole('button', { name: 'Configure selected', exact: true }).click(),
    t,
  );
}
async function applyAndFinish() {
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Configuration complete', exact: true }),
  ).toBeVisible({ timeout: 60000 });
  return observeAction(
    page,
    'configuration-status',
    () => page.getByRole('button', { name: 'Done', exact: true }).click(),
    t,
  );
}
async function configureWith(typeName) {
  await dialog();
  await page.getByRole('combobox', { name: 'Existing type', exact: true }).click();
  await page.getByRole('option', { name: typeName, exact: true }).click();
  await nextStep(page);
  await chooseScreenTypes(page, space.key, 'Task');
  await reviewStep(page);
  return applyAndFinish();
}
async function removeSetup() {
  await dialog();
  await page.getByRole('combobox', { name: 'Prompt work type', exact: true }).click();
  await page
    .getByRole('option', { name: 'Remove setup from selected spaces', exact: true })
    .click();
  await reviewStep(page);
  return applyAndFinish();
}
const description = async (item) =>
  (await api(`/issue/${item.id}?fields=description`)).fields.description;
/** The field editor's status line that has text; the editor also keeps an empty one. */
const fieldStatus = () => editor(page).getByRole('status').filter({ hasText: /\S/ });
/**
 * Opens the field's editor on the loaded work item and returns the app's load reply. Jira can drop
 * a click on a freshly loaded work item, and opening only reads, so it clicks until the editor
 * shows: its prompt search, or a status line where the field has nothing to offer.
 */
function openEditor() {
  const opened = editor(page)
    .getByRole('combobox', { name: 'Agent Prompts', exact: true })
    .or(fieldStatus())
    .first();
  return observeAction(
    page,
    'load',
    () =>
      expect(async () => {
        if (!(await opened.isVisible()))
          await fieldReadView(page, j.field).click({ position: { x: 2, y: 2 }, timeout: 5000 });
        await expect(opened).toBeVisible({ timeout: 5000 });
      }).toPass({ timeout: 40000, intervals: [1000, 3000] }),
    t,
  );
}
const shot = (name) => page.screenshot({ path: `${directory}/${id}-${name}.png`, fullPage: true });

try {
  const owner = await api('/myself');
  assert.equal(
    (await api('/mypermissions?permissions=ADMINISTER')).permissions.ADMINISTER.havePermission,
    true,
  );
  if (phase !== 'cleanup') {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ storageState: activeTarget().auth });
    assert.equal((await client(context.request)('/myself')).accountId, owner.accountId);
    page = await context.newPage();
    page.setDefaultTimeout(30000);
  }
  if (phase === 'before') {
    j.actor = owner.accountId;
    assert.equal(await api(`/project/${space.key}`), null);
    stage('create-space');
    space.projectIntent = true;
    persist();
    space.project = await api('/project', 'POST', {
      key: space.key,
      name: `Upgrade run ${id.slice(0, 8)}`,
      description: space.marker,
      projectTypeKey: 'software',
      projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic',
      leadAccountId: owner.accountId,
      assigneeType: 'UNASSIGNED',
    });
    space.project.id = String(space.project.id);
    persist();
    const assigned = await pages(`/issuetypescheme/project?projectId=${space.project.id}`);
    assert.equal(assigned.length, 1);
    space.scheme = assigned[0].issueTypeScheme;
    persist();
    await emptyProject(space);
    // Story, Jira's built-in type, and the run's own dedicated type in the space's own scheme.
    const global = (await api('/issuetype')).filter((x) => !x.scope);
    const story = global.filter((x) => x.name === 'Story');
    assert.equal(story.length, 1);
    j.story = String(story[0].id);
    const made = j.existing;
    stage('types');
    assert.ok(!global.some((x) => x.name === made.name));
    made.intent = true;
    persist();
    made.id = String(
      (
        await api('/issuetype', 'POST', {
          name: made.name,
          description: made.marker,
          hierarchyLevel: 0,
        })
      ).id,
    );
    persist();
    space.existingIntent = true;
    persist();
    const present = await mappings();
    await api(`/issuetypescheme/${space.scheme.id}/issuetype`, 'PUT', {
      issueTypeIds: [j.story, made.id].filter((x) => !present.includes(`${space.scheme.id}:${x}`)),
    });
    const project = await emptyProject(space);
    assert.ok(project.issueTypes.some((x) => String(x.id) === j.story));
    j.task = String(project.issueTypes.find((x) => x.name === 'Task').id);
    j.defaultScheme = (await pages('/issuetypescheme')).find((x) => x.isDefault).id;
    j.mappingBaseline = await mappings();
    j.field = (await agentPromptsField(api, t)).id;
    // Journaled before any app write, so cleanup takes the field off them if the app does not.
    j.screens = await spaceScreens();
    persist();
    for (const screen of j.screens) assert.equal(await fieldTab(screen), undefined);

    stage('configure-story');
    const done = await configureWith('Story');
    assert.equal(done.data.status, 'complete');
    let checked = await health();
    assert.equal(checked.state.data.type, j.story);
    assert.ok(
      checked.checks.every((c) => c.ok),
      'The old version accepts Story',
    );
    await shot('before-health');

    stage('work-items');
    const prompt = { summary: `Upgrade run ${id} prompt`, type: j.story };
    const target = { summary: `Upgrade run ${id} target`, type: j.task };
    for (const item of [prompt, target]) {
      j.items.push(item);
      persist();
      item.id = (
        await api('/issue', 'POST', {
          fields: {
            project: { id: space.project.id },
            issuetype: { id: item.type },
            summary: item.summary,
            description: adf(`${space.marker} ${item.summary}`),
          },
        })
      ).id;
      item.key = (await api(`/issue/${item.id}?fields=summary`)).key;
      persist();
    }
    stage('select-prompt');
    await page.goto(`${activeTarget().site}/browse/${target.key}`);
    const loaded = await observeAction(
      page,
      'load',
      () => openField(page, fieldReadView(page, j.field)),
      t,
    );
    const combo = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
    await observeAction(page, 'search', () => combo.fill(prompt.key), t);
    await combo.press('ArrowDown');
    await editor(page).getByText(`${prompt.key} — ${prompt.summary}`, { exact: true }).click();
    const save = () => editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    if (loaded.refreshAfterSave)
      await Promise.all([page.waitForEvent('framenavigated', { timeout: 60000 }), save()]);
    else await observeAction(page, 'save', save, t);
    j.before = {
      target: await description(target),
      prompt: await description(prompt),
      value: (await api(`/issue/${target.id}?fields=${j.field}`)).fields[j.field],
    };
    assert.ok(JSON.stringify(j.before.target).includes(prompt.summary), 'Section written');
    assert.ok(j.before.value, 'Selection saved');
    await shot('before-target');
    stage('awaiting-upgrade');
    console.log(
      `Upgrade run ${id}: prepared on the old version. Deploy the current version, then:`,
    );
    console.log(`NATIVE_UPGRADE_TESTS=1 node tests/hosted/verify-built-in-upgrade.mjs after ${id}`);
  }

  if (phase === 'after') {
    const [prompt, target] = j.items;
    // A run that stopped after its reconfigure only reads the outcome below; it never applies again.
    const reconfigured = ['reconfigure', 'reconfigured-field'].includes(j.stage);
    j.after ??= {};
    let checked;
    if (!reconfigured) {
      stage('upgraded-health');
      checked = await health();
      await shot('after-health');
      assert.equal(checked.state.data.type, j.story);
      assert.equal(checked.checks[0].ok, false);
      assert.match(checked.checks[0].detail, /^Story is one of Jira’s built-in work types/);
      j.after.health = checked.checks.map(({ label, ok, detail }) => ({ label, ok, detail }));
      persist();

      stage('upgraded-field');
      // Nothing changed in Jira by the upgrade alone.
      assert.deepEqual(await description(target), j.before.target);
      assert.deepEqual(await description(prompt), j.before.prompt);
      await page.goto(`${activeTarget().site}/browse/${target.key}`);
      const status = fieldStatus();
      const noticed = await openEditor();
      assert.match(
        noticed.notice,
        /^Agent Prompts isn’t set up for this space: its prompt type is one of Jira’s built-in work types\./,
      );
      await expect(status).toHaveText(noticed.notice);
      await expect(
        editor(page).getByRole('button', { name: 'Try again', exact: true }),
      ).toHaveCount(0);
      await expect(
        editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true }),
      ).toHaveCount(0);
      await shot('after-field');
      j.after.notice = noticed.notice;
      persist();

      stage('upgraded-offer');
      await dialog();
      await page.getByRole('combobox', { name: 'Existing type', exact: true }).click();
      await expect(page.getByRole('option', { name: 'Story', exact: true })).toHaveCount(0);
      await expect(page.getByRole('option', { name: j.existing.name, exact: true })).toHaveCount(1);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();

      stage('remove-setup');
      const removed = await removeSetup();
      assert.equal(removed.data.status, 'complete');
      checked = await health();
      assert.equal(checked.state?.data?.type, undefined);
      for (const screen of j.screens) assert.equal(await fieldTab(screen), undefined, screen);
      assert.deepEqual(known(await mappings()), j.mappingBaseline);
      j.after.removedTarget = (await description(target)) ?? null;
      j.after.removedValue = (await api(`/issue/${target.id}?fields=${j.field}`)).fields[j.field];
      persist();

      stage('reconfigure');
      const again = await configureWith(j.existing.name);
      assert.equal(again.data.status, 'complete');
    }
    checked = await health();
    assert.equal(checked.state.data.type, j.existing.id);
    assert.ok(checked.checks.every((c) => c.ok));
    stage('reconfigured-field');
    await page.goto(`${activeTarget().site}/browse/${target.key}`);
    const reopened = await openEditor();
    await page.waitForTimeout(3000);
    await shot('reconfigured-field');
    j.after.reconfigured = {
      notice: reopened.notice,
      reply: reopened,
      status: await fieldStatus().allTextContents(),
    };
    persist();

    stage('remove-again');
    const last = await removeSetup();
    assert.equal(last.data.status, 'complete');
    for (const screen of j.screens) assert.equal(await fieldTab(screen), undefined, screen);
    j.passed = true;
    persist();
  }

  if (phase !== 'before') {
    stage('cleanup');
    await deleteSpace();
    await cleanup();
    console.log(`Upgrade run ${id}: ${j.passed ? 'passed' : 'recovered'}; cleanup verified.`);
    console.log(JSON.stringify(j.after ?? {}, null, 2));
  }
} catch (error) {
  writeFileSync(
    `${directory}/${id}-failure.txt`,
    error instanceof Error ? error.stack : 'Unknown failure',
    {
      mode: 0o600,
    },
  );
  if (page) await shot('failure').catch(() => {});
  j.failedAt = j.stage;
  persist();
  console.error(
    `Upgrade run ${id} stopped at ${j.stage}; inspect the journal. No automatic write retry.`,
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await r.dispose();
  unlinkSync(lock);
}
