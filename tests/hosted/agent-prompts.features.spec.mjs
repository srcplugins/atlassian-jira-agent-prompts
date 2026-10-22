import { editor, expandPrompts, openField, snapshotJourney } from './support/snapshots.mjs';
import {
  expect,
  installation,
  themeTest as test,
  textContrast,
  observeAction,
  client,
  dismissOnboarding,
} from '@srcplugins/atlassian-forge-test-framework/jira';
import {
  activeTarget,
  fixtureProject,
  isMarker,
  markers,
} from '@srcplugins/atlassian-forge-test-framework/core';
import { agentPromptsFixture, teamManagedFixture } from './support/fixture.mjs';
import { agentPromptsField, fieldReadView } from './support/field.mjs';
import { spaceBoard } from './support/board.mjs';
import { expectSpaceSettingsRefused, spaceSettings } from './support/space-settings.mjs';
import { reviewConfiguration } from './support/configuration-dialog.mjs';
import {
  checkSpace,
  configureOwnType,
  details,
  globalConfiguration,
  jiraConfiguration,
  removeSetup,
} from './support/team-managed.mjs';
test.use({ fixtureApp: agentPromptsFixture });
/** A node without the localIds Jira's editors stamp, as the app copies a prompt's content. */
function unstamped(node) {
  const copy = { ...node };
  if (copy.attrs) {
    copy.attrs = { ...copy.attrs };
    delete copy.attrs.localId;
    if (!Object.keys(copy.attrs).length) delete copy.attrs;
  }
  if (node.content) copy.content = node.content.map(unstamped);
  return copy;
}
test('AP-04 real non-admin sessions cannot administer setup', async ({ browser, jiraRequest }) => {
  test.skip(
    process.env.NATIVE_IDENTITY_TESTS !== '1',
    'Explicit identity mode and saved consenting actors required',
  );
  const api = client(jiraRequest);
  const project = await api(`/project/${fixtureProject(agentPromptsFixture)}`);
  expect(isMarker(project.description, markers.browserProject(agentPromptsFixture))).toBe(true);
  const owner = await api('/myself');
  const actors = new Set([owner.accountId]);
  for (const role of ['member', 'restricted']) {
    const context = await browser.newContext({
      storageState: `${activeTarget().authDirectory}/${role}.json`,
    });
    try {
      const actorApi = client(context.request);
      const actor = await actorApi('/myself');
      expect(actor.accountId).toBeTruthy();
      expect(actors.has(actor.accountId)).toBe(false);
      actors.add(actor.accountId);
      const permissions = await actorApi(
        `/mypermissions?projectId=${project.id}&permissions=ADMINISTER,BROWSE_PROJECTS`,
      );
      expect(permissions.permissions.ADMINISTER.havePermission).toBe(false);
      expect(permissions.permissions.BROWSE_PROJECTS.havePermission).toBe(true);
      const page = await context.newPage();
      await spaceSettings(page, project.key);
      try {
        await expectSpaceSettingsRefused(page, expect);
      } catch (error) {
        await page.screenshot({
          path: `${activeTarget().directory}/${role}-eligibility.png`,
          fullPage: true,
        });
        throw error;
      }
    } finally {
      await context.close();
    }
  }
});
for (const blank of [false, true]) {
  test(`${blank ? 'AP-03 blank Description round-trip' : 'AP-01 prompt snapshots, explicit Sync and precise removal'}`, async ({
    page,
    owned,
  }, testInfo) => {
    await snapshotJourney({ page, owned, blank, testInfo });
  });
}
test('AP-13 retired prompt: hidden from search, kept selection still syncs', async ({
  page,
  owned,
}, testInfo) => {
  await snapshotJourney({ page, owned, blank: false, retire: true, testInfo });
});
test('AP-15 a Description edit in Jira keeps the section syncable and removable', async ({
  page,
  owned,
}, testInfo) => {
  await snapshotJourney({ page, owned, blank: false, editInJira: true, testInfo });
});

/** Opens the space or global page, checks the owned space and returns its health. */
async function configuration(page, owned, global = false) {
  const t = installation('agent-prompts');
  if (global) await globalConfiguration(page, t);
  else await spaceSettings(page, owned.project.key);
  return checkSpace(page, t, owned.project.key, owned.project.id);
}

test('AP-02 selected space health and cancelled modal preserve Jira', async ({ page, owned }) => {
  const t = installation('agent-prompts');
  const issue = await owned.issue('Setup read-only baseline');
  const before = await owned.api(`/issue/${issue.id}?fields=description,issuetype`);
  const health = await configuration(page, owned);
  expect(health.checks.every((c) => c.ok)).toBe(true);
  await details(page, owned.project.key);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Jira configuration', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Reconfigure space', exact: true }).click();
  const plan = await reviewConfiguration(page, t);
  expect(plan.type).toBe(health.state.data.type);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Find a space', exact: true })).toBeEnabled();
  await expect(
    page.getByRole('checkbox', { name: `Select ${owned.project.key}`, exact: true }),
  ).toBeChecked();
  const after = await observeAction(
    page,
    'settings-health',
    () => page.getByRole('button', { name: 'Check selected', exact: true }).click(),
    t,
    owned.project.id,
  );
  expect(after.state).toEqual(health.state);
  expect((await owned.api(`/issue/${issue.id}?fields=description,issuetype`)).fields).toEqual(
    before.fields,
  );
});

test('AP-11 details modal keeps focus, contrast and layout in dark theme and narrow width', async ({
  page,
  owned,
  theme,
}) => {
  const t = installation('agent-prompts');
  const issue = await owned.issue('Details appearance baseline');
  const before = await owned.api(`/issue/${issue.id}?fields=description,issuetype`);
  const dialog = page.getByRole('dialog');
  const viewDetails = page
    .getByRole('row')
    .filter({
      has: page.getByRole('checkbox', { name: `Select ${owned.project.key}`, exact: true }),
    })
    .getByRole('button', { name: 'View details', exact: true });
  for (const [
    name,
    viewport,
  ] of /** @type {Array<[string, { width: number, height: number }]>} */ ([
    ['Dark', { width: 1440, height: 1100 }],
    ['Dark', { width: 640, height: 900 }],
    ['Light', { width: 640, height: 900 }],
  ])) {
    // The theme menu is in the account menu, which narrow layouts collapse.
    await page.setViewportSize({ width: 1440, height: 1100 });
    await theme(name);
    await page.setViewportSize(viewport);
    await configuration(page, owned);
    await expect(page.locator('html')).toHaveAttribute('data-color-mode', name.toLowerCase());
    await viewDetails.click();
    await expect(
      dialog.getByRole('heading', { name: 'Jira configuration', exact: true }),
    ).toBeVisible();
    // Measure only once the open animation has finished and the modal is fully opaque.
    await expect
      .poll(() =>
        dialog.evaluate((element) => {
          let opacity = 1;
          for (let node = element; node; node = node.parentElement)
            opacity *= Number(getComputedStyle(node).opacity);
          return opacity;
        }),
      )
      .toBe(1);
    // Focus moves into the modal, and every settings link opens a new tab.
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    const links = dialog.getByRole('link');
    expect(await links.count()).toBeGreaterThanOrEqual(2);
    for (const link of await links.all()) await expect(link).toHaveAttribute('target', '_blank');
    await textContrast(dialog.getByRole('heading', { name: 'Jira configuration', exact: true }));
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: `${activeTarget().runs}/${owned.run.state.runId}-details-${name.toLowerCase()}-${viewport.width}.png`,
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(viewDetails).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  const after = await observeAction(
    page,
    'settings-health',
    () => page.getByRole('button', { name: 'Check selected', exact: true }).click(),
    t,
    owned.project.id,
  );
  expect(after.checks.every((c) => c.ok)).toBe(true);
  expect((await owned.api(`/issue/${issue.id}?fields=description,issuetype`)).fields).toEqual(
    before.fields,
  );
});

test('AP-05 unified global configuration checks selected spaces and selects across pages', async ({
  page,
  owned,
}, testInfo) => {
  const t = installation('agent-prompts');
  const before = await owned.api(`/project/${owned.project.id}`);
  const calls = [];
  page.on('request', (r) => {
    try {
      const input = r.postDataJSON()?.variables?.input;
      if (input?.extensionId?.includes(t.appId)) calls.push(input.payload?.call?.functionKey);
    } catch {
      /* non app traffic */
    }
  });
  const inventory = await globalConfiguration(page, t);
  expect(inventory.incomplete).toBe(false);
  const search = page.getByRole('textbox', { name: 'Find a space', exact: true });
  await expect(search).toBeEnabled({ timeout: 60000 });
  await search.fill(owned.project.key);
  await page.getByRole('checkbox', { name: `Select ${owned.project.key}`, exact: true }).click();
  await observeAction(
    page,
    'settings-health',
    () => page.getByRole('button', { name: 'Check selected', exact: true }).click(),
    t,
    owned.project.id,
  );
  await search.fill('');
  const all = page.getByRole('checkbox', { name: 'Select all matching spaces', exact: true });
  await all.click();
  await expect(all).toBeChecked();
  const catalog = await observeAction(
    page,
    'configuration-catalog',
    () => page.getByRole('button', { name: 'Configure selected', exact: true }).click(),
    t,
  );
  expect(catalog.typesAvailable).toBe(true);
  expect('projects' in catalog).toBe(false);
  // Select all covers the company-managed tab only; team-managed spaces are configured apart.
  await expect(
    page.getByRole('heading', {
      name: `Configure ${inventory.projects.filter((p) => !p.teamManaged).length} spaces`,
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(search).toBeEnabled({ timeout: 60000 });
  await search.fill(owned.project.key);
  await page.getByRole('checkbox', { name: `Select ${owned.project.key}`, exact: true }).click();
  await observeAction(
    page,
    'settings-health',
    () => page.getByRole('button', { name: 'Check selected', exact: true }).click(),
    t,
    owned.project.id,
  );
  await details(page, owned.project.key);
  await expect(page.getByRole('heading', { name: 'Configuration', exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('space-configuration-details.png'),
    fullPage: true,
  });
  expect(
    calls.every((c) =>
      [
        'settings-projects',
        'settings-health',
        'configuration-status',
        'configuration-catalog',
      ].includes(c),
    ),
  ).toBe(true);
  const after = await owned.api(`/project/${owned.project.id}`);
  expect(after.issueTypes).toEqual(before.issueTypes);
  expect(after.description).toEqual(before.description);
});

test('AP-06 empty prompt save preserves unsaved selection during read-only recovery', async ({
  page,
  owned,
}, testInfo) => {
  const health = await configuration(page, owned);
  const source = await owned.propertyIssue(
    `Empty prompt ${owned.run.state.runId.slice(0, 8)}`,
    'Ordinary prompt instructions.',
    health.state.data.type,
  );
  source.expected.descriptionVariants = [
    source.expected.description,
    null,
    { type: 'doc', version: 1, content: [] },
  ];
  owned.run.persist();
  await owned.api(`/issue/${source.id}`, 'PUT', { fields: { description: null } });
  const target = await owned.issue('Prompt failed-save recovery');
  const sourceIssue = await owned.api(`/issue/${source.id}?fields=summary,description,issuetype`);
  const targetIssue = await owned.api(`/issue/${target.id}?fields=description`);
  const t = installation('agent-prompts');
  const field = await agentPromptsField(owned.api);
  const before = (await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields;
  await expect(async () => {
    const found = await owned.api('/search/jql', 'POST', {
      jql: `project = ${owned.project.id} AND issuetype = ${sourceIssue.fields.issuetype.id} ORDER BY key ASC`,
      maxResults: 100,
      fields: ['summary'],
    });
    expect(found.issues.some((i) => i.id === source.id)).toBe(true);
  }).toPass({ timeout: 30000, intervals: [1000, 3000] });
  await page.goto(`${activeTarget().site}/browse/${targetIssue.key}`);
  const readView = fieldReadView(page, field.id);
  const loaded = await observeAction(page, 'load', () => openField(page, readView), t);
  owned.run.state.loadedPromptIds = loaded.prompts.map((p) => p.id);
  owned.run.persist();
  expect(loaded.prompts.map((p) => p.id)).toContain(source.id);
  const combo = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
  await expect(combo).toBeEnabled();
  await observeAction(
    page,
    'search',
    () =>
      editor(page)
        .getByRole('combobox', { name: 'Agent Prompts', exact: true })
        .fill(sourceIssue.key),
    installation('agent-prompts'),
  );
  await combo.press('ArrowDown');
  const selectedLabel = `${sourceIssue.key} — ${source.expected.summary}`;
  await editor(page).getByText(selectedLabel, { exact: true }).click();
  await expect(editor(page).getByText(/Unsaved changes/)).toBeVisible();
  await expect(
    observeAction(
      page,
      'save',
      () => editor(page).getByRole('button', { name: 'Save', exact: true }).click(),
      t,
    ),
  ).rejects.toMatchObject({ category: 'resolver-failed' });
  await expect(
    editor(page).getByText(`${sourceIssue.key}: Prompt instructions must`, { exact: false }),
  ).toBeVisible();
  // A definitive rejection is reconciled by one read: no saved-state recovery is needed.
  await expect(
    editor(page).getByRole('button', { name: 'Check saved state', exact: true }),
  ).toHaveCount(0);
  await expect(editor(page).getByText(selectedLabel, { exact: true })).toBeVisible();
  await expect(editor(page).getByText(/Unsaved changes/)).toBeVisible();
  await expect(editor(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath('unsaved-selection-preserved.png'),
    fullPage: true,
  });
  expect((await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields).toEqual(
    before,
  );
  expect((await owned.api(`/issue/${source.id}?fields=description`)).fields.description).toEqual(
    sourceIssue.fields.description,
  );
  await editor(page).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(editor(page).getByText(selectedLabel, { exact: true })).toHaveCount(0);
  await expect(editor(page).getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect((await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields).toEqual(
    before,
  );
});

test('AP-10 an Agent Prompts section deleted in Jira is forgotten by a field-only save', async ({
  page,
  owned,
}) => {
  const t = installation('agent-prompts');
  const health = await configuration(page, owned);
  const source = await owned.propertyIssue(
    `Deleted block ${owned.run.state.runId.slice(0, 8)}`,
    'Instructions copied before the block is deleted.',
    health.state.data.type,
  );
  const target = await owned.issue('Prompt deleted block');
  const sourceIssue = await owned.api(`/issue/${source.id}?fields=summary,issuetype`);
  const field = await agentPromptsField(owned.api);
  await expect(async () => {
    const found = await owned.api('/search/jql', 'POST', {
      jql: `project = ${owned.project.id} AND issuetype = ${sourceIssue.fields.issuetype.id} ORDER BY key ASC`,
      maxResults: 100,
      fields: ['summary'],
    });
    expect(found.issues.some((i) => i.id === source.id)).toBe(true);
  }).toPass({ timeout: 30000, intervals: [1000, 3000] });
  const targetIssue = await owned.api(`/issue/${target.id}?fields=description`);
  const original = targetIssue.fields.description;
  const readView = fieldReadView(page, field.id);
  let loaded;
  const open = async () => {
    await page.goto(`${activeTarget().site}/browse/${targetIssue.key}`);
    loaded = await observeAction(page, 'load', () => openField(page, readView), t);
    await expect(
      editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true }),
    ).toBeEnabled();
  };
  const save = async () => {
    const click = () => editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    // With the space's reload preference on, navigation can discard the resolver body; the Jira
    // assertions after each save are the oracle.
    if (loaded.refreshAfterSave)
      await Promise.all([
        page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
        click(),
      ]);
    else await observeAction(page, 'save', click, t);
  };
  await open();
  const combo = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
  await observeAction(page, 'search', () => combo.fill(sourceIssue.key), t);
  await combo.press('ArrowDown');
  await editor(page)
    .getByText(`${sourceIssue.key} — ${source.expected.summary}`, { exact: true })
    .click();
  await save();
  const linked = (await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields;
  expect(linked[field.id]).toEqual([sourceIssue.key]);
  expect(
    linked.description.content.some((n) => n.attrs?.localId === `agent-prompts-${target.id}`),
  ).toBe(true);
  // An editor deletes the whole Agent Prompts section in Jira and adds their own text.
  const deletedDescription = {
    type: 'doc',
    version: 1,
    content: [
      ...linked.description.content.filter(
        (n) => n.attrs?.localId !== `agent-prompts-${target.id}`,
      ),
      { type: 'paragraph', content: [{ type: 'text', text: 'Edited after deleting the block.' }] },
    ],
  };
  target.expected.descriptionVariants = [
    ...(target.expected.descriptionVariants ?? [original]),
    linked.description,
    deletedDescription,
  ];
  owned.run.persist();
  await owned.api(`/issue/${target.id}`, 'PUT', { fields: { description: deletedDescription } });
  const afterEdit = (await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields;

  await open();
  // Refreshing copies needs the block: refused with guidance and no write.
  await expect(
    observeAction(
      page,
      'save',
      () => editor(page).getByRole('button', { name: 'Sync', exact: true }).click(),
      t,
    ),
  ).rejects.toMatchObject({ category: 'resolver-failed' });
  await expect(
    editor(page).getByText(
      /Agent Prompts section was removed in Jira\. Remove all prompts and save/i,
    ),
  ).toBeVisible();
  expect((await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields).toEqual(
    afterEdit,
  );

  // Removing every prompt forgets the deleted block by clearing only the field.
  await editor(page)
    .getByRole('button', { name: new RegExp(`remove.*${source.expected.summary}`, 'i') })
    .click();
  await save();
  const cleared = (await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields;
  expect(cleared.description).toEqual(afterEdit.description);
  expect(cleared[field.id] ?? []).toEqual([]);
  target.expected.customField = { id: field.id, value: cleared[field.id] };
  owned.run.persist();
});

test('AP-16 an Agent Prompts section the field does not track is listed, refused beside a new one and replaced on request', async ({
  page,
  owned,
}) => {
  const t = installation('agent-prompts');
  const health = await configuration(page, owned);
  const source = await owned.propertyIssue(
    `Other section ${owned.run.state.runId.slice(0, 8)}`,
    'Instructions named by a section the field does not track.',
    health.state.data.type,
  );
  const target = await owned.issue('Prompt other section');
  const sourceIssue = await owned.api(`/issue/${source.id}?fields=summary,issuetype,description`);
  const field = await agentPromptsField(owned.api);
  await expect(async () => {
    const found = await owned.api('/search/jql', 'POST', {
      jql: `project = ${owned.project.id} AND issuetype = ${sourceIssue.fields.issuetype.id} ORDER BY key ASC`,
      maxResults: 100,
      fields: ['summary'],
    });
    expect(found.issues.some((i) => i.id === source.id)).toBe(true);
  }).toPass({ timeout: 30000, intervals: [1000, 3000] });
  const targetIssue = await owned.api(`/issue/${target.id}?fields=description`);
  const original = targetIssue.fields.description;
  const name = `${sourceIssue.key}: ${source.expected.summary}`;
  const heading = { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: name }] };
  // The section another work item's save left in a copied description (agent-prompts#g457).
  const leftover = {
    type: 'expand',
    attrs: { localId: `agent-prompts-${source.id}`, title: 'Agent Prompts' },
    content: [
      heading,
      { type: 'paragraph', content: [{ type: 'text', text: 'Copied from another work item.' }] },
    ],
  };
  const withLeftover = { ...original, content: [...original.content, leftover] };
  // The app's own section, built here from the prompt as Jira returns it.
  const own = {
    type: 'expand',
    attrs: { localId: `agent-prompts-${target.id}`, title: 'Agent Prompts' },
    content: [heading, ...sourceIssue.fields.description.content.map(unstamped)],
  };
  const replaced = { ...original, content: [...original.content, own] };
  target.expected.descriptionVariants = [
    ...(target.expected.descriptionVariants ?? [original]),
    withLeftover,
  ];
  owned.run.persist();
  await owned.api(`/issue/${target.id}`, 'PUT', { fields: { description: withLeftover } });
  const before = (await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields;
  expect(before.description).toEqual(withLeftover);

  await page.goto(`${activeTarget().site}/browse/${targetIssue.key}`);
  const loaded = await observeAction(
    page,
    'load',
    () => openField(page, fieldReadView(page, field.id)),
    t,
  );
  expect(loaded.otherSection).toEqual({
    count: 1,
    replace: expect.any(String),
    prompts: [{ id: source.id, key: sourceIssue.key, name: source.expected.summary }],
    unavailable: [],
  });
  const combo = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
  await expect(combo).toBeEnabled();
  await expect(
    editor(page).getByText("This description has an Agent Prompts section the app didn't save.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    editor(page).getByRole('link', {
      name: `${sourceIssue.key} — ${source.expected.summary}`,
      exact: true,
    }),
  ).toHaveAttribute('href', `/browse/${sourceIssue.key}`);
  const save = async () => {
    const click = () => editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    // With the space's reload preference on, navigation can discard the resolver body; the Jira
    // assertions after each save are the oracle.
    if (loaded.refreshAfterSave)
      await Promise.all([
        page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
        click(),
      ]);
    else await observeAction(page, 'save', click, t);
  };

  // Choosing the prompt alone would write a second section beside it: refused, Jira unchanged.
  await observeAction(page, 'search', () => combo.fill(sourceIssue.key), t);
  await combo.press('ArrowDown');
  // The menu's option, not the warning's link with the same text.
  await editor(page)
    .getByText(`${sourceIssue.key} — ${source.expected.summary}`, { exact: true })
    .and(editor(page).locator(':not(a)'))
    .click();
  await expect(
    observeAction(
      page,
      'save',
      () => editor(page).getByRole('button', { name: 'Save', exact: true }).click(),
      t,
    ),
  ).rejects.toMatchObject({ category: 'resolver-failed' });
  await expect(
    editor(page).getByText(
      "The description has an Agent Prompts section the app didn't save. Delete it from the description, or use its prompts here to replace it, then save again.",
      { exact: true },
    ),
  ).toBeVisible();
  expect((await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields).toEqual(
    before,
  );

  // Use its prompts: the save replaces that section with the app's own, in its place.
  await editor(page).getByRole('button', { name: 'Use its prompts', exact: true }).click();
  await expect(
    editor(page).getByText("Saving replaces that section with the app's own.", { exact: true }),
  ).toBeVisible();
  target.expected.descriptionVariants.push(replaced);
  owned.run.persist();
  await save();
  const adopted = (await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields;
  expect(adopted[field.id]).toEqual([sourceIssue.key]);
  expect(adopted.description).toEqual(replaced);

  // Removing the prompt then leaves the description as it was before either section.
  if (loaded.refreshAfterSave) {
    await page.goto(`${activeTarget().site}/browse/${targetIssue.key}`);
    await openField(page, fieldReadView(page, field.id));
  }
  await editor(page)
    .getByRole('button', { name: new RegExp(`remove.*${source.expected.summary}`, 'i') })
    .click();
  target.expected.descriptionVariants.push(original);
  owned.run.persist();
  await save();
  const cleared = (await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields;
  expect(cleared.description).toEqual(original);
  expect(cleared[field.id] ?? []).toEqual([]);
  target.expected.customField = { id: field.id, value: cleared[field.id] };
  owned.run.persist();
});

test('AP-17 a section edited, retitled or duplicated in Jira is refused, and the steps in the message restore the field', async ({
  page,
  owned,
}, testInfo) => {
  const t = installation('agent-prompts');
  const health = await configuration(page, owned);
  const run = owned.run.state.runId.slice(0, 8);
  const instructions = `Instructions to edit in Jira ${run}.`;
  const source = await owned.propertyIssue(
    `Edited section ${run}`,
    instructions,
    health.state.data.type,
  );
  // As Jira's editor writes a prompt: a line per paragraph. The fixture's text holds a raw newline,
  // which Jira's editor turns into a space in any paragraph it edits.
  const editorSource = {
    ...source.expected.description,
    content: source.expected.description.content.flatMap((node) =>
      node.content?.length === 1 && node.content[0].text?.includes('\n')
        ? node.content[0].text
            .split('\n')
            .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
        : [node],
    ),
  };
  source.expected.descriptionVariants = [source.expected.description, editorSource];
  owned.run.persist();
  await owned.api(`/issue/${source.id}`, 'PUT', { fields: { description: editorSource } });
  const target = await owned.issue('Prompt section edited in Jira');
  const sourceIssue = await owned.api(`/issue/${source.id}?fields=summary,issuetype,description`);
  const field = await agentPromptsField(owned.api);
  await expect(async () => {
    const found = await owned.api('/search/jql', 'POST', {
      jql: `project = ${owned.project.id} AND issuetype = ${sourceIssue.fields.issuetype.id} ORDER BY key ASC`,
      maxResults: 100,
      fields: ['summary'],
    });
    expect(found.issues.some((i) => i.id === source.id)).toBe(true);
  }).toPass({ timeout: 30000, intervals: [1000, 3000] });
  const targetIssue = await owned.api(`/issue/${target.id}?fields=description`);
  const original = targetIssue.fields.description;
  const ownId = `agent-prompts-${target.id}`;
  const isOwn = (n) => n.type === 'expand' && n.attrs?.localId === ownId;
  // The app's own section, built here from the prompt as Jira returns it.
  const own = {
    type: 'expand',
    attrs: { localId: ownId, title: 'Agent Prompts' },
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: `${sourceIssue.key}: ${source.expected.summary}` }],
      },
      ...sourceIssue.fields.description.content.map(unstamped),
    ],
  };
  const changed =
    'The Agent Prompts section was changed, moved or duplicated in Jira. Undo that change, or delete the section from the description, remove all prompts here and save, then add them again.';
  const read = async () =>
    (await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields;
  /** A REST write of the Description, journaled first. */
  const write = async (description) => {
    target.expected.descriptionVariants.push(description);
    owned.run.persist();
    await owned.api(`/issue/${target.id}`, 'PUT', { fields: { description } });
    expect((await read()).description).toEqual(description);
  };
  /** Edits the Description in Jira's own editor and saves it there; returns what Jira saved. */
  const jiraEdit = async (label, act, landed) => {
    await page.goto(`${activeTarget().site}/browse/${targetIssue.key}`);
    // The fixture's own first paragraph: the middle of the read view is the section's expand.
    await page.getByTestId('issue.views.field.rich-text.description').locator('p').first().click();
    const content = page.locator('#ak-editor-textarea');
    await expect(content).toBeVisible();
    // The editor opens the section's expand as it was last shown; open it to reach the prompt.
    const prompt = content.getByText(instructions, { exact: false });
    await expect(async () => {
      if (!(await prompt.isVisible()))
        await content.getByRole('button', { name: /expand content/i }).click({ timeout: 5000 });
      await expect(prompt).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 30000, intervals: [1000, 3000] });
    await act({ prompt, content });
    // The editor's document is unknown until saved: journal that a save is pending, which no
    // description matches, so an interrupted run stops cleanup for inspection.
    target.expected.descriptionVariants.push({ pendingJiraEditorSave: label });
    owned.run.persist();
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    let saved = original;
    await expect(async () => {
      saved = (await read()).description;
      expect(landed(saved)).toBe(true);
    }).toPass({ timeout: 30000, intervals: [1000, 3000] });
    target.expected.descriptionVariants.splice(-1, 1, saved);
    owned.run.persist();
    await testInfo.attach(`jira-editor-${label}`, {
      body: JSON.stringify(saved, null, 1),
      contentType: 'application/json',
    });
    return saved;
  };
  let loaded;
  const open = async () => {
    await page.goto(`${activeTarget().site}/browse/${targetIssue.key}`);
    loaded = await observeAction(
      page,
      'load',
      () => openField(page, fieldReadView(page, field.id)),
      t,
    );
    await expect(
      editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true }),
    ).toBeEnabled();
  };
  const button = (name) => editor(page).getByRole('button', { name, exact: true });
  const save = async (name = 'Save') => {
    // With the space's reload preference on, navigation can discard the resolver body; the Jira
    // assertions after each save are the oracle.
    if (loaded.refreshAfterSave)
      await Promise.all([
        page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
        button(name).click(),
      ]);
    else await observeAction(page, 'save', () => button(name).click(), t);
  };
  /** Sync is refused with the recovery message, and Jira is unchanged. */
  const syncRefused = async () => {
    const before = await read();
    await open();
    await expect(
      observeAction(page, 'save', () => button('Sync').click(), t),
    ).rejects.toMatchObject({ category: 'resolver-failed' });
    await expect(editor(page).getByText(changed, { exact: true })).toBeVisible();
    expect(await read()).toEqual(before);
  };
  const choose = async () => {
    const combo = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
    await observeAction(page, 'search', () => combo.fill(sourceIssue.key), t);
    await combo.press('ArrowDown');
    await editor(page)
      .getByText(`${sourceIssue.key} — ${source.expected.summary}`, { exact: true })
      .click();
  };

  const linked = { ...original, content: [...original.content, own] };
  target.expected.descriptionVariants = [
    ...(target.expected.descriptionVariants ?? [original]),
    linked,
  ];
  target.expected.customField = { id: field.id, value: [sourceIssue.key] };
  owned.run.persist();
  await open();
  await choose();
  await save();
  expect(await read()).toEqual({ description: linked, [field.id]: [sourceIssue.key] });

  // Retitled, or copied with its identifier: Sync is refused until the change is undone.
  for (const tampered of [
    {
      ...linked,
      content: linked.content.map((n) =>
        isOwn(n) ? { ...n, attrs: { ...n.attrs, title: 'Prompts for agents' } } : n,
      ),
    },
    { ...linked, content: [structuredClone(own), ...linked.content] },
  ]) {
    await write(tampered);
    await syncRefused();
    await write(linked);
    await open();
    await save('Sync');
    expect(await read()).toEqual({ description: linked, [field.id]: [sourceIssue.key] });
  }

  // Jira's editor may give its own ids to nodes it touches, inside the section or out. The app
  // ignores them inside its section and keeps everything outside exactly as Jira saved it.
  const editorIdsOff = (d) => ({
    ...d,
    content: d.content.map((n) =>
      isOwn(n) ? { ...n, content: n.content.map(unstamped) } : unstamped(n),
    ),
  });
  /** What a save of the prompt writes over `d`: the app's section in place of its own, or last. */
  const withSection = (d) =>
    d.content.some(isOwn)
      ? { ...d, content: d.content.map((n) => (isOwn(n) ? own : n)) }
      : { ...d, content: [...d.content, own] };

  // Typed inside the section in Jira's editor: refused; deleting the typing in the editor undoes it.
  const typing = ` (edited in Jira ${run})`;
  const typed = await jiraEdit(
    'typed',
    async ({ prompt }) => {
      await prompt.click();
      await page.keyboard.press('End');
      await page.keyboard.type(typing);
    },
    (d) => JSON.stringify(d).includes(typing),
  );
  expect(editorIdsOff(typed).content.filter((n) => !isOwn(n))).toEqual(original.content);
  await syncRefused();
  const undone = await jiraEdit(
    'undone',
    async ({ content }) => {
      await content.getByText(typing.trim(), { exact: false }).click();
      await page.keyboard.press('End');
      for (let i = 0; i < typing.length; i++) await page.keyboard.press('Backspace');
    },
    (d) => !JSON.stringify(d).includes(typing),
  );
  expect(editorIdsOff(undone)).toEqual(linked);
  target.expected.descriptionVariants.push(withSection(undone));
  owned.run.persist();
  await open();
  await save('Sync');
  expect(await read()).toEqual({ description: withSection(undone), [field.id]: [sourceIssue.key] });

  // Typed again, then the other way out: delete the section in the editor, remove all prompts and
  // save (the field alone is cleared), then add them again.
  await jiraEdit(
    'typed-again',
    async ({ prompt }) => {
      await prompt.click();
      await page.keyboard.press('End');
      await page.keyboard.type(typing);
    },
    (d) => JSON.stringify(d).includes(typing),
  );
  await syncRefused();
  const deleted = await jiraEdit(
    'deleted',
    async ({ prompt }) => {
      await prompt.click();
      await page
        .getByTestId('editor-floating-toolbar')
        .getByRole('button', { name: 'Remove', exact: true })
        .click();
    },
    (d) => !d.content.some(isOwn) && !JSON.stringify(d).includes(typing),
  );
  expect(editorIdsOff(deleted)).toEqual(original);
  await open();
  await editor(page)
    .getByRole('button', { name: new RegExp(`remove.*${source.expected.summary}`, 'i') })
    .click();
  target.expected.customField = { id: field.id, value: [] };
  owned.run.persist();
  await save();
  const cleared = await read();
  expect(cleared.description).toEqual(deleted);
  expect(cleared[field.id] ?? []).toEqual([]);
  target.expected.descriptionVariants.push(withSection(deleted));
  target.expected.customField = { id: field.id, value: [sourceIssue.key] };
  owned.run.persist();
  await open();
  await choose();
  await save();
  expect(await read()).toEqual({
    description: withSection(deleted),
    [field.id]: [sourceIssue.key],
  });
});

/**
 * Runs `journey(initial)` with the space's "Reload work item after saving prompts" preference on,
 * then restores the preference it found. `initial` is the space's health before the change.
 */
async function withReloadPreference(page, owned, journey) {
  const t = installation('agent-prompts');
  async function health() {
    const value = await configuration(page, owned);
    await details(page, owned.project.key);
    return value;
  }
  const initial = await health();
  const original = initial.state.data.refreshAfterSave === true;
  owned.run.state.reloadPreference = { original, restored: false };
  owned.run.persist();
  async function preference(enabled) {
    const current = await health();
    if ((current.state.data.refreshAfterSave === true) !== enabled) {
      const toggle = page.getByRole('checkbox', {
        name: 'Reload work item after saving prompts',
        exact: true,
      });
      await toggle.click();
      if (enabled) await expect(toggle).toBeChecked();
      else await expect(toggle).not.toBeChecked();
      const checked = await observeAction(
        page,
        'settings-health',
        () => page.getByRole('button', { name: 'Save', exact: true }).click(),
        t,
      );
      expect(checked.state.data.refreshAfterSave).toBe(enabled);
      expect(checked.state.data.type).toBe(initial.state.data.type);
    }
  }
  try {
    await preference(true);
    await journey(initial);
  } finally {
    await preference(original);
    owned.run.state.reloadPreference.restored = true;
    owned.run.persist();
  }
}

/** The target's Description after a Save that adds one prompt: its own section, then the prompt. */
function withPrompt(target, key, source) {
  return {
    ...target.expected.description,
    content: [
      ...target.expected.description.content,
      {
        type: 'expand',
        attrs: { localId: `agent-prompts-${target.id}`, title: 'Agent Prompts' },
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: `${key}: ${source.expected.summary}` }],
          },
          ...source.expected.description.content,
        ],
      },
    ],
  };
}

/** Waits until Jira's search finds a prompt, as the field's picker searches for it. */
async function searchable(owned, type, id) {
  await expect(async () => {
    const found = await owned.api('/search/jql', 'POST', {
      jql: `project = ${owned.project.id} AND issuetype = ${type}`,
      fields: ['summary'],
      maxResults: 100,
    });
    expect(found.issues.some((i) => i.id === id)).toBe(true);
  }).toPass({ timeout: 30000, intervals: [1000, 3000] });
}

test('AP-08 opt-in work item reload follows a confirmed save and restores the space preference', async ({
  page,
  owned,
}, testInfo) => {
  const t = installation('agent-prompts');
  await withReloadPreference(page, owned, async (initial) => {
    const source = await owned.propertyIssue(
      'Reload preference source',
      'RELOAD-SENTINEL',
      initial.state.data.type,
    );
    const target = await owned.issue('Reload preference target');
    const sourceIssue = await owned.api(`/issue/${source.id}?fields=summary,description`);
    const targetIssue = await owned.api(`/issue/${target.id}?fields=description`);
    const field = await agentPromptsField(owned.api);
    const linked = withPrompt(target, sourceIssue.key, source);
    target.expected.descriptionVariants = [target.expected.description, linked];
    target.expected.customField = { id: field.id, value: [sourceIssue.key] };
    owned.run.persist();
    await searchable(owned, initial.state.data.type, source.id);
    await page.goto(`${activeTarget().site}/browse/${targetIssue.key}`);
    const read = fieldReadView(page, field.id);
    const loaded = await observeAction(page, 'load', () => openField(page, read), t);
    owned.run.state.loadedPromptIds = loaded.prompts.map((p) => p.id);
    owned.run.persist();
    expect(loaded.refreshAfterSave).toBe(true);
    await observeAction(
      page,
      'search',
      () =>
        editor(page)
          .getByRole('combobox', { name: 'Agent Prompts', exact: true })
          .fill(sourceIssue.key),
      installation('agent-prompts'),
    );
    await editor(page)
      .getByRole('combobox', { name: 'Agent Prompts', exact: true })
      .press('ArrowDown');
    await editor(page)
      .getByText(`${sourceIssue.key} — ${source.expected.summary}`, { exact: true })
      .click();
    await Promise.all([
      page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
      editor(page).getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    const actual = await owned.api(`/issue/${target.id}?fields=description,${field.id}`);
    expect(actual.fields.description).toEqual(linked);
    expect(actual.fields[field.id]).toEqual([sourceIssue.key]);
    await expect(
      editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true }),
    ).toHaveCount(0);
    await expandPrompts(page, 'RELOAD-SENTINEL');
    await page.screenshot({
      path: testInfo.outputPath('automatic-work-item-reload.png'),
      fullPage: true,
    });
    // A second source exercises the user's add-more/remove-after-save sequence.
    const second = await owned.propertyIssue(
      'Second reload source',
      'SECOND-RELOAD-SENTINEL',
      initial.state.data.type,
    );
    const secondIssue = await owned.api(`/issue/${second.id}?fields=summary,description`);
    await searchable(owned, initial.state.data.type, second.id);
    await openField(page, read);
    const picker = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
    await expect(picker).toBeEnabled();
    await observeAction(
      page,
      'search',
      () =>
        editor(page)
          .getByRole('combobox', { name: 'Agent Prompts', exact: true })
          .fill(secondIssue.key),
      installation('agent-prompts'),
    );
    await picker.press('ArrowDown');
    await editor(page)
      .getByText(`${secondIssue.key} — ${second.expected.summary}`, { exact: true })
      .click();
    const two = structuredClone(linked);
    two.content.at(-1).content.push(
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: `${secondIssue.key}: ${second.expected.summary}` }],
      },
      ...second.expected.description.content,
    );
    async function saveAndReload(description, keys) {
      target.expected.descriptionVariants.push(description);
      target.expected.customField = { id: field.id, value: keys };
      owned.run.persist();
      await Promise.all([
        page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
        editor(page).getByRole('button', { name: 'Save', exact: true }).click(),
      ]);
      const saved = await owned.api(`/issue/${target.id}?fields=description,${field.id}`);
      expect(saved.fields.description).toEqual(description);
      expect(saved.fields[field.id]).toEqual(keys);
    }
    await saveAndReload(two, [sourceIssue.key, secondIssue.key]);
    await openField(page, read);
    await expect(picker).toBeEnabled();
    await editor(page)
      .getByRole('button', {
        name: `${sourceIssue.key} — ${source.expected.summary}, remove ${sourceIssue.key} — ${source.expected.summary}`,
        exact: true,
      })
      .click();
    const onlySecond = structuredClone(two);
    onlySecond.content.at(-1).content.splice(0, 2);
    await saveAndReload(onlySecond, [secondIssue.key]);
  });
});

test('AP-18 board side panel: a prompt saved there reloads the board with the panel, the selection and the section', async ({
  page,
  owned,
  jiraRequest,
}, testInfo) => {
  const t = installation('agent-prompts');
  const board = await spaceBoard(jiraRequest, owned.project);
  await withReloadPreference(page, owned, async (initial) => {
    const source = await owned.propertyIssue(
      'Side panel source',
      'PANEL-SENTINEL',
      initial.state.data.type,
    );
    const target = await owned.issue('Side panel target');
    const sourceIssue = await owned.api(`/issue/${source.id}?fields=summary`);
    const targetIssue = await owned.api(`/issue/${target.id}?fields=summary`);
    const field = await agentPromptsField(owned.api);
    const linked = withPrompt(target, sourceIssue.key, source);
    target.expected.descriptionVariants = [target.expected.description, linked];
    target.expected.customField = { id: field.id, value: [sourceIssue.key] };
    owned.run.persist();
    await searchable(owned, initial.state.data.type, source.id);
    // The board shows the new work item once Jira has indexed it; open it from its card.
    const card = page.getByText(targetIssue.fields.summary, { exact: true });
    await expect(async () => {
      await page.goto(board);
      await expect(card).toBeVisible({ timeout: 10000 });
    }).toPass({ timeout: 60000, intervals: [3000] });
    await card.click();
    const panel = new RegExp(`/boards/\\d+\\?(.*&)?selectedIssue=${targetIssue.key}(&|$)`);
    await expect(page).toHaveURL(panel);
    // A card opens Jira's modal over the board; its Switch to sidebar shows the work item in the
    // board's side panel instead. Jira keeps that choice until the page loads again.
    const toSidebar = page.getByRole('button', { name: 'Switch to sidebar', exact: true });
    const sidebar = page.getByText('Jira work item', { exact: true });
    async function inSidebar() {
      await expect(toSidebar.or(sidebar)).toBeVisible({ timeout: 30000 });
      const modal = await toSidebar.isVisible();
      if (modal) await toSidebar.click();
      await expect(sidebar).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      return modal ? 'modal' : 'sidebar';
    }
    await inSidebar();
    const read = fieldReadView(page, field.id);
    const loaded = await observeAction(page, 'load', () => openField(page, read), t);
    owned.run.state.loadedPromptIds = loaded.prompts.map((p) => p.id);
    owned.run.persist();
    expect(loaded.refreshAfterSave).toBe(true);
    const picker = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
    await observeAction(page, 'search', () => picker.fill(sourceIssue.key), t);
    await picker.press('ArrowDown');
    await editor(page)
      .getByText(`${sourceIssue.key} — ${source.expected.summary}`, { exact: true })
      .click();
    await page.screenshot({ path: testInfo.outputPath('side-panel-picked.png') });
    await Promise.all([
      page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
      editor(page).getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    const actual = await owned.api(`/issue/${target.id}?fields=description,${field.id}`);
    expect(actual.fields.description).toEqual(linked);
    expect(actual.fields[field.id]).toEqual([sourceIssue.key]);
    // The reload keeps the board with the work item open (Jira reopens it in its modal), and the
    // side panel shows the saved selection and the Description's section.
    await expect(page).toHaveURL(panel);
    testInfo.annotations.push({ type: 'reload-reopens-in', description: await inSidebar() });
    await expect(read).toContainText(sourceIssue.key, { timeout: 30000 });
    await expandPrompts(page, 'PANEL-SENTINEL');
    await page.screenshot({ path: testInfo.outputPath('side-panel-reloaded.png') });
  });
});

test('AP-09 newest prompts, server search and cursor pages preserve draft selections', async ({
  page,
  owned,
  theme,
}) => {
  const t = installation('agent-prompts');
  const { type } = (await configuration(page, owned)).state.data;
  const term = `Paging${owned.run.state.runId.replaceAll('-', '')}`;
  const sources = [];
  for (let i = 0; i < 21; i++)
    sources.push(await owned.propertyIssue(`${term} prompt ${i}`, `Instructions ${i}`, type));
  const target = await owned.issue('Prompt search destination');
  const before = await owned.api(`/issue/${target.id}?fields=description`);
  const jql = `project = ${owned.project.id} AND issuetype = ${type} AND summary ~ "${term}*" AND statusCategory != Done ORDER BY created DESC, key DESC`;
  /** @type {Array<{ id: string, key: string, fields: { summary: string } }>} */
  let expected = [];
  await expect(async () => {
    const result = await owned.api('/search/jql', 'POST', {
      jql,
      fields: ['summary'],
      maxResults: 50,
    });
    expect(result.isLast).toBe(true);
    expect(result.issues).toHaveLength(21);
    expected = result.issues;
  }).toPass({ timeout: 60000, intervals: [1000, 3000] });
  await page.goto(`${activeTarget().site}/browse/${before.key}`);
  const readView = fieldReadView(page, (await agentPromptsField(owned.api)).id);
  const loaded = await observeAction(page, 'load', () => openField(page, readView), t);
  expect(loaded.prompts.map((p) => p.id)).toEqual(expected.slice(0, 10).map((p) => p.id));
  const search = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
  const first = await observeAction(page, 'search', () => search.fill(`prompt ${term}`), t);
  expect(first.prompts.map((p) => p.id)).toEqual(expected.slice(0, 10).map((p) => p.id));
  const second = await observeAction(
    page,
    'search',
    () => editor(page).getByRole('button', { name: 'Load more', exact: true }).click(),
    t,
  );
  expect(second.prompts.map((p) => p.id)).toEqual(expected.slice(10, 20).map((p) => p.id));
  const picker = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
  await picker.press('ArrowDown');
  await editor(page)
    .getByText(`${expected[19].key} — ${expected[19].fields.summary}`, { exact: true })
    .click();
  const exact = await observeAction(page, 'search', () => search.fill(expected[20].key), t);
  expect(exact.prompts.map((p) => p.id)).toEqual([expected[20].id]);
  await expect(
    editor(page).getByText(`${expected[19].key} — ${expected[19].fields.summary}`, { exact: true }),
  ).toBeVisible();
  await picker.press('ArrowDown');
  await editor(page)
    .getByText(`${expected[20].key} — ${expected[20].fields.summary}`, { exact: true })
    .click();
  await expect(
    editor(page).getByText('2/5 selected · Unsaved changes', { exact: true }),
  ).toBeVisible();
  await observeAction(page, 'search', () => search.fill(''), t);
  await expect(editor(page).getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
  await expect(
    editor(page).getByText(`${expected[19].key} — ${expected[19].fields.summary}`, { exact: true }),
  ).toBeVisible();
  await editor(page).getByRole('button', { name: 'Discard changes', exact: true }).click();
  expect((await owned.api(`/issue/${target.id}?fields=description`)).fields.description).toEqual(
    before.fields.description,
  );
  for (const name of ['Light', 'Dark']) {
    await theme(name);
    await page.goto(`${activeTarget().site}/browse/${before.key}`);
    await observeAction(page, 'load', () => openField(page, readView), t);
    await expect(editor(page).locator('html')).toHaveAttribute(
      'data-color-mode',
      name.toLowerCase(),
    );
    await textContrast(editor(page).locator('label'));
    await picker.press('ArrowDown');
    await picker.press('Enter');
    await expect(
      editor(page).getByText('1/5 selected · Unsaved changes', { exact: true }),
    ).toBeVisible();
    await picker.press('ArrowDown');
    await page.screenshot({
      path: `${activeTarget().runs}/${owned.run.state.runId}-prompt-search-${name.toLowerCase()}.png`,
      fullPage: true,
    });
    await picker.press('Escape');
    await editor(page).getByRole('button', { name: 'Discard changes', exact: true }).click();
  }
});

// The field's display condition keeps it off Jira's Create form: give the form time to add its
// fields, then neither the field's label, its frame nor Jira's own label editor is there.
async function expectFieldOff(dialog, t) {
  await dialog.page().waitForTimeout(8000);
  await expect(dialog.getByText(/^Agent Prompts/)).toHaveCount(0);
  await expect(dialog.locator(`iframe[src*="${t.appId}"][src*="${t.environmentId}"]`)).toHaveCount(
    0,
  );
  await expect(dialog.getByText('Select label', { exact: true })).toHaveCount(0);
}
/**
 * AP-14 in the owned space: Create from the top bar over the space's board makes a Task without
 * the field, then Create over that work item, which shows the field, leaves it out again.
 */
async function createWithoutField({ page, owned, theme, jiraRequest, testInfo }) {
  const t = installation('agent-prompts');
  const key = owned.project.key;
  const task = owned.project.issueTypes.find((x) => !x.subtask && x.name === 'Task');
  expect(task).toBeTruthy();
  const field = await agentPromptsField(owned.api);
  // Both fixture spaces have the field on Task's Create screen (a team-managed layout is also its
  // Create form), so only the field's display condition keeps it off the form.
  const meta = await owned.api(`/issue/createmeta/${owned.project.id}/issuetypes/${task.id}`);
  expect(meta.fields.map((f) => f.fieldId)).toContain(field.id);
  const board = await spaceBoard(jiraRequest, owned.project);

  await dismissOnboarding(page);
  await theme('Dark');
  await page.goto(board);
  const dialog = page.getByRole('dialog', { name: /^Create/ });
  let createMs;
  const created = await owned.browserIssue('Create form without the field', task.id, {
    async fill(summary) {
      await page.getByRole('banner').getByRole('button', { name: 'Create', exact: true }).click();
      await expect(
        dialog.getByRole('button', { name: new RegExp(`^Space: .*\\(${key}\\)$`) }),
      ).toBeVisible({ timeout: 30000 });
      const type = dialog.getByRole('button', { name: 'Type: Task', exact: true });
      if (!(await type.isVisible())) {
        await dialog.getByRole('button', { name: /^Type: / }).click();
        await page.getByRole('option', { name: 'Task', exact: true }).click();
      }
      await expect(type).toBeVisible();
      await dialog.getByRole('textbox', { name: 'Summary', exact: true }).fill(summary);
      await expectFieldOff(dialog, t);
      await page.screenshot({
        path: `${activeTarget().runs}/${owned.run.state.runId}-create-form.png`,
      });
    },
    async submit() {
      const started = Date.now();
      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 30000 });
      createMs = Date.now() - started;
    },
  });
  testInfo.annotations.push({ type: 'create-ms', description: String(createMs) });
  // Create closes promptly: no app field on the form for Jira to wait on.
  expect(createMs).toBeLessThan(8000);
  // browserIssue returned after Jira's Create outcome flag, which the page guard fails on if it
  // is "Created <type> with exceptions": a field that Jira couldn't save after the create.
  const x = await owned.api(`/issue/${created.id}?fields=issuetype,${field.id}`);
  expect(x.fields.issuetype.id).toBe(task.id);
  expect(x.fields[field.id] ?? null).toBeNull();

  // Create opened over a work item that shows the field leaves it out too. Closed unsaved.
  await page.goto(`${activeTarget().site}/browse/${x.key}`);
  // Development labels the field "Agent Prompts" with a DEV badge.
  await expect(page.getByText(/^Agent Prompts/).first()).toBeVisible({ timeout: 30000 });
  await page.getByRole('banner').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Summary', exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expectFieldOff(dialog, t);
  await dialog
    .getByRole('button', { name: /^Close/ })
    .first()
    .click();
  const discard = page.getByRole('button', { name: 'Discard', exact: true });
  if (await discard.isVisible().catch(() => false)) await discard.click();
  await expect(dialog).toBeHidden();
}
test('AP-14 Create form from the board in a company-managed space: the field stays off it, and the work item is created empty', async ({
  page,
  owned,
  theme,
  jiraRequest,
}, testInfo) => {
  await createWithoutField({ page, owned, theme, jiraRequest, testInfo });
});
test.describe('team-managed space', () => {
  test.use({ fixtureProfile: teamManagedFixture });
  test('AP-12 team-managed space: field placement, own prompt type, Save and Sync, setup removal', async ({
    page,
    owned,
  }, testInfo) => {
    const t = installation('agent-prompts');
    const key = owned.project.key;
    const jira = () => jiraConfiguration(owned.api, owned.project.id);
    const before = await jira();
    const prompt = before.types.find(([, name]) => name === 'Prompt')?.[0];
    expect(prompt).toBeTruthy();
    let health = await configuration(page, owned, true);
    expect(health.project.teamManaged).toBe(true);
    // An interrupted earlier run may have left the space set up.
    if (health.state.data.type) {
      await removeSetup(page, t, key);
      health = await configuration(page, owned, true);
    }
    // The site has both kinds, so the space is listed on the team-managed tab with its layouts.
    await expect(page.getByRole('tab', { name: /^Team-managed \(\d+\)$/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(
      page
        .getByRole('row')
        .filter({ has: page.getByRole('checkbox', { name: `Select ${key}`, exact: true }) })
        .getByText('Task', { exact: true }),
    ).toBeVisible();
    // The prepared space has the field on the Task layout only.
    expect(health.layouts.filter((l) => l.present).map((l) => l.name)).toEqual(['Task']);

    await details(page, key);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Agent Prompts on layouts', { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('link', { name: 'Work type settings', exact: true }),
    ).toHaveAttribute(
      'href',
      `${activeTarget().site}/jira/software/projects/${key}/settings/issuetypes`,
    );
    await configureOwnType(page, t, { key, type: prompt, name: 'Prompt' });
    health = await configuration(page, owned, true);
    expect(health.state.data.type).toBe(prompt);
    expect(health.checks.every((c) => c.ok)).toBe(true);

    // Picking, Save, retiring the prompt and Sync work as in a company-managed space.
    await snapshotJourney({ page, owned, blank: false, retire: true, testInfo });

    await configuration(page, owned, true);
    await removeSetup(page, t, key);
    health = await configuration(page, owned, true);
    expect(health.state.data.type).toBeUndefined();
    expect(health.state.data.previousTypes).toContain(prompt);
    expect(await jira()).toEqual(before);
  });
  test('AP-14 Create form from the board in a team-managed space: the field stays off it, and the work item is created empty', async ({
    page,
    owned,
    theme,
    jiraRequest,
  }, testInfo) => {
    await createWithoutField({ page, owned, theme, jiraRequest, testInfo });
  });
});
