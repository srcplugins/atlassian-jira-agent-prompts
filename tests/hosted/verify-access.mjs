// Hosted acceptance for hidden sources and revoked edit access on an owned development site.
// Everything it changes is created by this run in one disposable
// space with its own permission and issue security schemes, journaled before each write.
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
import {
  activeTarget,
  fixtureProject,
  markers,
  siteFor,
} from '@srcplugins/atlassian-forge-test-framework/core';
import { agentPromptsFixture } from './support/fixture.mjs';
import {
  identityFixture,
  tokenRequest,
  client,
  adf,
  installation,
  observeAction,
} from '@srcplugins/atlassian-forge-test-framework/jira';
import { spaceSettings } from './support/space-settings.mjs';
import { chooseScreenTypes, nextStep, reviewStep } from './support/configuration-dialog.mjs';

const [mode, recoveryId] = process.argv.slice(2);
assert.ok(mode === 'run' || (mode === 'cleanup' && /^[0-9a-f-]{36}$/.test(recoveryId)));
assert.equal(activeTarget().host, siteFor('primary'));
assert.equal(
  process.env.PLUGIN_TEST_ENVIRONMENT ?? 'development',
  'development',
  'This runner requires development',
);
assert.equal(process.env.NATIVE_ACCESS_TESTS, '1', 'Explicit NATIVE_ACCESS_TESTS=1 required');
const { actors } = identityFixture();
const directory = `${activeTarget().directory}/native-access-runs`;
mkdirSync(directory, { recursive: true });
const id = mode === 'run' ? randomUUID() : recoveryId;
const path = `${directory}/${id}.json`;
const lock = `${directory}/access.lock`;
if (existsSync(lock)) {
  const holder = JSON.parse(readFileSync(lock));
  assert.equal(mode, 'cleanup', 'Resolve the previous access run first');
  assert.equal(holder.id, id);
  let alive = true;
  try {
    process.kill(holder.pid, 0);
  } catch (e) {
    if (e.code === 'ESRCH') alive = false;
  }
  assert.equal(alive, false, 'Access process still alive or cannot be checked');
  unlinkSync(lock);
}
for (const name of readdirSync(directory).filter((x) => x.endsWith('.json'))) {
  const previous = JSON.parse(readFileSync(`${directory}/${name}`));
  assert.ok(previous.clean || previous.id === id, 'Resolve the previous access journal first');
}
writeFileSync(lock, JSON.stringify({ id, pid: process.pid }), { flag: 'wx', mode: 0o600 });
const short = id.replaceAll('-', '').slice(0, 7).toUpperCase();
const j =
  mode === 'cleanup'
    ? JSON.parse(readFileSync(path))
    : {
        id,
        site: activeTarget().site,
        key: `NA${short}`,
        marker: markers.acceptance('access', `${id}. Synthetic space only.`),
        label: `${markers.namespace}-access-${short.toLowerCase()}`,
        issues: {},
        stage: 'preflight',
        clean: false,
      };
assert.equal(j.id, id);
assert.equal(j.site, activeTarget().site);
const persist = () => {
  writeFileSync(`${path}.tmp`, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};
const stage = (value) => {
  j.stage = value;
  persist();
};
persist();
const r = await tokenRequest();
const api = client(r);
let browser;

async function pages(endpoint) {
  const out = [];
  for (let start = 0, n = 0; n < 100; n++) {
    const v = await api(
      `${endpoint}${endpoint.includes('?') ? '&' : '?'}startAt=${start}&maxResults=50`,
    );
    assert.ok(Array.isArray(v?.values));
    out.push(...v.values);
    if (v.isLast === true) return out;
    assert.ok(v.values.length > 0);
    start += v.values.length;
  }
  throw Error('Complete pagination required');
}
// The space's work items must be exactly journaled fixtures before anything is deleted.
async function projectIssues() {
  const found = await api('/search/jql', 'POST', {
    jql: `project = ${j.project.id} ORDER BY id ASC`,
    maxResults: 20,
    fields: ['summary', 'labels'],
  });
  assert.equal(found.isLast, true);
  return found.issues;
}
async function ownedProject() {
  const p = await api(`/project/${j.project.id}`);
  assert.equal(p?.key, j.key);
  assert.equal(p.description, j.marker);
  assert.equal(p.style, 'classic');
  return p;
}
async function cleanup() {
  if (!j.project && j.projectIntent) {
    const p = await api(`/project/${j.key}`);
    if (p) {
      assert.equal(p.description, j.marker);
      j.project = { id: String(p.id), key: p.key };
      persist();
    }
  }
  if (j.project && !j.projectDeleted) {
    if ((await api(`/project/${j.project.id}`)) === null) {
      assert.equal(j.projectDeleteIntent, true, 'Space vanished without a recorded delete');
    } else {
      await ownedProject();
      const journaled = new Map(
        Object.values(j.issues)
          .filter((x) => x.summary)
          .map((x) => [x.summary, x]),
      );
      for (const issue of await projectIssues()) {
        const entry = journaled.get(issue.fields.summary);
        assert.ok(
          entry,
          'Unexpected work item in the access fixture space; inspect before cleanup',
        );
        assert.ok(issue.fields.labels.includes(j.label));
        if (entry.id) assert.equal(entry.id, issue.id);
      }
      j.projectDeleteIntent = true;
      persist();
      await api(`/project/${j.project.id}?enableUndo=false`, 'DELETE');
      assert.equal(await api(`/project/${j.project.id}`), null);
    }
    j.projectDeleted = true;
    persist();
  }
  if (!j.permissionScheme && j.permissionIntent) {
    const found = (await api('/permissionscheme')).permissionSchemes.filter(
      (s) => s.description === j.marker,
    );
    assert.ok(found.length <= 1, 'Permission scheme outcome is ambiguous');
    if (found[0]) j.permissionScheme = { id: String(found[0].id) };
    persist();
  }
  if (j.permissionScheme && !j.permissionSchemeDeleted) {
    const scheme = await api(`/permissionscheme/${j.permissionScheme.id}`);
    if (scheme) {
      assert.equal(scheme.description, j.marker);
      await api(`/permissionscheme/${j.permissionScheme.id}`, 'DELETE');
      assert.equal(await api(`/permissionscheme/${j.permissionScheme.id}`), null);
    }
    j.permissionSchemeDeleted = true;
    persist();
  }
  if (!j.securityScheme && j.securityIntent) {
    const found = (await api('/issuesecurityschemes')).issueSecuritySchemes.filter(
      (s) => s.description === j.marker,
    );
    assert.ok(found.length <= 1, 'Security scheme outcome is ambiguous');
    if (found[0]) j.securityScheme = { id: String(found[0].id) };
    persist();
  }
  if (j.securityScheme && !j.securitySchemeDeleted) {
    const scheme = await api(`/issuesecurityschemes/${j.securityScheme.id}`);
    if (scheme) {
      assert.equal(scheme.description, j.marker);
      await api(`/issuesecurityschemes/${j.securityScheme.id}`, 'DELETE');
      await expect
        .poll(() => api(`/issuesecurityschemes/${j.securityScheme.id}`), { timeout: 60000 })
        .toBeNull();
    }
    j.securitySchemeDeleted = true;
    persist();
  }
  if (j.typeScheme && !j.typeSchemeDeleted) {
    const remaining = await pages(`/issuetypescheme?id=${j.typeScheme.id}&expand=projects`);
    if (remaining.length) {
      assert.equal(remaining[0].name, j.typeScheme.name);
      assert.notEqual(remaining[0].isDefault, true);
      assert.equal(remaining[0].projects.total, 0);
      await api(`/issuetypescheme/${j.typeScheme.id}`, 'DELETE');
    }
    j.typeSchemeDeleted = true;
    persist();
  }
  j.clean = true;
  persist();
}

// Each Jira work item write is journaled by its unique summary first, so an unknown outcome is
// reconciled by search instead of a second create.
async function createIssue(name, fields) {
  const entry = (j.issues[name] = { summary: `Access ${name} ${short}` });
  persist();
  const created = await api('/issue', 'POST', {
    fields: {
      project: { id: j.project.id },
      summary: entry.summary,
      labels: [j.label],
      ...fields,
    },
  });
  Object.assign(entry, { id: String(created.id), key: created.key });
  persist();
  return entry;
}

try {
  const owner = await api('/myself');
  assert.equal(owner.accountId, actors.owner, 'Run as the pinned identity owner');
  assert.equal(
    (await api('/mypermissions?permissions=ADMINISTER')).permissions.ADMINISTER.havePermission,
    true,
  );
  if (mode === 'run') {
    const t = installation('agent-prompts');
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const sessions = {};
    for (const [role, file] of [
      ['owner', 'admin'],
      ['member', 'member'],
      ['restricted', 'restricted'],
    ]) {
      // The feature lanes' viewport: narrower, Linux fonts wrap the field label and the issue
      // view's inline edit no longer opens from the read view.
      const context = await browser.newContext({
        storageState: `${activeTarget().authDirectory}/${file}.json`,
        viewport: { width: 1440, height: 1100 },
      });
      const actorApi = client(context.request);
      assert.equal((await actorApi('/myself')).accountId, actors[role], `${role} session`);
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      sessions[role] = { context, page, api: actorApi };
    }
    const page = sessions.owner.page;
    await observeAction(
      page,
      'setup',
      () => spaceSettings(page, fixtureProject(agentPromptsFixture)),
      t,
    );
    const field = (await api('/field')).find(
      (f) => f.schema?.custom?.includes(`/${t.appId}/`) && f.name === 'Agent Prompts',
    );
    assert.ok(field, 'Agent Prompts field required');

    stage('create-space');
    assert.equal(await api(`/project/${j.key}`), null);
    j.projectIntent = true;
    persist();
    const createdProject = await api('/project', 'POST', {
      key: j.key,
      name: `Agent Prompts access ${short}`,
      description: j.marker,
      projectTypeKey: 'software',
      projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-kanban-classic',
      leadAccountId: owner.accountId,
      assigneeType: 'UNASSIGNED',
    });
    j.project = { id: String(createdProject.id), key: createdProject.key };
    persist();
    const project = await ownedProject();
    const assigned = await pages(`/issuetypescheme/project?projectId=${j.project.id}`);
    assert.equal(assigned.length, 1);
    j.typeScheme = assigned[0].issueTypeScheme;
    persist();
    assert.equal((await projectIssues()).length, 0);

    stage('permission-scheme');
    const grant = (permission, accountId) => ({
      holder: { type: 'user', parameter: accountId },
      permission,
    });
    j.permissionIntent = true;
    persist();
    const scheme = await api('/permissionscheme', 'POST', {
      name: `Agent Prompts access ${short}`,
      description: j.marker,
      permissions: [
        ...[
          'ADMINISTER_PROJECTS',
          'BROWSE_PROJECTS',
          'CREATE_ISSUES',
          'EDIT_ISSUES',
          'DELETE_ISSUES',
          'SET_ISSUE_SECURITY',
          'TRANSITION_ISSUES',
          'ASSIGN_ISSUES',
          'ASSIGNABLE_USER',
          'RESOLVE_ISSUES',
          'SCHEDULE_ISSUES',
          'MODIFY_REPORTER',
          'LINK_ISSUES',
          'ADD_COMMENTS',
        ].map((p) => grant(p, actors.owner)),
        ...['member', 'restricted'].flatMap((role) => [
          grant('BROWSE_PROJECTS', actors[role]),
          grant('EDIT_ISSUES', actors[role]),
        ]),
      ],
    });
    j.permissionScheme = { id: String(scheme.id) };
    persist();
    const memberEdit = () =>
      api(`/permissionscheme/${j.permissionScheme.id}/permission`).then((v) =>
        v.permissions.filter(
          (p) =>
            p.permission === 'EDIT_ISSUES' &&
            p.holder?.type === 'user' &&
            (p.holder.parameter ?? p.holder.value) === actors.member,
        ),
      );
    const grants = await memberEdit();
    assert.equal(grants.length, 1);
    j.memberEditGrant = String(grants[0].id);
    j.permissionAssignIntent = true;
    persist();
    await api(`/project/${j.project.id}/permissionscheme`, 'PUT', {
      id: Number(j.permissionScheme.id),
    });
    assert.equal(
      String((await api(`/project/${j.project.id}/permissionscheme`)).id),
      j.permissionScheme.id,
    );

    stage('security-scheme');
    j.securityIntent = true;
    persist();
    const security = await api('/issuesecurityschemes', 'POST', {
      name: `Agent Prompts access ${short}`,
      description: j.marker,
      levels: [
        {
          name: 'Owner only',
          description: j.marker,
          isDefault: false,
          members: [{ type: 'user', parameter: actors.owner }],
        },
      ],
    });
    j.securityScheme = { id: String(security.id) };
    persist();
    const levels = await api(`/issuesecurityschemes/level?schemeId=${j.securityScheme.id}`);
    assert.equal(levels.values.length, 1);
    j.ownerLevel = String(levels.values[0].id);
    j.securityAssignIntent = true;
    persist();
    // Association runs as a Jira task (303 to its status); confirm the result by reading it.
    const response = await r.fetch(`${j.site}/rest/api/3/issuesecurityschemes/project`, {
      method: 'PUT',
      data: { projectId: j.project.id, schemeId: j.securityScheme.id },
      maxRedirects: 0,
      timeout: 30000,
    });
    assert.ok([200, 204, 303].includes(response.status()), `Association HTTP ${response.status()}`);
    await expect
      .poll(
        async () =>
          String((await api(`/project/${j.project.id}/issuesecuritylevelscheme`))?.id ?? ''),
        { timeout: 120000, intervals: [2000, 5000] },
      )
      .toBe(j.securityScheme.id);

    stage('configure');
    const task = project.issueTypes.find((x) => x.name === 'Task' && !x.subtask);
    const targetType = project.issueTypes.find(
      (x) => !x.subtask && x.id !== task?.id && x.hierarchyLevel === 0,
    );
    assert.ok(task && targetType);
    // The template gives the space its own screens, so the app's change reaches no other space.
    const itss = (await pages(`/issuetypescreenscheme/project?projectId=${j.project.id}`))[0]
      .issueTypeScreenScheme;
    assert.ok(itss.name.startsWith(`${j.key}:`));
    assert.deepEqual(
      (await pages(`/issuetypescreenscheme/${itss.id}/project`)).map((p) => String(p.id)),
      [j.project.id],
    );
    const rows = await pages(`/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${itss.id}`);
    const row =
      rows.find((m) => m.issueTypeId === targetType.id) ??
      rows.find((m) => m.issueTypeId === 'default');
    const screenScheme = (await pages(`/screenscheme?id=${row.screenSchemeId}`))[0];
    assert.ok(screenScheme.name.startsWith(`${j.key}:`));
    j.screens = [
      ...new Set(
        ['edit', 'view'].map((op) =>
          String(screenScheme.screens[op] ?? screenScheme.screens.default),
        ),
      ),
    ];
    persist();
    const onScreen = async (screen) => {
      for (const tab of await api(`/screens/${screen}/tabs`))
        if ((await api(`/screens/${screen}/tabs/${tab.id}/fields`)).some((f) => f.id === field.id))
          return true;
      return false;
    };
    for (const screen of j.screens) assert.equal(await onScreen(screen), false);
    await spaceSettings(page, j.key);
    const find = page.getByRole('textbox', { name: 'Find a space', exact: true });
    await expect(find).toBeEnabled({ timeout: 60000 });
    await find.fill(j.key);
    await page.getByRole('checkbox', { name: `Select ${j.key}`, exact: true }).click();
    await page.getByRole('button', { name: 'Configure selected', exact: true }).click();
    await page.getByRole('combobox', { name: 'Existing type', exact: true }).click();
    await page.getByRole('option', { name: task.name, exact: true }).click();
    // Without the reload preference, save responses are observed in place.
    await page
      .getByRole('combobox', { name: 'Reload work item after saving prompts', exact: true })
      .click();
    await page.getByRole('option', { name: 'Off for all selected spaces', exact: true }).click();
    await nextStep(page);
    // The app places the field on the target type's screens; the review then lists that change.
    await chooseScreenTypes(page, j.key, targetType.name);
    await reviewStep(page);
    await expect(page.getByRole('dialog').getByText(/^Agent Prompts to /)).toHaveCount(
      j.screens.length,
    );
    await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Configuration complete', exact: true }),
    ).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    for (const screen of j.screens) assert.equal(await onScreen(screen), true);

    stage('create-work-items');
    const visible = await createIssue('visible', {
      issuetype: { id: task.id },
      description: adf(`ACCESS-VISIBLE-${id}`),
    });
    const hidden = await createIssue('hidden', {
      issuetype: { id: task.id },
      description: adf(`ACCESS-HIDDEN-${id}`),
      security: { id: j.ownerLevel },
    });
    const target = await createIssue('target', {
      issuetype: { id: targetType.id },
      description: adf(`Access target ${short}`),
    });
    // Independent denial: the hidden source is invisible to both actors; the others are not.
    for (const role of ['member', 'restricted']) {
      const actorApi = sessions[role].api;
      const permissions = await actorApi(
        `/mypermissions?projectId=${j.project.id}&permissions=BROWSE_PROJECTS,EDIT_ISSUES,ADMINISTER`,
      );
      assert.equal(permissions.permissions.BROWSE_PROJECTS.havePermission, true);
      assert.equal(permissions.permissions.EDIT_ISSUES.havePermission, true);
      assert.equal(permissions.permissions.ADMINISTER.havePermission, false);
      assert.equal(await actorApi(`/issue/${hidden.id}`), null, `${role} must not read hidden`);
      assert.ok(await actorApi(`/issue/${visible.id}`));
      assert.ok(await actorApi(`/issue/${target.id}`));
    }
    await expect
      .poll(
        async () =>
          (
            await api('/search/jql', 'POST', {
              jql: `project = ${j.project.id} AND issuetype = ${task.id}`,
              fields: ['summary'],
              maxResults: 10,
            })
          ).issues.length,
        { timeout: 60000, intervals: [2000, 3000] },
      )
      .toBe(2);

    const readView = (p) =>
      p
        .getByRole('button', { name: /^(Agent Prompts, .*edit|Edit Agent Prompts)$/ })
        .locator('..')
        .locator(
          '[data-component-selector="jira-issue-view-select-inline-edit-read-view-container"]',
        );
    const editor = (p) => p.frameLocator(`iframe[src*="${t.appId}"][src*="${t.environmentId}"]`);
    const open = async (p) => {
      await p.goto(`${j.site}/browse/${target.key}`);
      await expect(readView(p)).toBeVisible({ timeout: 60000 });
      const loaded = await observeAction(
        p,
        'load',
        () => readView(p).click({ position: { x: 2, y: 2 } }),
        t,
      );
      await expect(
        editor(p).getByRole('combobox', { name: 'Agent Prompts', exact: true }),
      ).toBeEnabled();
      return loaded;
    };
    const targetState = async () =>
      (await api(`/issue/${target.id}?fields=description,${field.id}`)).fields;

    stage('owner-selections');
    await open(page);
    for (const source of [visible, hidden]) {
      const combo = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
      await observeAction(page, 'search', () => combo.fill(source.key), t);
      await combo.press('ArrowDown');
      await editor(page).getByText(`${source.key} — ${source.summary}`, { exact: true }).click();
    }
    await observeAction(
      page,
      'save',
      () => editor(page).getByRole('button', { name: 'Save', exact: true }).click(),
      t,
    );
    const linked = await targetState();
    assert.deepEqual(linked[field.id], [visible.key, hidden.key]);
    assert.ok(JSON.stringify(linked.description).includes(`ACCESS-HIDDEN-${id}`));
    assert.ok(JSON.stringify(linked.description).includes(`ACCESS-VISIBLE-${id}`));

    // Both actors: search never names or returns the hidden source, and the field shows it only
    // as an unavailable, removable selection.
    for (const role of ['restricted', 'member']) {
      stage(`hidden-${role}`);
      const p = sessions[role].page;
      const loaded = await open(p);
      assert.deepEqual(loaded.ids, [visible.id, hidden.id]);
      assert.ok(loaded.prompts.some((x) => x.id === visible.id));
      assert.ok(!loaded.prompts.some((x) => x.id === hidden.id || x.name === hidden.summary));
      await expect(
        editor(p).getByText(`Unavailable prompt (${hidden.id})`, { exact: false }),
      ).toBeVisible();
      await p.screenshot({ path: `${directory}/${id}-${role}-unavailable.png`, fullPage: true });
      const search = editor(p).getByRole('combobox', { name: 'Agent Prompts', exact: true });
      for (const query of [hidden.key, hidden.summary, visible.key]) {
        const found = await observeAction(p, 'search', () => search.fill(query), t);
        assert.ok(!found.prompts.some((x) => x.id === hidden.id || x.name === hidden.summary));
        if (query === visible.key)
          assert.ok(
            found.prompts.some((x) => x.id === visible.id),
            'Positive control',
          );
      }
      // Only the app frame: Jira's own history shows the copy saved into the target's
      // description, which every reader of the target may see.
      assert.ok(!(await editor(p).locator('body').innerText()).includes(hidden.summary));
      await observeAction(p, 'search', () => search.fill(''), t);
    }
    assert.deepEqual(await targetState(), linked);

    stage('member-removes-hidden');
    const member = sessions.member.page;
    await editor(member)
      .getByRole('button', { name: /remove.*Unavailable prompt/i })
      .click();
    await observeAction(
      member,
      'save',
      () => editor(member).getByRole('button', { name: 'Save', exact: true }).click(),
      t,
    );
    const removed = await targetState();
    assert.deepEqual(removed[field.id], [visible.key]);
    assert.ok(!JSON.stringify(removed.description).includes(`ACCESS-HIDDEN-${id}`));
    assert.ok(JSON.stringify(removed.description).includes(`ACCESS-VISIBLE-${id}`));

    stage('member-adds-hidden');
    // A forged save that adds the hidden ID must be refused by the backend with no write.
    await open(member);
    await editor(member)
      .getByRole('button', { name: new RegExp(`remove.*${visible.summary}`, 'i') })
      .click();
    let forged = 0;
    const pattern = '**/gateway/api/graphql/**';
    await member.route(pattern, async (route) => {
      let body;
      try {
        body = route.request().postDataJSON();
      } catch {
        return route.continue();
      }
      const input = body?.variables?.input;
      if (input?.payload?.call?.functionKey !== 'save' || !input.extensionId?.includes(t.appId))
        return route.continue();
      const swap = (value) => {
        if (!value || typeof value !== 'object') return false;
        if (Array.isArray(value.ids) && typeof value.fingerprint === 'string') {
          value.ids = [visible.id, hidden.id];
          return true;
        }
        return Object.values(value).some(swap);
      };
      assert.ok(swap(input.payload));
      forged++;
      return route.continue({ postData: JSON.stringify(body) });
    });
    await expect(
      observeAction(
        member,
        'save',
        () => editor(member).getByRole('button', { name: 'Save', exact: true }).click(),
        t,
      ),
    ).rejects.toMatchObject({ category: 'resolver-failed' });
    await member.unroute(pattern);
    assert.equal(forged, 1);
    assert.deepEqual(await targetState(), removed);
    await member.screenshot({ path: `${directory}/${id}-member-forged.png`, fullPage: true });

    stage('member-admin-refused');
    // Jira refuses space settings to non-administrators before the app loads, so prove the app's
    // own check here: the field's load is rewritten into the read-only space inventory call.
    await member.goto(`${j.site}/browse/${target.key}`);
    await expect(readView(member)).toBeVisible({ timeout: 60000 });
    let refused;
    await member.route(pattern, async (route) => {
      let body;
      try {
        body = route.request().postDataJSON();
      } catch {
        return route.continue();
      }
      const call = body?.variables?.input?.payload?.call;
      if (
        refused !== undefined ||
        call?.functionKey !== 'load' ||
        !body.variables.input.extensionId?.includes(t.appId)
      )
        return route.continue();
      call.functionKey = 'settings-projects';
      const response = await route.fetch({ postData: JSON.stringify(body) });
      const text = await response.text();
      const find = (value) =>
        !value || typeof value !== 'object'
          ? null
          : typeof value.ok === 'boolean'
            ? value
            : Object.values(value).map(find).find(Boolean);
      refused = find(JSON.parse(text)) ?? null;
      return route.fulfill({ response, body: text });
    });
    await readView(member).click({ position: { x: 2, y: 2 } });
    await expect(
      editor(member).getByText('This needs the Jira permission Administer Jira.', { exact: true }),
    ).toBeVisible({ timeout: 45000 });
    await member.unroute(pattern);
    assert.deepEqual(refused, {
      ok: false,
      error: 'This needs the Jira permission Administer Jira.',
    });
    assert.deepEqual(await targetState(), removed);
    await member.screenshot({ path: `${directory}/${id}-member-admin.png`, fullPage: true });

    stage('member-edit-revoked');
    // The picker opened while Edit was allowed; revoke only this run's grant, then Save once.
    await open(member);
    await editor(member)
      .getByRole('button', { name: new RegExp(`remove.*${visible.summary}`, 'i') })
      .click();
    j.revokeIntent = true;
    persist();
    await api(
      `/permissionscheme/${j.permissionScheme.id}/permission/${j.memberEditGrant}`,
      'DELETE',
    );
    await expect
      .poll(
        async () =>
          (
            await sessions.member.api(
              `/mypermissions?projectId=${j.project.id}&permissions=EDIT_ISSUES`,
            )
          ).permissions.EDIT_ISSUES.havePermission,
        { timeout: 60000, intervals: [2000, 3000] },
      )
      .toBe(false);
    await expect(
      observeAction(
        member,
        'save',
        () => editor(member).getByRole('button', { name: 'Save', exact: true }).click(),
        t,
      ),
    ).rejects.toMatchObject({ category: 'resolver-failed' });
    assert.deepEqual(await targetState(), removed);
    await member.screenshot({ path: `${directory}/${id}-member-revoked.png`, fullPage: true });
    // Restore the exact grant baseline before cleanup.
    const restored = await api(`/permissionscheme/${j.permissionScheme.id}/permission`, 'POST', {
      holder: { type: 'user', parameter: actors.member },
      permission: 'EDIT_ISSUES',
    });
    j.memberEditGrant = String(restored.id);
    j.restored = true;
    persist();
    assert.equal((await memberEdit()).length, 1);
    await expect
      .poll(
        async () =>
          (
            await sessions.member.api(
              `/mypermissions?projectId=${j.project.id}&permissions=EDIT_ISSUES`,
            )
          ).permissions.EDIT_ISSUES.havePermission,
        { timeout: 60000, intervals: [2000, 3000] },
      )
      .toBe(true);
    j.accessVerified = {
      actors: ['member', 'restricted'],
      hiddenNeverListed: true,
      unavailableRemoved: true,
      forgedAddRefused: true,
      adminCallRefused: true,
      revokedSaveRefused: true,
    };
    j.passed = true;
    persist();
  }
  stage('cleanup');
  await cleanup();
  console.log(`Access run ${id}: ${j.passed ? 'passed' : 'recovered'}; cleanup verified.`);
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
    `Access run ${id} stopped at ${j.stage}; inspect private journal. No automatic write retry.`,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  await r.dispose();
  if (j.clean) unlinkSync(lock);
}
