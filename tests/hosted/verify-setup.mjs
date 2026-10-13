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
import { chromium, expect } from '@playwright/test';
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

const [mode, recoveryId] = process.argv.slice(2);
const fault = process.env.NATIVE_SETUP_FAULT;
assert.ok(!fault || ['concurrent', 'lost-response'].includes(fault));
// Abandoned mode: admin A leaves a reviewed configuration ready after its first space; a second
// administrator (saved admin2 session) must be able to review and release it.
const abandoned = process.env.NATIVE_SETUP_ABANDONED === '1';
// Bulk mode: configure both spaces with an existing type, reload off then on, then remove setup from both.
const bulk = process.env.NATIVE_SETUP_BULK === '1';
// Rejected mode: a type with the reviewed new name is created directly in Jira before Apply.
const rejected = process.env.NATIVE_SETUP_REJECTED === '1';
assert.ok([abandoned, bulk, rejected].filter(Boolean).length <= 1, 'Choose one mode');
assert.ok(!(abandoned || bulk || rejected) || (!fault && process.env.NATIVE_SETUP_SHARED !== '1'));
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
const id = mode === 'run' ? randomUUID() : recoveryId;
const path = `${directory}/${id}.json`;
const lock = `${directory}/setup.lock`;
if (existsSync(lock)) {
  const holder = JSON.parse(readFileSync(lock));
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
  const previous = JSON.parse(readFileSync(`${directory}/${name}`));
  assert.ok(previous.clean || previous.id === id, 'Resolve the previous setup journal first');
}
writeFileSync(lock, JSON.stringify({ id, pid: process.pid }), { flag: 'wx', mode: 0o600 });
const j =
  mode === 'cleanup'
    ? JSON.parse(readFileSync(path))
    : {
        id,
        site: activeTarget().site,
        shared: process.env.NATIVE_SETUP_SHARED === '1',
        fixtures: (process.env.NATIVE_SETUP_SHARED === '1' ? [0, 1, 2] : [0, 1]).map((n) => ({
          key: `NP${id.replaceAll('-', '').slice(0, 7).toUpperCase()}${n}`,
          marker: setupRunSpace(id, n),
        })),
        typeName: `Setup ${id}`,
        stage: 'preflight',
        clean: false,
      };
assert.equal(j.id, id);
assert.equal(j.site, activeTarget().site);
assert.equal(j.fixtures.length, j.shared ? 3 : 2);
const persist = () => {
  writeFileSync(`${path}.tmp`, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};
persist();
const r = await tokenRequest();
const api = client(r);
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
      if (responses.some((x) => x.status !== 'fulfilled')) {
        failed = true;
        return await route.abort('failed');
      }
      if (fault === 'lost-response') await route.abort('failed');
      else await route.fulfill({ response: responses[0].value });
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
async function pages(endpoint) {
  const out = [];
  for (let start = 0, n = 0; n < 100; n++) {
    const v = await api(
      `${endpoint}${endpoint.includes('?') ? '&' : '?'}startAt=${start}&maxResults=100`,
    );
    assert.ok(Array.isArray(v?.values));
    assert.equal(v.startAt, start);
    out.push(...v.values);
    if (v.isLast === true) return out;
    assert.ok(v.values.length > 0);
    start += v.values.length;
  }
  throw Error('Complete pagination required');
}
const mappings = async () =>
  (await pages('/issuetypescheme/mapping'))
    .map((x) => `${x.issueTypeSchemeId}:${x.issueTypeId}`)
    .sort();
// Mappings of schemes that existed at the baseline. Schemes created meanwhile by unrelated work on
// the shared site are ignored here; one that acquires the synthetic type still fails cleanup.
const known = (values) => {
  const schemes = new Set(j.mappingBaseline.map((value) => value.split(':')[0]));
  return values.filter((value) => schemes.has(value.split(':')[0]));
};
async function emptyProject(f) {
  const p = await api(`/project/${f.project.id}`);
  assert.equal(p?.key, f.key);
  assert.equal(p.description, f.marker);
  assert.equal(p.style, 'classic');
  assert.equal(p.projectTypeKey, 'software');
  const found = await api('/search/jql', 'POST', {
    jql: `project = ${f.project.id}`,
    maxResults: 1,
    fields: ['summary'],
  });
  assert.equal(found.isLast, true);
  assert.equal(found.issues.length, 0);
  const assignment = await pages(`/issuetypescheme/project?projectId=${f.project.id}`);
  assert.equal(assignment.length, 1);
  const current = assignment[0].issueTypeScheme.id;
  assert.ok(current === f.scheme.id || (f.shareIntent && current === j.fixtures[0].scheme.id));
  const expected = [];
  for (const member of j.fixtures) {
    if (!member.project || member.projectDeleted) continue;
    const assigned = await pages(`/issuetypescheme/project?projectId=${member.project.id}`);
    assert.equal(assigned.length, 1);
    if (assigned[0].issueTypeScheme.id === current) expected.push(member.project.id);
  }
  const schemes = await pages(`/issuetypescheme?id=${current}&expand=projects`);
  assert.equal(schemes.length, 1);
  assert.notEqual(schemes[0].isDefault, true);
  assert.equal(schemes[0].projects.isLast, true);
  assert.deepEqual(schemes[0].projects.values.map((x) => x.id).sort(), expected.sort());
  return p;
}
async function cleanup() {
  // Reconcile exact unique intents without repeating creation.
  for (const f of j.fixtures) {
    if (!f.project && f.projectIntent) {
      const p = await api(`/project/${f.key}`);
      assert.equal(p?.description, f.marker);
      f.project = { id: String(p.id), key: p.key };
      persist();
    }
    if (!f.project) continue;
    if (f.projectDeleteIntent && (await api(`/project/${f.project.id}`)) === null) {
      f.projectDeleted = true;
      persist();
    }
    if (!f.scheme) {
      const found = await pages(`/issuetypescheme/project?projectId=${f.project.id}`);
      assert.equal(found.length, 1);
      f.scheme = found[0].issueTypeScheme;
      persist();
    }
    if (!f.projectDeleted) await emptyProject(f);
  }
  if (!j.type && j.typeIntent) {
    const matches = (await api('/issuetype')).filter(
      (x) => x.name === j.typeName || x.name === j.renamed,
    );
    assert.equal(matches.length, 1, 'Type outcome is ambiguous; inspect without retry');
    j.type = matches[0];
    persist();
  }
  if (j.type && !j.typeDeleted) {
    const t = await api(`/issuetype/${j.type.id}`);
    if (t === null) assert.equal(j.typeDeleteIntent, true);
    else {
      assert.ok([j.typeName, j.renamed].includes(t.name));
      assert.equal(t.description, 'Reusable instructions managed through Agent Prompts for Jira.');
      assert.equal(t.hierarchyLevel, 0);
      assert.equal(t.subtask, false);
      const found = await api('/search/jql', 'POST', {
        jql: `issuetype = ${t.id}`,
        fields: ['summary'],
        maxResults: 1,
      });
      assert.equal(found.isLast, true);
      assert.equal(found.issues.length, 0);
      verifyTypeMappings(j.mappingBaseline, await mappings(), {
        type: t.id,
        schemes: (j.shared ? j.fixtures.slice(0, 1) : j.fixtures).map((f) => f.scheme.id),
        defaultScheme: j.defaultScheme,
        attached: false,
      });
      j.typeDeleteIntent = true;
      persist();
      await api(`/issuetype/${t.id}`, 'DELETE');
      assert.equal(await api(`/issuetype/${t.id}`), null);
    }
    j.typeDeleted = true;
    persist();
    assert.deepEqual(known(await mappings()), j.mappingBaseline);
  }
  for (const f of j.fixtures) {
    if (!f.project) continue;
    if (!f.projectDeleted) {
      await emptyProject(f);
      f.projectDeleteIntent = true;
      persist();
      await api(`/project/${f.project.id}?enableUndo=false`, 'DELETE');
      assert.equal(await api(`/project/${f.project.id}`), null);
      f.projectDeleted = true;
      persist();
    }
  }
  for (const f of j.fixtures) {
    if (!f.scheme) continue;
    const remaining = await pages(`/issuetypescheme?id=${f.scheme.id}&expand=projects`);
    if (remaining.length) {
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].id, f.scheme.id);
      assert.notEqual(remaining[0].isDefault, true);
      assert.equal(remaining[0].projects.total, 0);
      assert.equal(remaining[0].name, f.scheme.name);
      f.schemeDeleteIntent = true;
      persist();
      await api(`/issuetypescheme/${f.scheme.id}`, 'DELETE');
      assert.equal((await pages(`/issuetypescheme?id=${f.scheme.id}`)).length, 0);
    }
  }
  j.clean = true;
  persist();
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
    // fixture checks app eligibility before any creation. Opening it also cancels this actor's own
    // interrupted configuration and returns progress.
    const before = await observeAction(
      page,
      'configuration-cancel-interrupted',
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
    async function openConfiguration(f = primary) {
      await spaceSettings(page, f.key);
      const search = page.getByRole('textbox', { name: 'Find a space', exact: true });
      await expect(search).toBeEnabled({ timeout: 60000 });
      await search.fill(f.key);
      await page.getByRole('checkbox', { name: `Select ${f.key}`, exact: true }).click();
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
      if (j.shared && query !== primary.key) {
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
      const plan = await observeAction(
        page,
        'configuration-preview',
        () => page.getByRole('button', { name: 'Review changes', exact: true }).click(),
        t,
      );
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
      };
    }
    const task = original.issueTypes.find((x) => x.name === 'Task' && !x.subtask);
    assert.ok(task);
    if (bulk) {
      for (const reload of [false, true]) {
        stage(`bulk-configure-${reload ? 'reload' : 'plain'}`);
        await openConfiguration();
        await dialog(primary.key.slice(0, -1));
        await chooseExisting(task.name);
        const box = page.getByRole('checkbox', {
          name: 'Reload work item after saving prompts',
          exact: true,
        });
        if ((await box.isChecked()) !== reload) await box.click();
        await expect(box).toBeChecked({ checked: reload });
        await page.getByRole('button', { name: 'Review changes', exact: true }).click();
        await expect(
          page.getByText(`Reload after saving: ${reload ? 'On' : 'Off'} for all selected`, {
            exact: false,
          }),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
        const done = await finish();
        assert.equal(done.data.status, 'complete');
        assert.equal(done.data.entries.length, 2);
        for (const f of j.fixtures)
          assert.deepEqual(await configured(f), { type: task.id, reload });
        assert.deepEqual(known(await mappings()), j.mappingBaseline);
      }
      stage('bulk-remove-setup-cancel');
      await openConfiguration();
      await dialog(primary.key.slice(0, -1));
      await chooseMode('Remove setup from selected spaces');
      await expect(
        page.getByRole('checkbox', { name: 'Reload work item after saving prompts', exact: true }),
      ).toHaveCount(0);
      await page.getByRole('button', { name: 'Review changes', exact: true }).click();
      await expect(page.getByText('Remove setup and preferences', { exact: true })).toHaveCount(2);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      for (const f of j.fixtures)
        assert.deepEqual(await configured(f), { type: task.id, reload: true });
      stage('bulk-remove-setup');
      await openConfiguration();
      await dialog(primary.key.slice(0, -1));
      await chooseMode('Remove setup from selected spaces');
      await page.getByRole('button', { name: 'Review changes', exact: true }).click();
      await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
      const removed = await finish();
      assert.equal(removed.data.input.unlink, true);
      assert.ok(removed.data.entries.every((e) => e.status === 'done'));
      for (const f of j.fixtures)
        assert.deepEqual(await configured(f), { type: undefined, reload: false });
      assert.deepEqual(known(await mappings()), j.mappingBaseline);
      for (const f of j.fixtures) await emptyProject(f);
      stage('bulk-reconfigure');
      await openConfiguration();
      await dialog(primary.key.slice(0, -1));
      await chooseExisting(task.name);
      await page.getByRole('button', { name: 'Review changes', exact: true }).click();
      await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
      await finish();
      for (const f of j.fixtures) assert.equal((await configured(f)).type, task.id);
      assert.deepEqual(known(await mappings()), j.mappingBaseline);
      j.bulkVerified = { projects: 2, reloadOff: true, reloadOn: true, setupRemoved: true };
      j.passed = true;
      persist();
    } else if (rejected) {
      stage('rejected-review');
      await openConfiguration();
      await dialog(primary.key.slice(0, -1));
      await chooseMode('Create a new type');
      await page.getByRole('textbox', { name: 'New type name', exact: true }).fill(j.typeName);
      await page.getByRole('button', { name: 'Review changes', exact: true }).click();
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
      const plan = await observeAction(
        page,
        'configuration-preview',
        () => page.getByRole('button', { name: 'Review changes', exact: true }).click(),
        t,
      );
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
      await observeAction(
        page,
        'configuration-preview',
        () => page.getByRole('button', { name: 'Review changes', exact: true }).click(),
        t,
      );
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
        // Opening the view must not cancel another administrator's configuration.
        const seen = await observeAction(
          b,
          'configuration-cancel-interrupted',
          () => spaceSettings(b, primary.key),
          t,
        );
        assert.equal(seen.data.actor, owner.accountId);
        assert.equal(seen.data.status, 'ready');
        assert.equal(seen.data.index, 1);
        assert.notEqual(seen.data.cancelRequested, true);
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
        await b.getByRole('button', { name: 'Review changes', exact: true }).click();
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
      for (const f of j.fixtures) assert.ok(catalog.projects.some((p) => p.id === f.project.id));
      await expect(
        page.getByRole('heading', { name: 'Configure 2 spaces', exact: true }),
      ).toBeVisible();
      assert.ok(!(await api('/issuetype')).some((x) => x.name === j.typeName));
      await page.getByRole('combobox', { name: 'Prompt work type', exact: true }).click();
      await page.getByRole('option', { name: 'Create a new type', exact: true }).click();
      await page.getByRole('textbox', { name: 'New type name', exact: true }).fill(j.typeName);
      await page.getByRole('button', { name: 'Review changes', exact: true }).click();
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
