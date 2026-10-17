import { editor, expandPrompts, openField, snapshotJourney } from './support/snapshots.mjs';
import {
  expect,
  installation,
  themeTest as test,
  textContrast,
  observeAction,
  client,
} from '@srcplugins/atlassian-forge-test-framework/jira';
import {
  activeTarget,
  fixtureProject,
  isMarker,
  markers,
} from '@srcplugins/atlassian-forge-test-framework/core';
import { agentPromptsFixture, teamManagedFixture } from './support/fixture.mjs';
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
test('NPL-04 real non-admin sessions cannot administer setup', async ({ browser, jiraRequest }) => {
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
  test(`${blank ? 'NPL-03 blank Description round-trip' : 'NPL-01 prompt snapshots, explicit Sync and precise removal'}`, async ({
    page,
    owned,
  }, testInfo) => {
    await snapshotJourney({ page, owned, blank, testInfo });
  });
}

/** Opens the space or global page, checks the owned space and returns its health. */
async function configuration(page, owned, global = false) {
  const t = installation('agent-prompts');
  if (global) await globalConfiguration(page, t);
  else await spaceSettings(page, owned.project.key);
  return checkSpace(page, t, owned.project.key, owned.project.id);
}

test('NPL-02 selected space health and cancelled modal preserve Jira', async ({ page, owned }) => {
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

test('NPL-11 details modal keeps focus, contrast and layout in dark theme and narrow width', async ({
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
  for (const [name, viewport] of [
    ['Dark', { width: 1440, height: 1100 }],
    ['Dark', { width: 640, height: 900 }],
    ['Light', { width: 640, height: 900 }],
  ]) {
    // The theme menu is in the account menu, which narrow layouts collapse.
    await page.setViewportSize({ width: 1440, height: 1100 });
    await theme(name);
    await page.setViewportSize(viewport);
    // Jira applies a new theme at once but saves it a moment later; a page loaded before the
    // save still renders the old theme, so load the space settings again until it applies.
    await expect(async () => {
      await configuration(page, owned);
      await expect(page.locator('html')).toHaveAttribute('data-color-mode', name.toLowerCase(), {
        timeout: 5000,
      });
    }).toPass({ timeout: 90000 });
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

test('NPL-05 unified global configuration checks selected spaces and selects across pages', async ({
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
        'configuration-cancel-interrupted',
        'configuration-catalog',
      ].includes(c),
    ),
  ).toBe(true);
  const after = await owned.api(`/project/${owned.project.id}`);
  expect(after.issueTypes).toEqual(before.issueTypes);
  expect(after.description).toEqual(before.description);
});

test('NPL-06 empty prompt save preserves unsaved selection during read-only recovery', async ({
  page,
  owned,
}, testInfo) => {
  const setup = await observeAction(
    page,
    'setup',
    () => spaceSettings(page, owned.project.key),
    installation('agent-prompts'),
  );
  const source = await owned.propertyIssue(
    `Empty prompt ${owned.run.state.runId.slice(0, 8)}`,
    'Ordinary prompt instructions.',
    setup.type,
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
  const field = (await owned.api('/field')).find(
    (f) => f.schema?.custom?.includes(`/${t.appId}/`) && f.name === 'Agent Prompts',
  );
  expect(field).toBeTruthy();
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
  const readView = page
    .getByRole('button', { name: /^(Agent Prompts, .*edit|Edit Agent Prompts)$/ })
    .locator('..')
    .locator('[data-component-selector="jira-issue-view-select-inline-edit-read-view-container"]');
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

test('NPL-10 an Agent Prompts section deleted in Jira is forgotten by a field-only save', async ({
  page,
  owned,
}) => {
  const t = installation('agent-prompts');
  const setup = await observeAction(page, 'setup', () => spaceSettings(page, owned.project.key), t);
  const source = await owned.propertyIssue(
    `Deleted block ${owned.run.state.runId.slice(0, 8)}`,
    'Instructions copied before the block is deleted.',
    setup.type,
  );
  const target = await owned.issue('Prompt deleted block');
  const sourceIssue = await owned.api(`/issue/${source.id}?fields=summary,issuetype`);
  const field = (await owned.api('/field')).find(
    (f) => f.schema?.custom?.includes(`/${t.appId}/`) && f.name === 'Agent Prompts',
  );
  expect(field).toBeTruthy();
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
  const readView = page
    .getByRole('button', { name: /^(Agent Prompts, .*edit|Edit Agent Prompts)$/ })
    .locator('..')
    .locator('[data-component-selector="jira-issue-view-select-inline-edit-read-view-container"]');
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
  expect(linked.description.content.some((n) => n.attrs?.localId === `npl-${target.id}`)).toBe(
    true,
  );
  // An editor deletes the whole Agent Prompts section in Jira and adds their own text.
  const deletedDescription = {
    type: 'doc',
    version: 1,
    content: [
      ...linked.description.content.filter((n) => n.attrs?.localId !== `npl-${target.id}`),
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

test('NPL-08 opt-in work item reload follows a confirmed save and restores the space preference', async ({
  page,
  owned,
}, testInfo) => {
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
    const source = await owned.propertyIssue(
      'Reload preference source',
      'RELOAD-SENTINEL',
      initial.state.data.type,
    );
    const target = await owned.issue('Reload preference target');
    const sourceIssue = await owned.api(`/issue/${source.id}?fields=summary,description`);
    const targetIssue = await owned.api(`/issue/${target.id}?fields=description`);
    const field = (await owned.api('/field')).find(
      (f) => f.schema?.custom?.includes(`/${t.appId}/`) && f.name === 'Agent Prompts',
    );
    const linked = {
      ...target.expected.description,
      content: [
        ...target.expected.description.content,
        {
          type: 'expand',
          attrs: { localId: `npl-${target.id}`, title: 'Agent Prompts' },
          content: [
            {
              type: 'heading',
              attrs: { level: 2 },
              content: [{ type: 'text', text: `${sourceIssue.key}: ${source.expected.summary}` }],
            },
            ...source.expected.description.content,
          ],
        },
      ],
    };
    target.expected.descriptionVariants = [target.expected.description, linked];
    target.expected.customField = { id: field.id, value: [sourceIssue.key] };
    owned.run.persist();
    await expect(async () => {
      const found = await owned.api('/search/jql', 'POST', {
        jql: `project = ${owned.project.id} AND issuetype = ${initial.state.data.type}`,
        fields: ['summary'],
        maxResults: 100,
      });
      expect(found.issues.some((i) => i.id === source.id)).toBe(true);
    }).toPass({ timeout: 30000, intervals: [1000, 3000] });
    await page.goto(`${activeTarget().site}/browse/${targetIssue.key}`);
    const read = page
      .getByRole('button', { name: /^(Agent Prompts, .*edit|Edit Agent Prompts)$/ })
      .locator('..')
      .locator(
        '[data-component-selector="jira-issue-view-select-inline-edit-read-view-container"]',
      );
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
    await expect(async () => {
      const found = await owned.api('/search/jql', 'POST', {
        jql: `project = ${owned.project.id} AND issuetype = ${initial.state.data.type}`,
        fields: ['summary'],
        maxResults: 100,
      });
      expect(found.issues.some((i) => i.id === second.id)).toBe(true);
    }).toPass({ timeout: 30000, intervals: [1000, 3000] });
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
  } finally {
    await preference(original);
    owned.run.state.reloadPreference.restored = true;
    owned.run.persist();
  }
});

test('NPL-09 newest prompts, server search and cursor pages preserve draft selections', async ({
  page,
  owned,
  theme,
}) => {
  const t = installation('agent-prompts');
  const setup = await observeAction(page, 'setup', () => spaceSettings(page, owned.project.key), t);
  const term = `Paging${owned.run.state.runId.replaceAll('-', '')}`;
  const sources = [];
  for (let i = 0; i < 21; i++)
    sources.push(await owned.propertyIssue(`${term} prompt ${i}`, `Instructions ${i}`, setup.type));
  const target = await owned.issue('Prompt search destination');
  const before = await owned.api(`/issue/${target.id}?fields=description`);
  const jql = `project = ${owned.project.id} AND issuetype = ${setup.type} AND summary ~ "${term}*" ORDER BY created DESC, key DESC`;
  let expected;
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
  const readView = page
    .getByRole('button', { name: /^(Agent Prompts, .*edit|Edit Agent Prompts)$/ })
    .locator('..')
    .locator('[data-component-selector="jira-issue-view-select-inline-edit-read-view-container"]');
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

test.describe('team-managed space', () => {
  test.use({ fixtureProfile: teamManagedFixture });
  test('NPL-12 team-managed space: field placement, own prompt type, Save and Sync, setup removal', async ({
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

    // Picking, Save and Sync work as in a company-managed space.
    await snapshotJourney({ page, owned, blank: false, testInfo });

    await configuration(page, owned, true);
    await removeSetup(page, t, key);
    health = await configuration(page, owned, true);
    expect(health.state.data.type).toBeUndefined();
    expect(health.state.data.previousTypes).toContain(prompt);
    expect(await jira()).toEqual(before);
  });
});
