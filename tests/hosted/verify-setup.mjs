// Hosted acceptance for space setup on an owned development site.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { verifyTypeMappings } from './support/agent-prompts-setup.mjs';
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
import {
  activeTarget,
  fixtureProject,
  siteFor,
} from '@srcplugins/atlassian-forge-test-framework/core';
import {
  tokenRequest,
  client,
  installation,
  observeAction,
  dismissOnboarding,
} from '@srcplugins/atlassian-forge-test-framework/jira';
import { spaceSettings } from './support/space-settings.mjs';
import { agentPromptsFixture, setupRunSpace } from './support/fixture.mjs';
import { setupCleanup } from './support/setup-cleanup.mjs';
import {
  chooseScreenTypes,
  nextStep,
  reviewConfiguration,
  reviewStep,
} from './support/configuration-dialog.mjs';

const [mode, recoveryId] = process.argv.slice(2);
const fault = process.env.NATIVE_SETUP_FAULT;
assert.ok(!fault || ['concurrent', 'lost-response'].includes(fault));
// Abandoned mode: admin A leaves a reviewed configuration ready after its first space; a second
// administrator (saved admin2 session) must be able to review and release it.
const abandoned = process.env.NATIVE_SETUP_ABANDONED === '1';
// Bulk mode: configure both spaces with an existing type, reload off then on, then remove setup from
// both; screens of one chosen work type gain and lose the field, and a field placed by hand is kept.
const bulk = process.env.NATIVE_SETUP_BULK === '1';
// Rejected mode: a type with the reviewed new name is created directly in Jira before Apply.
const rejected = process.env.NATIVE_SETUP_REJECTED === '1';
// Shared screens mode: three spaces use the first space's screens; two are configured.
const sharedScreens = process.env.NATIVE_SETUP_SCREENS === '1';
// Steps mode: ten new work types in the first space get their own edit and view screens, so its
// 20 screen changes cannot fit one step. The second space's default screens are the first new
// type's, and an unused screen scheme names one of the new screens.
const steps = process.env.NATIVE_SETUP_STEPS === '1';
assert.ok(
  [abandoned, bulk, rejected, sharedScreens, steps].filter(Boolean).length <= 1,
  'Choose one mode',
);
assert.ok(
  !(abandoned || bulk || rejected || sharedScreens || steps) ||
    (!fault && process.env.NATIVE_SETUP_SHARED !== '1'),
);
assert.ok(mode === 'run' || (mode === 'cleanup' && /^[0-9a-f-]{36}$/.test(recoveryId)));
assert.equal(activeTarget().host, siteFor('primary'));
assert.equal(
  process.env.PLUGIN_TEST_ENVIRONMENT ?? 'development',
  'development',
  'This runner requires development',
);
assert.equal(process.env.NATIVE_SETUP_TESTS, '1', 'Explicit NATIVE_SETUP_TESTS=1 required');
const directory = `${activeTarget().directory}/native-setup-runs`;
mkdirSync(directory, { recursive: true });
// A suite names the run, so it can clean this run up after a failure.
const id = mode === 'run' ? (process.env.FORGE_TEST_RUN_ID ?? randomUUID()) : recoveryId;
assert.match(id, /^[0-9a-f-]{36}$/);
const path = `${directory}/${id}.json`;
const lock = `${directory}/setup.lock`;
if (existsSync(lock)) {
  const holder = JSON.parse(readFileSync(lock, 'utf8'));
  assert.equal(mode, 'cleanup', 'Resolve the previous setup run first');
  assert.equal(holder.id, id);
  let alive = true;
  try {
    process.kill(holder.pid, 0);
  } catch (e) {
    if (e.code === 'ESRCH') alive = false;
  }
  assert.equal(alive, false, 'Setup process still alive or cannot be checked');
  unlinkSync(lock);
}
for (const name of readdirSync(directory).filter((x) => x.endsWith('.json'))) {
  const previous = JSON.parse(readFileSync(`${directory}/${name}`, 'utf8'));
  assert.ok(previous.clean || previous.id === id, 'Resolve the previous setup journal first');
}
writeFileSync(lock, JSON.stringify({ id, pid: process.pid }), { flag: 'wx', mode: 0o600 });
const j =
  mode === 'cleanup'
    ? JSON.parse(readFileSync(path, 'utf8'))
    : {
        id,
        site: activeTarget().site,
        shared: process.env.NATIVE_SETUP_SHARED === '1',
        sharedScreens,
        steps,
        fixtures: (process.env.NATIVE_SETUP_SHARED === '1' || sharedScreens
          ? [0, 1, 2]
          : [0, 1]
        ).map((n) => ({
          key: `NP${id.replaceAll('-', '').slice(0, 7).toUpperCase()}${n}`,
          marker: setupRunSpace(id, n),
        })),
        typeName: `Setup ${id}`,
        stage: 'preflight',
        clean: false,
      };
assert.equal(j.id, id);
assert.equal(j.site, activeTarget().site);
assert.equal(j.fixtures.length, j.shared || j.sharedScreens ? 3 : 2);
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
let browser;
const stage = (value) => {
  j.stage = value;
  persist();
};
async function applyWithFault(page, target) {
  const pattern = '**/gateway/api/graphql/**';
  let hits = 0;
  let forwards = 0;
  let failed = false;
  const pending = [];
  await page.route(pattern, async (route) => {
    let input;
    try {
      input = route.request().postDataJSON()?.variables?.input;
    } catch {
      return route.continue();
    }
    if (
      input?.payload?.call?.functionKey !== 'configuration-advance' ||
      input.payload.context?.environmentId !== target.environmentId ||
      !input.extensionId?.includes(target.appId)
    )
      return route.continue();
    hits++;
    if (hits > 1) return route.continue();
    const settled = Promise.allSettled(
      Array.from({ length: fault === 'concurrent' ? 2 : 1 }, () => {
        forwards++;
        return route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 60000 });
      }),
    );
    pending.push(settled);
    try {
      const responses = await settled;
      const [first] = responses;
      if (responses.some((x) => x.status !== 'fulfilled') || first.status !== 'fulfilled') {
        failed = true;
        return await route.abort('failed');
      }
      if (fault === 'lost-response') await route.abort('failed');
      else await route.fulfill({ response: first.value });
    } catch {
      failed = true;
      await route.abort('failed');
    }
  });
  try {
    await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
    await expect.poll(() => hits).toBeGreaterThanOrEqual(1);
    await Promise.allSettled(pending);
    await expect(
      page
        .getByRole('button', { name: 'Check saved progress', exact: true })
        .or(page.getByRole('button', { name: 'Done', exact: true })),
    ).toBeEnabled();
    assert.equal(failed, false);
    assert.ok(hits >= 1 && hits <= 2);
    assert.equal(forwards, fault === 'concurrent' ? 2 : 1);
    j.fault = { mode: fault, hits, forwards };
    persist();
  } finally {
    await Promise.allSettled(pending);
    await page.unroute(pattern);
  }
}
// The screens a fixture space's work type uses for the given operations. The template gives each
// space its own schemes and screens; in shared screens mode every space uses the first space's.
// Anything else stops the run before the app changes a screen.
async function typeScreens(f, typeId, ops = ['edit', 'view']) {
  const owner = j.sharedScreens ? j.fixtures[0] : f;
  const members = j.sharedScreens ? j.fixtures : [f];
  const assigned = await pages(`/issuetypescreenscheme/project?projectId=${f.project.id}`);
  assert.equal(assigned.length, 1);
  const itss = assigned[0].issueTypeScreenScheme;
  assert.ok(itss.name.startsWith(`${owner.key}:`), 'Fixture screens must be the run’s own');
  assert.deepEqual(
    (await pages(`/issuetypescreenscheme/${itss.id}/project`)).map((p) => String(p.id)).sort(),
    members.map((m) => m.project.id).sort(),
  );
  const rows = await pages(`/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${itss.id}`);
  const row =
    rows.find((m) => m.issueTypeId === typeId) ?? rows.find((m) => m.issueTypeId === 'default');
  const scheme = (
    await pages(`/screenscheme?id=${row.screenSchemeId}&expand=issueTypeScreenSchemes`)
  )[0];
  assert.ok(scheme.name.startsWith(`${owner.key}:`));
  assert.deepEqual(
    scheme.issueTypeScreenSchemes.values.map((x) => String(x.id)),
    [String(itss.id)],
  );
  const ids = [...new Set(ops.map((op) => String(scheme.screens[op] ?? scheme.screens.default)))];
  for (const screen of ids) {
    const found = await pages(`/screens?id=${screen}`);
    assert.equal(found.length, 1);
    assert.ok(found[0].name.startsWith(`${owner.key}:`), 'Fixture screens must be the run’s own');
  }
  return ids;
}
/** A level-0 work type other than the prompt type whose edit and view screens are not the prompt
 * type's create screen, so the field and the create screen fix are observed separately. */
async function screenType(f, issueTypes, prompt) {
  const create = await typeScreens(f, prompt.id, ['create']);
  for (const type of issueTypes.filter(
    (x) => !x.subtask && x.id !== prompt.id && x.hierarchyLevel === 0,
  )) {
    const screens = await typeScreens(f, type.id);
    if (!screens.some((s) => create.includes(s))) return { type, screens, create: create[0] };
  }
  throw Error('Template work type with its own screens required');
}
try {
  const owner = await api('/myself');
  if (j.actor) assert.equal(owner.accountId, j.actor);
  else {
    j.actor = owner.accountId;
    persist();
  }
  assert.equal(
    (await api('/mypermissions?permissions=ADMINISTER')).permissions.ADMINISTER.havePermission,
    true,
  );
  if (mode === 'run') {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ storageState: activeTarget().auth });
    assert.equal((await client(context.request)('/myself')).accountId, owner.accountId);
    let page = await context.newPage();
    page.setDefaultTimeout(30000);
    const t = installation('agent-prompts');
    // Space configuration renders only for an eligible space, so opening it on the retained
    // fixture checks app eligibility before any creation. Opening it also returns saved progress.
    const before = await observeAction(
      page,
      'configuration-status',
      () => spaceSettings(page, fixtureProject(agentPromptsFixture)),
      t,
    );
    assert.ok(
      !before || ['complete', 'stopped'].includes(before.data.status),
      'Resolve saved configuration before fixture creation',
    );

    for (const [index, f] of j.fixtures.entries()) {
      assert.equal(await api(`/project/${f.key}`), null);
      stage(`create-space-${index}`);
      f.projectIntent = true;
      persist();
      f.project = await api('/project', 'POST', {
        key: f.key,
        name: `Setup run ${id.slice(0, 8)} ${index}`,
        description: f.marker,
        projectTypeKey: 'software',
        projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic',
        leadAccountId: owner.accountId,
        assigneeType: 'UNASSIGNED',
      });
      f.project.id = String(f.project.id);
      persist();
      const assigned = await pages(`/issuetypescheme/project?projectId=${f.project.id}`);
      assert.equal(assigned.length, 1);
      f.scheme = assigned[0].issueTypeScheme;
      persist();
      await emptyProject(f);
    }
    const primary = j.fixtures[0];
    const original = await emptyProject(primary);
    if (j.shared) {
      stage('share-owned-scheme');
      for (const f of j.fixtures.slice(1)) {
        await emptyProject(f);
        await emptyProject(primary);
        f.shareIntent = true;
        persist();
        await api('/issuetypescheme/project', 'PUT', {
          issueTypeSchemeId: primary.scheme.id,
          projectId: f.project.id,
        });
        const assigned = await pages(`/issuetypescheme/project?projectId=${f.project.id}`);
        assert.equal(assigned.length, 1);
        assert.equal(assigned[0].issueTypeScheme.id, primary.scheme.id);
        await emptyProject(f);
      }
    }
    const defaults = (await pages('/issuetypescheme')).filter((x) => x.isDefault);
    assert.equal(defaults.length, 1);
    j.defaultScheme = defaults[0].id;
    j.mappingBaseline = await mappings();
    persist();
    /** Opens `f`'s space settings page, which lists every space, and checks `f`'s health. */
    async function openConfiguration(f = primary) {
      // Jira can fail the space list's read (HTTP 5xx). The page writes nothing on load, so it is
      // loaded again; after two reloads a failure stands.
      const select = page.getByRole('checkbox', { name: `Select ${f.key}`, exact: true });
      const failed = page.getByText(/^Jira request failed \(HTTP 5\d\d\)/);
      for (let attempt = 0; ; attempt++) {
        await spaceSettings(page, f.key);
        const search = page.getByRole('textbox', { name: 'Find a space', exact: true });
        await expect(search).toBeEnabled({ timeout: 60000 });
        await search.fill(f.key);
        await expect(select.or(failed).first()).toBeVisible();
        if (attempt === 2 || !(await failed.isVisible())) break;
        await page.waitForTimeout(5000);
      }
      await select.click();
      const health = await observeAction(
        page,
        'settings-health',
        () => page.getByRole('button', { name: 'Check selected', exact: true }).click(),
        t,
        f.project.id,
      );
      await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
      return health;
    }
    async function dialog(query) {
      await page.getByRole('textbox', { name: 'Find a space', exact: true }).fill(query);
      await expect(
        page.getByRole('table', { name: 'Space configuration', exact: true }).getByRole('row'),
      ).toHaveCount(query === primary.key ? 2 : j.fixtures.length + 1);
      const all = page.getByRole('checkbox', { name: 'Select all matching spaces', exact: true });
      await all.click();
      await expect(all).toBeChecked();
      if ((j.shared || j.sharedScreens) && query !== primary.key) {
        const excluded = page
          .getByRole('table', { name: 'Space configuration', exact: true })
          .getByRole('row')
          .filter({ hasText: j.fixtures[2].key })
          .getByRole('checkbox');
        await excluded.click();
        await expect(excluded).not.toBeChecked();
      }
      return observeAction(
        page,
        'configuration-catalog',
        () => page.getByRole('button', { name: 'Configure selected', exact: true }).click(),
        t,
      );
    }
    async function chooseExisting(name) {
      await page.getByRole('combobox', { name: 'Existing type', exact: true }).click();
      await page.getByRole('option', { name, exact: true }).click();
    }
    async function finish() {
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
    async function acknowledgeShared(required = false) {
      const ack = page.getByRole('checkbox', {
        name: 'I approve the shared scheme changes for all listed affected spaces.',
        exact: true,
      });
      if (required) await expect(ack).toBeVisible();
      if (required || (await ack.isVisible())) {
        await expect(
          page.getByRole('button', { name: 'Apply changes', exact: true }),
        ).toBeDisabled();
        await expect(
          page.getByRole('table', { name: 'Shared scheme impact', exact: true }),
        ).toBeVisible();
        await ack.click();
        await expect(ack).toBeChecked();
      }
    }
    async function applyExisting(name) {
      await dialog(primary.key);
      await chooseExisting(name);
      const plan = await reviewConfiguration(page, t);
      await acknowledgeShared(plan.attach && plan.scheme.projectIds.length > 1);
      await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
      await finish();
      return plan;
    }
    async function chooseMode(name) {
      await page.getByRole('combobox', { name: 'Prompt work type', exact: true }).click();
      await page.getByRole('option', { name, exact: true }).click();
    }
    async function configured(f) {
      const health = await openConfiguration(f);
      return {
        type: health.state?.data?.type,
        reload: health.state?.data?.refreshAfterSave === true,
        screens: health.state?.data?.screenTypes ?? [],
      };
    }
    const next = () => nextStep(page);
    const review = () => reviewStep(page);
    const modal = page.getByRole('dialog');
    // Each review line is a lozenge followed by its text, so a line is matched by its text alone.
    const line = (text) => modal.getByText(text, { exact: true });
    const apply = () => page.getByRole('button', { name: 'Apply changes', exact: true }).click();
    // Apply waits for the shared screen approval whenever a reviewed screen change reaches
    // another space, and never asks for it otherwise.
    async function acknowledgeScreens(required) {
      const ack = page.getByRole('checkbox', {
        name: 'I approve the shared screen changes for all listed affected spaces.',
        exact: true,
      });
      if (!required) return expect(ack).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeDisabled();
      await ack.click();
      await expect(ack).toBeChecked();
    }
    const choose = (f, name) => chooseScreenTypes(page, f.key, name);
    async function appField() {
      const field = (await api('/field')).find(
        (x) => x.schema?.custom?.includes(`/${t.appId}/`) && x.name === 'Agent Prompts',
      );
      assert.ok(field, 'Agent Prompts field required');
      return field.id;
    }
    const task = original.issueTypes.find((x) => x.name === 'Task' && !x.subtask);
    assert.ok(task);
    if (bulk) {
      j.field = await appField();
      // Task is the prompt type; another work type with its own screens gets the field.
      const own = await screenType(primary, original.issueTypes, task);
      const second = await screenType(j.fixtures[1], original.issueTypes, task);
      assert.equal(second.type.id, own.type.id);
      const kind = own.type;
      // Journaled before any write, so cleanup removes the field from all of them.
      j.screens = [...own.screens, ...second.screens];
      j.manualScreen = second.screens[0];
      j.createScreen = own.create;
      j.requiredRemoved = [];
      persist();
      for (const screen of j.screens) assert.equal(await fieldTab(screen), undefined);
      stage('bulk-manual-field');
      // An administrator already placed the field on the second space's screen by hand.
      const manualTab = String((await api(`/screens/${j.manualScreen}/tabs`))[0].id);
      j.manualIntent = true;
      persist();
      await api(`/screens/${j.manualScreen}/tabs/${manualTab}/fields`, 'POST', {
        fieldId: j.field,
      });
      assert.equal(await fieldTab(j.manualScreen), manualTab);
      stage('bulk-create-screen');
      // The first space's prompt create screen loses Description, and Summary if Jira allows it.
      for (const required of ['description', 'summary']) {
        const tab = await fieldTab(j.createScreen, required);
        assert.ok(tab, `${required} on the create screen`);
        const entry = { screen: j.createScreen, tab, field: required };
        j.requiredRemoved.push(entry);
        persist();
        try {
          await api(`/screens/${j.createScreen}/tabs/${tab}/fields/${required}`, 'DELETE');
        } catch (e) {
          if (required !== 'summary' || !e.definitiveRejection) throw e;
          entry.rejected = true;
          persist();
        }
        assert.equal(await fieldTab(j.createScreen, required), entry.rejected ? tab : undefined);
      }
      const restored = j.requiredRemoved.filter((x) => !x.rejected);
      const ownFieldOn = async (present) => {
        for (const screen of own.screens)
          assert.equal(!!(await fieldTab(screen)), present, `Field on ${screen}`);
        assert.equal(await fieldTab(j.manualScreen), manualTab, 'Field placed by hand is kept');
      };
      for (const reload of [false, true]) {
        stage(`bulk-configure-${reload ? 'reload' : 'plain'}`);
        await openConfiguration();
        await dialog(primary.key.slice(0, -1));
        await chooseExisting(task.name);
        const choice = `${reload ? 'On' : 'Off'} for all selected spaces`;
        const picker = page.getByRole('combobox', {
          name: 'Reload work item after saving prompts',
          exact: true,
        });
        await picker.click();
        await page.getByRole('option', { name: choice, exact: true }).click();
        await next();
        if (!reload) for (const f of j.fixtures) await choose(f, kind.name);
        await review();
        if (!reload) {
          // Every screen except the one where the field was placed by hand.
          await expect(line(/^Agent Prompts to /)).toHaveCount(
            own.screens.length + second.screens.length - 1,
          );
          await expect(line(/^Description to /)).toHaveCount(1);
          await expect(line(/^Summary to /)).toHaveCount(restored.length - 1);
        } else await expect(line('No changes')).toHaveCount(1);
        await expect(line(/^Agent Prompts on .+ \(added outside the app\)$/)).toHaveCount(1);
        // Each space's screens are its own, so no shared screen approval is asked for.
        await acknowledgeScreens(false);
        await expect(modal.getByText('Reload after saving', { exact: true })).toBeVisible();
        await expect(modal.getByText(reload ? 'On' : 'Off', { exact: true })).toBeVisible();
        await apply();
        const done = await finish();
        assert.equal(done.data.status, 'complete');
        assert.equal(done.data.entries.length, 2);
        assert.deepEqual(done.data.screenEffects ?? [], []);
        for (const f of j.fixtures)
          assert.deepEqual(await configured(f), { type: task.id, reload, screens: [kind.id] });
        await ownFieldOn(true);
        for (const x of j.requiredRemoved) assert.ok(await fieldTab(x.screen, x.field), x.field);
        assert.deepEqual(known(await mappings()), j.mappingBaseline);
      }
      stage('bulk-remove-setup-cancel');
      await openConfiguration();
      await dialog(primary.key.slice(0, -1));
      await chooseMode('Remove setup from selected spaces');
      await expect(
        page.getByRole('combobox', { name: 'Reload work item after saving prompts', exact: true }),
      ).toHaveCount(0);
      await review();
      await expect(line('App setup and preferences')).toHaveCount(2);
      // Only the screens the app changed; the field placed by hand is not the app's to remove.
      await expect(line(/^Agent Prompts from /)).toHaveCount(
        own.screens.length + second.screens.length - 1,
      );
      await expect(line('No changes')).toHaveCount(0);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      for (const f of j.fixtures)
        assert.deepEqual(await configured(f), { type: task.id, reload: true, screens: [kind.id] });
      await ownFieldOn(true);
      stage('bulk-remove-setup');
      await openConfiguration();
      await dialog(primary.key.slice(0, -1));
      await chooseMode('Remove setup from selected spaces');
      await review();
      await apply();
      const removed = await finish();
      assert.equal(removed.data.input.unlink, true);
      assert.ok(removed.data.entries.every((e) => e.status === 'done'));
      for (const f of j.fixtures)
        assert.deepEqual(await configured(f), { type: undefined, reload: false, screens: [] });
      await ownFieldOn(false);
      assert.deepEqual(known(await mappings()), j.mappingBaseline);
      for (const f of j.fixtures) await emptyProject(f);
      stage('bulk-reconfigure');
      await openConfiguration();
      await dialog(primary.key.slice(0, -1));
      await chooseExisting(task.name);
      await next();
      await review();
      // Removing setup cleared the work types, so reconfiguring changes no screen.
      await expect(line('No changes')).toHaveCount(2);
      // The reload choice starts on keep; removal cleared the preference, so it stays off.
      await expect(modal.getByText('Keep each space’s setting', { exact: true })).toBeVisible();
      await apply();
      await finish();
      for (const f of j.fixtures)
        assert.deepEqual(await configured(f), { type: task.id, reload: false, screens: [] });
      await ownFieldOn(false);
      assert.deepEqual(known(await mappings()), j.mappingBaseline);
      stage('bulk-select-type');
      await openConfiguration();
      await dialog(primary.key);
      await chooseExisting(task.name);
      await next();
      await choose(primary, kind.name);
      await review();
      await expect(line(/^Agent Prompts to /)).toHaveCount(own.screens.length);
      await apply();
      await finish();
      assert.deepEqual((await configured(primary)).screens, [kind.id]);
      await ownFieldOn(true);
      stage('bulk-deselect-type');
      await openConfiguration();
      await dialog(primary.key);
      await chooseExisting(task.name);
      await next();
      // The picker starts on the saved selection, so emptying it notes what it was.
      await choose(primary);
      await expect(modal.getByText(`Was: ${kind.name}`, { exact: true })).toBeVisible();
      await review();
      await expect(line(/^Agent Prompts from /)).toHaveCount(own.screens.length);
      await apply();
      await finish();
      assert.deepEqual((await configured(primary)).screens, []);
      assert.deepEqual((await configured(j.fixtures[1])).screens, []);
      await ownFieldOn(false);
      assert.deepEqual(known(await mappings()), j.mappingBaseline);
      j.bulkVerified = {
        projects: 2,
        reloadOff: true,
        reloadOn: true,
        setupRemoved: true,
        screenType: kind.name,
        screensAdded: own.screens.length,
        screensRemoved: own.screens.length,
        manualFieldKept: true,
        createScreenRestored: restored.map((x) => x.field),
        typeDeselected: true,
      };
      j.passed = true;
      persist();
    } else if (sharedScreens) {
      j.field = await appField();
      stage('share-owned-screens');
      const assigned = await pages(
        `/issuetypescreenscheme/project?projectId=${primary.project.id}`,
      );
      assert.equal(assigned.length, 1);
      const itss = assigned[0].issueTypeScreenScheme;
      assert.ok(itss.name.startsWith(`${primary.key}:`));
      for (const f of j.fixtures.slice(1)) {
        await emptyProject(f);
        f.screenShareIntent = true;
        persist();
        await api('/issuetypescreenscheme/project', 'PUT', {
          issueTypeScreenSchemeId: String(itss.id),
          projectId: f.project.id,
        });
        const now = await pages(`/issuetypescreenscheme/project?projectId=${f.project.id}`);
        assert.equal(now.length, 1);
        assert.equal(String(now[0].issueTypeScreenScheme.id), String(itss.id));
      }
      const own = await screenType(primary, original.issueTypes, task);
      for (const f of j.fixtures.slice(1))
        assert.deepEqual((await typeScreens(f, own.type.id)).sort(), [...own.screens].sort());
      const kind = own.type;
      j.screens = own.screens;
      persist();
      const fieldOn = async (present) => {
        for (const screen of own.screens)
          assert.equal(!!(await fieldTab(screen)), present, `Field on ${screen}`);
      };
      await fieldOn(false);
      const impact = page.getByRole('table', { name: 'Shared screen impact', exact: true });
      const outside = impact.getByRole('row').filter({ hasText: j.fixtures[2].key });
      stage('shared-screens-configure');
      await openConfiguration();
      await dialog(primary.key.slice(0, -1));
      await chooseExisting(task.name);
      await next();
      for (const f of j.fixtures.slice(0, 2)) await choose(f, kind.name);
      await review();
      // Every screen change lists all three spaces, including the one not being configured.
      await expect(impact.getByRole('row')).toHaveCount(1 + Math.min(5, 3 * own.screens.length));
      await expect(outside.first()).toContainText('Agent Prompts added');
      await acknowledgeScreens(true);
      await apply();
      const done = await finish();
      assert.equal(done.data.status, 'complete');
      assert.equal(done.data.entries.length, 2);
      // Added once, by the first space; the second space joined the change.
      assert.deepEqual(
        (done.data.screenEffects ?? [])
          .filter((e) => e.field === j.field)
          .map((e) => `${e.screen.id}:${e.action}`)
          .sort(),
        own.screens.map((screen) => `${screen}:add`).sort(),
      );
      for (const f of j.fixtures.slice(0, 2))
        assert.deepEqual((await configured(f)).screens, [kind.id]);
      assert.equal((await configured(j.fixtures[2])).type, undefined);
      await fieldOn(true);
      stage('shared-screens-deselect');
      await openConfiguration();
      await dialog(primary.key);
      await chooseExisting(task.name);
      await next();
      await choose(primary);
      await review();
      // The second space still uses the screens, so the field stays and nothing needs approval.
      await expect(line(/^Agent Prompts on .+ \(another configured space uses it\)$/)).toHaveCount(
        own.screens.length,
      );
      await acknowledgeScreens(false);
      await apply();
      await finish();
      assert.deepEqual((await configured(primary)).screens, []);
      assert.deepEqual((await configured(j.fixtures[1])).screens, [kind.id]);
      await fieldOn(true);
      stage('shared-screens-remove-setup');
      await openConfiguration();
      await dialog(primary.key.slice(0, -1));
      await chooseMode('Remove setup from selected spaces');
      await review();
      // Only the second space still had the field on the screens, so it removes it.
      await expect(line(/^Agent Prompts from /)).toHaveCount(own.screens.length);
      await expect(outside.first()).toContainText('Agent Prompts removed');
      await acknowledgeScreens(true);
      await apply();
      const removed = await finish();
      assert.equal(removed.data.input.unlink, true);
      assert.ok(removed.data.entries.every((e) => e.status === 'done'));
      for (const f of j.fixtures.slice(0, 2))
        assert.deepEqual(await configured(f), { type: undefined, reload: false, screens: [] });
      await fieldOn(false);
      assert.deepEqual(known(await mappings()), j.mappingBaseline);
      j.sharedScreensVerified = {
        selected: 2,
        affected: 3,
        screensAdded: own.screens.length,
        keptForOtherSpace: true,
        screensRemoved: own.screens.length,
      };
      j.passed = true;
      persist();
    } else if (steps) {
      j.field = await appField();
      const second = j.fixtures[1];
      async function itssOf(f) {
        const assigned = await pages(`/issuetypescreenscheme/project?projectId=${f.project.id}`);
        assert.equal(assigned.length, 1);
        const itss = assigned[0].issueTypeScreenScheme;
        assert.ok(itss.name.startsWith(`${f.key}:`), 'Fixture screens must be the run’s own');
        assert.deepEqual(
          (await pages(`/issuetypescreenscheme/${itss.id}/project`)).map((p) => String(p.id)),
          [f.project.id],
        );
        return String(itss.id);
      }
      j.steps = {
        marker: `Setup run ${id} screen fixture.`,
        itss: [await itssOf(primary), await itssOf(second)],
        types: Array.from({ length: 10 }, (_, n) => ({ name: `Steps ${id} ${n}` })),
        screens: Array.from({ length: 20 }, (_, n) => ({
          name: `${primary.key}: steps ${n >> 1} ${n % 2 ? 'view' : 'edit'}`,
        })),
        schemes: [
          ...Array.from({ length: 10 }, (_, n) => ({ name: `${primary.key}: steps ${n}` })),
          { name: `${primary.key}: steps unused` },
        ],
      };
      persist();
      const s = j.steps;
      stage('steps-types');
      assert.ok(!(await api('/issuetype')).some((x) => x.name.startsWith(`Steps ${id}`)));
      for (const x of s.types) {
        x.intent = true;
        persist();
        const created = await api('/issuetype', 'POST', {
          name: x.name,
          description: s.marker,
          hierarchyLevel: 0,
        });
        x.id = String(created.id);
        persist();
      }
      await emptyProject(primary);
      s.attachIntent = true;
      persist();
      await api(`/issuetypescheme/${primary.scheme.id}/issuetype`, 'PUT', {
        issueTypeIds: s.types.map((x) => x.id),
      });
      const offered = (await emptyProject(primary)).issueTypes.map((x) => String(x.id));
      for (const x of s.types) assert.ok(offered.includes(x.id), `${x.name} in the first space`);
      stage('steps-screens');
      for (const x of s.screens) {
        assert.ok(
          !(await pages(`/screens?queryString=${encodeURIComponent(x.name)}`)).some(
            (v) => v.name === x.name,
          ),
        );
        x.intent = true;
        persist();
        x.id = String((await api('/screens', 'POST', { name: x.name, description: s.marker })).id);
        persist();
        // Jira gives a new screen one field tab; add it only where Jira did not.
        if (!(await api(`/screens/${x.id}/tabs`)).length)
          await api(`/screens/${x.id}/tabs`, 'POST', { name: 'Field Tab' });
        assert.equal((await api(`/screens/${x.id}/tabs`)).length, 1);
      }
      // Journaled before any app write, so cleanup removes the field from all of them.
      j.screens = s.screens.map((x) => x.id);
      persist();
      stage('steps-screen-schemes');
      for (const [n, x] of s.schemes.entries()) {
        const [edit, view] = n < 10 ? [s.screens[2 * n], s.screens[2 * n + 1]] : [s.screens[0]];
        x.intent = true;
        persist();
        const created = await api('/screenscheme', 'POST', {
          name: x.name,
          description: s.marker,
          screens: view
            ? { default: Number(edit.id), edit: Number(edit.id), view: Number(view.id) }
            : { default: Number(edit.id) },
        });
        x.id = String(created.id);
        persist();
      }
      stage('steps-mappings');
      s.mappingIntent = true;
      persist();
      await api(`/issuetypescreenscheme/${s.itss[0]}/mapping`, 'PUT', {
        issueTypeMappings: s.types.map((x, n) => ({
          issueTypeId: x.id,
          screenSchemeId: s.schemes[n].id,
        })),
      });
      const rows = (itss) =>
        pages(`/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${itss}`);
      const mapped = await rows(s.itss[0]);
      for (const [n, x] of s.types.entries())
        assert.equal(
          String(mapped.find((m) => String(m.issueTypeId) === x.id)?.screenSchemeId),
          s.schemes[n].id,
        );
      const fallback = (await rows(s.itss[1])).find((m) => m.issueTypeId === 'default');
      s.defaultFrom = String(fallback.screenSchemeId);
      s.defaultIntent = true;
      persist();
      await api(`/issuetypescreenscheme/${s.itss[1]}/mapping/default`, 'PUT', {
        screenSchemeId: s.schemes[0].id,
      });
      assert.equal(
        String((await rows(s.itss[1])).find((m) => m.issueTypeId === 'default').screenSchemeId),
        s.schemes[0].id,
      );
      // What Jira embeds for a screen scheme used by two work type screen schemes (the app then
      // reads the full mapping) and for one used by none (the app reads no spaces).
      const expansion = async (scheme) =>
        (await pages(`/screenscheme?id=${scheme}&expand=issueTypeScreenSchemes`))[0]
          .issueTypeScreenSchemes;
      const shared = await expansion(s.schemes[0].id);
      const unused = await expansion(s.schemes[10].id);
      s.jira = {
        sharedExpansion: shared
          ? {
              values: shared.values?.length,
              isLast: shared.isLast,
              total: shared.total,
              maxResults: shared.maxResults,
            }
          : 'omitted',
        unusedExpansion: unused
          ? { values: unused.values?.length, isLast: unused.isLast, total: unused.total }
          : 'omitted',
      };
      persist();
      for (const screen of j.screens) assert.equal(await fieldTab(screen), undefined);
      const names = s.screens.map((x) => x.name);
      const attached = s.types.map((x) => `${primary.scheme.id}:${x.id}`);
      const impact = page.getByRole('table', { name: 'Shared screen impact', exact: true });
      const outside = impact.getByRole('row').filter({ hasText: second.key });
      // Every configuration-advance response in order; a partial step leaves the space's entry
      // with how many changes it made and the reviewed changes still to make.
      function watchSteps() {
        const seen = [];
        const reads = [];
        const find = (value) => {
          if (typeof value === 'string') {
            try {
              return find(JSON.parse(value));
            } catch {
              return null;
            }
          }
          if (!value || typeof value !== 'object') return null;
          if (typeof value.ok === 'boolean' && ('value' in value || 'error' in value)) return value;
          for (const child of Object.values(value)) {
            const found = find(child);
            if (found) return found;
          }
          return null;
        };
        const listener = (response) => {
          let input;
          try {
            input = response.request().postDataJSON()?.variables?.input;
          } catch {
            return;
          }
          if (
            input?.payload?.call?.functionKey !== 'configuration-advance' ||
            input.payload.context?.environmentId !== t.environmentId ||
            !input.extensionId?.includes(t.appId)
          )
            return;
          reads.push(
            response
              .json()
              .then(find)
              .then((r) => {
                const d = r?.value?.data;
                const e = d?.entries?.[0];
                seen.push(
                  r?.ok
                    ? {
                        status: d.status,
                        applied: e.applied,
                        remaining: e.remaining?.length,
                        message: e.message,
                      }
                    : { error: r?.error ?? 'unreadable' },
                );
              }),
          );
        };
        page.on('response', listener);
        return async () => {
          page.off('response', listener);
          await Promise.allSettled(reads);
          return seen;
        };
      }
      // Apply, then wait for the space to finish over several steps. The dialog shows the
      // count between steps; a step that makes no progress stops on Continue reviewed changes.
      async function stepped(kind) {
        const stop = watchSteps();
        try {
          await apply();
          await expect(page.getByText(/^\d+ of 20 screen changes made$/).first()).toBeVisible({
            timeout: 120000,
          });
          await expect(
            page
              .getByRole('heading', { name: 'Configuration complete', exact: true })
              .or(page.getByRole('heading', { name: 'Configuration ended', exact: true }))
              .or(page.getByRole('button', { name: 'Continue reviewed changes', exact: true })),
          ).toBeVisible({ timeout: 300000 });
        } finally {
          s[kind] = await stop();
          persist();
        }
        const seen = s[kind];
        assert.ok(seen.every((x) => !x.error));
        const partial = seen.filter((x) => x.remaining);
        assert.ok(partial.length >= 1, `${kind}: one step made every change`);
        partial.forEach((x, i) => {
          assert.equal(x.status, 'ready');
          assert.equal(x.applied + x.remaining, 20);
          assert.ok(i === 0 || x.applied > partial[i - 1].applied);
          assert.equal(
            x.message,
            `${x.applied} of 20 screen changes made. Continuing with the rest.`,
          );
        });
        assert.equal(seen.at(-1).status, 'complete');
        return finish();
      }
      stage('steps-configure');
      await openConfiguration();
      await dialog(primary.key);
      await chooseExisting(task.name);
      await next();
      for (const x of s.types) await choose(primary, x.name);
      const reviewed = Date.now();
      await review();
      // A blocked or failed review names its reason only on the page, so the journal keeps it.
      s.reviewMs = Date.now() - reviewed;
      s.blocked = await modal.getByText(/^(Blocked|Could not be reviewed): /).allTextContents();
      persist();
      assert.deepEqual(s.blocked, []);
      await expect(line(/^Agent Prompts to /)).toHaveCount(names.length);
      for (const name of names) await expect(line(`Agent Prompts to ${name}`)).toHaveCount(1);
      // The first new type's screens are the second space's default screens as well.
      await expect(impact.getByRole('row')).toHaveCount(5);
      await expect(outside).toHaveCount(2);
      await expect(outside.first()).toContainText('Agent Prompts added');
      await acknowledgeScreens(true);
      const done = await stepped('configure');
      assert.equal(done.data.status, 'complete');
      assert.ok(done.data.entries.every((e) => e.status === 'done'));
      assert.deepEqual(
        (done.data.screenEffects ?? [])
          .filter((e) => e.field === j.field)
          .map((e) => `${e.screen.id}:${e.action}`)
          .sort(),
        [`${s.screens[0].id}:add`, `${s.screens[1].id}:add`].sort(),
      );
      for (const screen of j.screens) assert.ok(await fieldTab(screen), `Field on ${screen}`);
      const health = await openConfiguration();
      assert.equal(health.state.data.type, task.id);
      assert.deepEqual([...health.state.data.screenTypes].sort(), s.types.map((x) => x.id).sort());
      assert.equal(
        health.checks.find((c) => c.label === 'Agent Prompts on screens')?.ok,
        true,
        'Health check of the screens',
      );
      assert.equal((await configured(second)).type, undefined);
      stage('steps-remove-setup');
      await openConfiguration();
      await dialog(primary.key);
      await chooseMode('Remove setup from selected spaces');
      await review();
      await expect(modal.getByText(/^(Blocked|Could not be reviewed): /)).toHaveCount(0);
      await expect(line(/^Agent Prompts from /)).toHaveCount(names.length);
      await expect(outside.first()).toContainText('Agent Prompts removed');
      await acknowledgeScreens(true);
      const removed = await stepped('remove');
      assert.equal(removed.data.input.unlink, true);
      assert.ok(removed.data.entries.every((e) => e.status === 'done'));
      for (const screen of j.screens)
        assert.equal(await fieldTab(screen), undefined, `Field on ${screen}`);
      assert.deepEqual(await configured(primary), { type: undefined, reload: false, screens: [] });
      // Jira may also add a new work type to the default scheme; deleting the type removes it.
      const ours = new Set(s.types.map((x) => `${j.defaultScheme}:${x.id}`));
      assert.deepEqual(
        known(await mappings()).filter((m) => !ours.has(m)),
        [...j.mappingBaseline, ...attached].sort(),
      );
      j.stepsVerified = {
        workTypes: s.types.length,
        screens: s.screens.length,
        configureSteps: s.configure.length,
        removeSteps: s.remove.length,
        sharedWith: second.key,
        jira: s.jira,
      };
      j.passed = true;
      persist();
      console.log(JSON.stringify({ stepsVerified: j.stepsVerified }));
    } else if (rejected) {
      stage('rejected-review');
      await openConfiguration();
      await dialog(primary.key.slice(0, -1));
      await chooseMode('Create a new type');
      await page.getByRole('textbox', { name: 'New type name', exact: true }).fill(j.typeName);
      await next();
      await review();
      await expect(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeEnabled();
      // Someone creates the same name in Jira between review and Apply.
      stage('rejected-type');
      assert.ok(!(await api('/issuetype')).some((x) => x.name === j.typeName));
      j.typeIntent = true;
      persist();
      j.type = await api('/issuetype', 'POST', {
        name: j.typeName,
        description: 'Reusable instructions managed through Agent Prompts for Jira.',
        hierarchyLevel: 0,
      });
      persist();
      stage('rejected-apply');
      await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Configuration ended', exact: true }),
      ).toBeVisible({ timeout: 60000 });
      await expect(page.getByText(/Nothing was changed/).first()).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Check affected space', exact: true }),
      ).toHaveCount(0);
      await page.screenshot({ path: `${directory}/${id}-rejected.png`, fullPage: true });
      const named = (await api('/issuetype')).filter((x) => x.name === j.typeName);
      assert.deepEqual(
        named.map((x) => x.id),
        [j.type.id],
      );
      const after = await mappings();
      verifyTypeMappings(j.mappingBaseline, after, {
        type: j.type.id,
        schemes: j.fixtures.map((f) => f.scheme.id),
        defaultScheme: j.defaultScheme,
        attached: false,
      });
      assert.ok(
        j.fixtures.every((f) => !after.includes(`${f.scheme.id}:${j.type.id}`)),
        'Rejected configuration attached the type',
      );
      for (const f of j.fixtures) assert.equal((await configured(f)).type, undefined);
      stage('rejected-select-existing');
      await openConfiguration();
      await dialog(primary.key.slice(0, -1));
      await chooseExisting(j.typeName);
      const plan = await reviewConfiguration(page, t);
      assert.equal(plan.type, j.type.id);
      await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
      await finish();
      for (const f of j.fixtures) assert.equal((await configured(f)).type, j.type.id);
      assert.equal((await api('/issuetype')).filter((x) => x.name === j.typeName).length, 1);
      verifyTypeMappings(j.mappingBaseline, await mappings(), {
        type: j.type.id,
        schemes: j.fixtures.map((f) => f.scheme.id),
        defaultScheme: j.defaultScheme,
        attached: true,
      });
      j.rejectedVerified = { stopped: true, created: 0, reusedExisting: true };
      j.passed = true;
      persist();
    } else if (abandoned) {
      const existing = original.issueTypes.find((x) => x.name === 'Task' && !x.subtask);
      assert.ok(existing);
      stage('abandoned-start');
      await openConfiguration();
      await dialog(primary.key.slice(0, -1));
      await chooseExisting(existing.name);
      await reviewConfiguration(page, t);
      // Admin A walks away after the first space: the second step never reaches the app.
      const pattern = '**/gateway/api/graphql/**';
      let advances = 0;
      await page.route(pattern, async (route) => {
        let input;
        try {
          input = route.request().postDataJSON()?.variables?.input;
        } catch {
          return route.continue();
        }
        if (
          input?.payload?.call?.functionKey === 'configuration-advance' &&
          input.extensionId?.includes(t.appId) &&
          ++advances === 2
        )
          return route.abort('failed');
        return route.continue();
      });
      await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
      await expect.poll(() => advances, { timeout: 90000 }).toBeGreaterThanOrEqual(2);
      await page.unroute(pattern);
      await page.close();

      stage('abandoned-release');
      const other = await browser.newContext({
        storageState: `${activeTarget().authDirectory}/admin2.json`,
      });
      try {
        const otherApi = client(other.request);
        const second = await otherApi('/myself');
        assert.notEqual(second.accountId, owner.accountId);
        assert.equal(
          (await otherApi('/mypermissions?permissions=ADMINISTER')).permissions.ADMINISTER
            .havePermission,
          true,
        );
        const b = await other.newPage();
        b.setDefaultTimeout(30000);
        // A freshly signed-in administrator meets Jira's first-run dialog over the page.
        await dismissOnboarding(b);
        // Opening the view leaves the configuration started on the other page unchanged, and the
        // saved run names no account.
        const seen = await observeAction(
          b,
          'configuration-status',
          () => spaceSettings(b, primary.key),
          t,
        );
        assert.equal(JSON.stringify(seen).includes(owner.accountId), false);
        assert.equal(seen.data.status, 'ready');
        assert.equal(seen.data.index, 1);
        await b.getByRole('button', { name: 'Review saved configuration', exact: true }).click();
        const release = b.getByRole('button', {
          name: 'Release abandoned configuration',
          exact: true,
        });
        await expect(release).toBeDisabled();
        await expect(
          b.getByRole('button', { name: 'Continue reviewed changes', exact: true }),
        ).toHaveCount(0);
        await b
          .getByRole('checkbox', {
            name: 'I confirmed this configuration is abandoned and inspected its affected Jira changes.',
            exact: true,
          })
          .click();
        const released = await observeAction(b, 'configuration-stop', () => release.click(), t);
        assert.equal(released.data.status, 'stopped');
        assert.equal(released.data.inspectProject, undefined);
        assert.deepEqual(known(await mappings()), j.mappingBaseline);
        // The second administrator configures the remaining space alone.
        await spaceSettings(b, primary.key);
        const search = b.getByRole('textbox', { name: 'Find a space', exact: true });
        await expect(search).toBeEnabled({ timeout: 60000 });
        await search.fill(j.fixtures[1].key);
        await b.getByRole('checkbox', { name: `Select ${j.fixtures[1].key}`, exact: true }).click();
        await b.getByRole('button', { name: 'Configure selected', exact: true }).click();
        await b.getByRole('combobox', { name: 'Existing type', exact: true }).click();
        await b.getByRole('option', { name: existing.name, exact: true }).click();
        await nextStep(b);
        await reviewStep(b);
        await b.getByRole('button', { name: 'Apply changes', exact: true }).click();
        await expect(
          b.getByRole('heading', { name: 'Configuration complete', exact: true }),
        ).toBeVisible({ timeout: 60000 });
      } finally {
        await other.close();
      }
      const reviewer = await context.newPage();
      reviewer.setDefaultTimeout(30000);
      page = reviewer;
      for (const f of j.fixtures) {
        const health = await openConfiguration(f);
        assert.equal(health.state.data.type, existing.id);
      }
      assert.deepEqual(known(await mappings()), j.mappingBaseline);
      j.abandonedVerified = { firstByOwner: true, releasedBySecond: true, secondCompleted: true };
      j.passed = true;
      persist();
    } else {
      stage('configuration-review');
      await openConfiguration();
      const catalog = await dialog(primary.key.slice(0, -1));
      // The catalog lists work types only; the dialog takes the spaces from the page's inventory.
      assert.equal(catalog.typesAvailable, true);
      assert.equal('projects' in catalog, false);
      await expect(
        page.getByRole('heading', { name: 'Configure 2 spaces', exact: true }),
      ).toBeVisible();
      assert.ok(!(await api('/issuetype')).some((x) => x.name === j.typeName));
      await page.getByRole('combobox', { name: 'Prompt work type', exact: true }).click();
      await page.getByRole('option', { name: 'Create a new type', exact: true }).click();
      await page.getByRole('textbox', { name: 'New type name', exact: true }).fill(j.typeName);
      await next();
      await review();
      if (j.shared) {
        const impact = page.getByRole('table', { name: 'Shared scheme impact', exact: true });
        await expect(impact.getByRole('row')).toHaveCount(4);
        await expect(impact.getByRole('row').filter({ hasText: j.fixtures[2].key })).toContainText(
          'Type available only',
        );
        await acknowledgeShared(true);
      }
      await expect(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeEnabled();
      assert.deepEqual(known(await mappings()), j.mappingBaseline);
      assert.ok(!(await api('/issuetype')).some((x) => x.name === j.typeName));
      await page.screenshot({ path: `${directory}/${id}-review.png`, fullPage: true });
      stage('create-type');
      j.typeIntent = true;
      persist();
      if (fault) await applyWithFault(page, t);
      else {
        await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
        await expect(
          page.getByRole('heading', { name: 'Configuration complete', exact: true }),
        ).toBeVisible({
          timeout: 60000,
        });
      }
      let progress;
      if (
        fault &&
        (await page.getByRole('button', { name: 'Check saved progress', exact: true }).isVisible())
      ) {
        progress = await observeAction(
          page,
          'configuration-status',
          () => page.getByRole('button', { name: 'Check saved progress', exact: true }).click(),
          t,
        );
        if (progress.data.status === 'ready')
          await page
            .getByRole('button', { name: 'Continue reviewed changes', exact: true })
            .click();
      }
      progress = await finish();
      assert.deepEqual(
        progress.data.entries.map((e) => e.projectId).sort(),
        j.fixtures
          .slice(0, 2)
          .map((f) => f.project.id)
          .sort(),
      );
      assert.equal(progress.data.status, 'complete');
      assert.ok(progress.data.entries.every((e) => e.status === 'done'));
      j.batch = { id: progress.data.id, revision: progress.revision };
      persist();
      let health = await openConfiguration();
      const created = (await api('/issuetype')).filter((x) => x.name === j.typeName);
      assert.equal(created.length, 1);
      j.type = created[0];
      persist();
      assert.equal(health.state.data.type, j.type.id);
      const checkedOther = await openConfiguration(j.fixtures[1]);
      assert.equal(checkedOther.state.data.type, j.type.id);
      assert.ok(checkedOther.checks.every((c) => c.ok));
      if (j.shared) {
        assert.equal(progress.data.schemeEffects.length, 1);
        const unselected = await openConfiguration(j.fixtures[2]);
        assert.equal(unselected.state.data.type, undefined);
        const untouched = await emptyProject(j.fixtures[2]);
        assert.ok(untouched.issueTypes.some((type) => type.id === j.type.id));
        j.sharedVerified = {
          selected: 2,
          affected: 3,
          schemeUpdates: progress.data.schemeEffects.length,
        };
        persist();
      }
      health = await openConfiguration();
      await page.screenshot({ path: `${directory}/${id}-configuration.png`, fullPage: true });
      assert.equal(j.type.hierarchyLevel, 0);
      assert.equal(j.type.subtask, false);
      const createdMappings = known(await mappings());
      Object.assign(
        j,
        verifyTypeMappings(j.mappingBaseline, createdMappings, {
          type: j.type.id,
          schemes: (j.shared ? j.fixtures.slice(0, 1) : j.fixtures).map((f) => f.scheme.id),
          defaultScheme: j.defaultScheme,
          attached: true,
        }),
      );
      j.createdMappings = createdMappings;
      persist();
      stage('repeat-existing-type');
      await applyExisting(j.typeName);
      assert.equal((await api('/issuetype')).filter((x) => x.name === j.typeName).length, 1);
      assert.deepEqual(known(await mappings()), j.createdMappings);
      stage('rename');
      j.renamed = `Renamed ${id}`;
      persist();
      await api(`/issuetype/${j.type.id}`, 'PUT', { name: j.renamed });
      health = await openConfiguration();
      assert.equal(health.selected.name, j.renamed);
      assert.equal(health.state.data.type, j.type.id);
      stage('repair');
      for (const f of j.shared ? j.fixtures : [primary]) await emptyProject(f);
      j.detachIntent = true;
      persist();
      await api(`/issuetypescheme/${primary.scheme.id}/issuetype/${j.type.id}`, 'DELETE');
      health = await openConfiguration();
      assert.equal(health.checks[0].ok, false);
      const repair = await applyExisting(j.renamed);
      assert.equal(repair.type, j.type.id);
      assert.equal(repair.attach, true);
      assert.deepEqual(known(await mappings()), j.createdMappings);
      stage('replace');
      const replacement = original.issueTypes.find((x) => x.name === 'Task' && !x.subtask);
      assert.ok(replacement);
      await openConfiguration();
      const change = await applyExisting(replacement.name);
      assert.equal(change.old, j.type.id);
      health = await openConfiguration();
      assert.equal(health.state.data.type, replacement.id);
      assert.ok(health.state.data.previousTypes.includes(j.type.id));
      await emptyProject(primary);
      j.passed = true;
      persist();
    }
  }
  stage('cleanup');
  await cleanup();
  console.log(`Setup run ${id}: ${j.passed ? 'passed' : 'recovered'}; cleanup verified.`);
} catch (error) {
  writeFileSync(
    `${directory}/${id}-failure.txt`,
    error instanceof Error ? error.stack : 'Unknown failure',
    { mode: 0o600 },
  );
  const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [];
  for (const [index, page] of pages.entries())
    await page
      .screenshot({ path: `${directory}/${id}-failure-${index}.png`, fullPage: true })
      .catch(() => {});
  j.failedAt = j.stage;
  persist();
  console.error(
    `Setup run ${id} stopped at ${j.stage}; inspect private journal. No automatic write retry.`,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  await r.dispose();
  if (j.clean) unlinkSync(lock);
}
