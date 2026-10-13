// Second-site production, backed-up development lifecycle, and bidirectional tenant isolation.
// Each journey requires independent Jira baselines and exact actor/environment checks.
import assert from 'node:assert/strict';
import { runIsolationProbe } from './support/isolation.mjs';
import { readFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import {
  siteFor,
  activeTarget,
  browserTarget,
  fixtureProject,
} from '@srcplugins/atlassian-forge-test-framework/core';
import {
  lifecycleOptions,
  verifyLifecycleActors,
  verifyConfigurationPlan,
} from './support/lifecycle.mjs';
import {
  tokenRequest,
  client,
  openRun,
  installation,
  observeAction,
} from '@srcplugins/atlassian-forge-test-framework/jira';
import { expectSpaceSettingsRefused, spaceSettings } from './support/space-settings.mjs';
import { snapshotJourney, editor, resumeSavedJourney } from './support/snapshots.mjs';
import { agentPromptsFixture } from './support/fixture.mjs';

const options = lifecycleOptions(
  process.argv.slice(2),
  process.env,
  siteFor('isolation'),
  siteFor('primary'),
);
const target = installation('agent-prompts');
const directory = `${activeTarget().directory}/native-lifecycle-runs`;
const expected = JSON.parse(
  readFileSync(
    `${browserTarget(siteFor('isolation')).directory}/second-site-prerequisites/accounts.json`,
  ),
).actors;
const request = await tokenRequest();
const api = client(request);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const contexts = {};
let owned;
try {
  const secondary = process.env.NATIVE_LIFECYCLE_PROJECT === 'secondary';
  assert.ok(process.env.NATIVE_LIFECYCLE_PROJECT === undefined || secondary);
  if (secondary) assert.equal(process.env.PLUGIN_TEST_ENVIRONMENT, 'development');
  const isolation = process.env.NATIVE_TENANT_ISOLATION === '1';
  // Fixture space keys come from the private test configuration, never from source.
  const project = await api(
    `/project/${fixtureProject(
      isolation ? 'tenant-isolation' : secondary ? 'forge-sandbox' : agentPromptsFixture,
    )}`,
  );
  assert.equal(project.style, 'classic');
  const observed = {};
  for (const role of isolation ? ['owner'] : ['owner', 'nc-admin', 'nc-user']) {
    const profile = role === 'owner' ? 'admin' : role;
    const context = await browser.newContext({
      storageState: `${activeTarget().authDirectory}/${profile}.json`,
      viewport: { width: 1440, height: 1100 },
    });
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(60000);
    contexts[role] = context;
    const actorApi = client(context.request);
    const actor = await actorApi('/myself');
    const { permissions } = await actorApi(
      `/mypermissions?projectId=${project.id}&permissions=ADMINISTER,BROWSE_PROJECTS,CREATE_ISSUES,EDIT_ISSUES`,
    );
    observed[role] = {
      accountId: actor.accountId,
      permissions: Object.fromEntries(
        Object.entries(permissions).map(([k, v]) => [k, v.havePermission]),
      ),
    };
  }
  if (isolation) {
    assert.equal(observed.owner.accountId, expected.owner);
    for (const allowed of Object.values(observed.owner.permissions)) assert.equal(allowed, true);
  } else verifyLifecycleActors(expected, observed);
  assert.equal((await api('/myself')).accountId, expected.owner);
  owned = await openRun(request, agentPromptsFixture, {
    directory,
    recover: options.runId,
    profile: isolation ? 'tenant-isolation' : secondary ? 'lifecycle-secondary' : 'standard',
  });
  assert.equal(owned.project.id, project.id, 'Recovery space selection mismatch');
  const state = owned.run.state;
  if (options.runId) {
    assert.equal(state.lifecycle?.environmentId, target.environmentId);
    assert.equal(state.lifecycle?.site, activeTarget().host);
    if (isolation) assert.ok(state.lifecycle.mode.startsWith('isolation-'));
  } else {
    state.lifecycle = {
      mode: options.mode,
      site: activeTarget().host,
      environmentId: target.environmentId,
      actors: observed,
    };
    owned.run.persist();
  }
  const admin =
    await contexts[
      process.env.PLUGIN_TEST_ENVIRONMENT === 'production' ? 'nc-admin' : 'owner'
    ].newPage();
  async function health() {
    await admin.goto(
      `${activeTarget().site}/jira/settings/apps/configure/${target.appId}/${target.environmentId}`,
    );
    await expect(admin.getByRole('textbox', { name: 'Find a space', exact: true })).toBeEnabled({
      timeout: 60000,
    });
    await admin.getByRole('textbox', { name: 'Find a space', exact: true }).fill(project.key);
    const selected = admin.getByRole('checkbox', { name: `Select ${project.key}`, exact: true });
    await selected.click();
    await expect(selected).toBeChecked();
    return observeAction(
      admin,
      'settings-health',
      () => admin.getByRole('button', { name: 'Check selected', exact: true }).click(),
      target,
      project.id,
    );
  }
  async function configure(type, unlink = false) {
    await admin.getByRole('button', { name: 'Configure selected', exact: true }).click();
    if (unlink) {
      await admin.getByRole('combobox', { name: 'Prompt work type', exact: true }).click();
      await admin
        .getByRole('option', { name: 'Remove setup from selected spaces', exact: true })
        .click();
    } else {
      await admin.getByRole('combobox', { name: 'Existing type', exact: true }).click();
      await admin.getByRole('option', { name: type.name, exact: true }).click();
      await admin
        .getByRole('checkbox', { name: 'Reload work item after saving prompts', exact: true })
        .uncheck();
    }
    const plan = await observeAction(
      admin,
      'configuration-preview',
      () => admin.getByRole('button', { name: 'Review changes', exact: true }).click(),
      target,
    );
    assert.equal(plan.project.id, project.id);
    if (!unlink) verifyConfigurationPlan(plan, project.id, type.id);
    else assert.equal(plan.unlink, true);
    state.lifecycle.configurationIntent = unlink ? 'unlink' : type.id;
    owned.run.persist();
    await admin.getByRole('button', { name: 'Apply changes', exact: true }).click();
    await expect(
      admin.getByRole('heading', { name: 'Configuration complete', exact: true }),
    ).toBeVisible({ timeout: 60000 });
    await admin.getByRole('button', { name: 'Done', exact: true }).click();
  }
  if (
    ['production', 'reinstall-prepare', 'upgrade-prepare', 'isolation-prepare'].includes(
      options.mode,
    )
  ) {
    const baseline = await health();
    assert.ok(!baseline.state.data.type, 'Fixture must start unconfigured');
    state.lifecycle.baseline = baseline;
    const type = project.issueTypes.find((t) => !t.subtask && t.name === 'Story');
    assert.ok(type, 'An existing Story type is required; never create a global type here');
    state.lifecycle.type = type;
    owned.run.persist();
    await configure(type);
    const configured = await health();
    assert.equal(configured.state.data.type, type.id);
    assert.equal(configured.state.data.refreshAfterSave, false);
    state.lifecycle.configured = true;
    state.lifecycle.configuredState = configured.state;
    owned.run.persist();
    if (['reinstall-prepare', 'upgrade-prepare', 'isolation-prepare'].includes(options.mode)) {
      const page = await contexts.owner.newPage();
      state.lifecycle.reinstallBackup = await snapshotJourney({
        page,
        owned,
        blank: false,
        testInfo: { annotations: [] },
        retainSaved: true,
      });
      state.lifecycle.stage =
        options.mode === 'reinstall-prepare'
          ? 'backed-up-before-uninstall'
          : options.mode === 'upgrade-prepare'
            ? 'backed-up-before-upgrade'
            : 'isolation-source-ready';
      owned.run.persist();
      console.log(JSON.stringify({ runId: state.runId, stage: state.lifecycle.stage }));
      // Deliberately retain the journal and lock for verified uninstall and resume.
      process.exitCode = 0;
    } else {
      const userPage = await contexts['nc-user'].newPage();
      await spaceSettings(userPage, project.key);
      await expectSpaceSettingsRefused(userPage, expect);
      owned.run.check('nc-user ADMINISTER=false and space settings refused');
      for (const blank of [false, true]) {
        state.lifecycle.stage = blank ? 'blank-round-trip' : 'add-sync-remove';
        owned.run.persist();
        const testInfo = { annotations: [] };
        await snapshotJourney({ page: userPage, owned, blank, testInfo });
        owned.run.check(
          blank
            ? 'NPL-03 ordinary-user blank round trip'
            : 'NPL-01 ordinary-user add, Sync and remove',
          testInfo.annotations,
        );
      }
    }
    state.lifecycle.journeysPassed = options.mode === 'production';
    owned.run.persist();
  }
  if (!['reinstall-prepare', 'upgrade-prepare', 'isolation-prepare'].includes(options.mode)) {
    if (options.mode === 'isolation-probe') {
      await runIsolationProbe({
        api,
        request,
        owned,
        state,
        contexts,
        expected,
        options,
        target,
        health,
        configure,
        project,
      });
    }
    if (options.mode === 'upgrade-verify') {
      const backup = state.lifecycle.reinstallBackup;
      assert.ok(
        backup && state.lifecycle.upgradeReceipt,
        'Verified new deployment receipt required',
      );
      assert.deepEqual(
        (await health()).state,
        state.lifecycle.configuredState,
        'Upgrade altered app setup, revision or preference',
      );
      assert.deepEqual(
        (await api(`/issue/${backup.targetId}?fields=description,${backup.fieldId}`)).fields,
        backup.linked,
        'Upgrade changed Jira target',
      );
      assert.deepEqual(
        (await api(`/issue/${backup.sourceId}?fields=description,summary,issuetype`)).fields,
        backup.sourceFields,
      );
      owned.run.check(
        'Upgrade preserved app setup, revision, reload preference and exact Jira source/field/ADF',
      );
      const page = await contexts.owner.newPage();
      await resumeSavedJourney({ page, owned, backup });
      owned.run.check('Pre-upgrade target Sync and removal work after upgrade');
      state.lifecycle.journeysPassed = true;
      owned.run.persist();
    }
    if (options.mode === 'reinstall-verify') {
      const backup = state.lifecycle.reinstallBackup;
      assert.ok(
        backup && state.lifecycle.uninstallVerified && state.lifecycle.reinstalled,
        'Verified uninstall/reinstall receipts required',
      );
      const current = await health();
      assert.ok(!current.state.data.type, 'Reinstall unexpectedly restored configuration');
      const issueFields = () =>
        api(`/issue/${backup.targetId}?fields=description,${backup.fieldId}`).then((v) => v.fields);
      assert.deepEqual(
        await issueFields(),
        backup.linked,
        'Copied description or field changed across reinstall',
      );
      assert.deepEqual(
        (await api(`/issue/${backup.sourceId}?fields=description,summary,issuetype`)).fields,
        backup.sourceFields,
      );
      owned.run.check(
        'Jira source, copied Description and field survived reinstall; app setup absent',
      );
      state.lifecycle.configurationIntent = null;
      state.lifecycle.configuredState = null;
      owned.run.persist();
      await configure(state.lifecycle.type);
      state.lifecycle.configuredState = (await health()).state;
      owned.run.persist();
      const page = await contexts.owner.newPage();
      await page.goto(`${activeTarget().site}/browse/${backup.targetKey}`);
      const readView = page
        .getByRole('button', { name: /^(Agent Prompts, .*edit|Edit Agent Prompts)$/ })
        .locator('..')
        .locator(
          '[data-component-selector="jira-issue-view-select-inline-edit-read-view-container"]',
        );
      const loaded = await observeAction(
        page,
        'load',
        () => readView.click({ position: { x: 2, y: 2 } }),
        target,
      );
      assert.deepEqual(loaded.ids, [], 'Reinstall must not adopt old selections');
      const combo = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
      await combo.fill(backup.sourceKey);
      await combo.press('ArrowDown');
      await editor(page)
        .getByText(new RegExp(`^${backup.sourceKey} —`))
        .click();
      await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
      await expect(
        editor(page).getByText(
          'The description has an Agent Prompts section the app did not save. Review the description before saving.',
          { exact: true },
        ),
      ).toBeVisible({ timeout: 45000 });
      assert.deepEqual(await issueFields(), backup.linked, 'Rejected adoption changed Jira');
      owned.run.check('Untracked copy adoption refused with exact Jira baseline unchanged');
      // Explicit fixture repair is a Jira edit, never claimed as automatic app adoption.
      const resource = state.resources.find((r) => r.id === backup.targetId);
      const repaired = structuredClone(backup.linked.description);
      repaired.content = repaired.content.filter(
        (n) => n.attrs?.localId !== `npl-${backup.targetId}`,
      );
      resource.expected.descriptionVariants.push(repaired);
      owned.run.persist();
      await api(`/issue/${backup.targetId}`, 'PUT', { fields: { description: repaired } });
      assert.deepEqual((await issueFields()).description, repaired);
      await page.reload();
      await observeAction(page, 'load', () => readView.click({ position: { x: 2, y: 2 } }), target);
      await combo.fill(backup.sourceKey);
      await combo.press('ArrowDown');
      await editor(page)
        .getByText(new RegExp(`^${backup.sourceKey} —`))
        .click();
      await observeAction(
        page,
        'save',
        () => editor(page).getByRole('button', { name: 'Save', exact: true }).click(),
        target,
      );
      assert.deepEqual(await issueFields(), backup.linked);
      await editor(page)
        .getByRole('button', { name: /remove.*Error handling/i })
        .click();
      await observeAction(
        page,
        'save',
        () => editor(page).getByRole('button', { name: 'Save', exact: true }).click(),
        target,
      );
      const cleared = await issueFields();
      assert.deepEqual(cleared.description, repaired);
      assert.deepEqual(cleared[backup.fieldId] ?? [], []);
      resource.expected.customField = { id: backup.fieldId, value: cleared[backup.fieldId] };
      owned.run.persist();
      owned.run.check(
        'Explicit Jira copy repair allows adding and removing all prompts on original target',
      );
      await snapshotJourney({ page, owned, blank: false, testInfo: { annotations: [] } });
      owned.run.check('Fresh add, Sync and remove work after reconfiguration');
      state.lifecycle.journeysPassed = true;
      owned.run.persist();
    }
    // Read before restoring configuration; do not clear another actor's replacement setup.
    const current = state.lifecycle.configurationIntent ? await health() : null;
    if (current?.state.data.type) {
      assert.ok(state.lifecycle.configurationIntent, 'No owned configuration intent');
      assert.equal(current.state.data.type, state.lifecycle.type.id);
      assert.deepEqual(
        current.state,
        state.lifecycle.configuredState,
        'Configuration changed or its write is unresolved; inspect before cleanup',
      );
      await configure(null, true);
      assert.ok(!(await health()).state.data.type, 'Configuration cleanup not confirmed');
    }
    state.lifecycle.configurationClean = true;
    owned.run.persist();
    await owned.cleanup();
    console.log(
      JSON.stringify({
        runId: state.runId,
        mode: options.mode,
        status: state.status,
        checks: state.checks,
      }),
    );
  }
} catch (error) {
  if (owned) {
    owned.run.state.lifecycle.error = error.message;
    owned.run.persist();
    console.error(
      `Lifecycle stopped; inspect journal ${owned.run.state.runId} before cleanup. No write was retried.`,
    );
  }
  throw error;
} finally {
  await browser.close();
  await request.dispose();
}
