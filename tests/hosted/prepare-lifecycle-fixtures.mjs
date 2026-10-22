import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tokenRequest, client } from '@srcplugins/atlassian-forge-test-framework/jira';
import {
  activeTarget,
  fixtureProject,
  isMarker,
  markers,
  siteFor,
} from '@srcplugins/atlassian-forge-test-framework/core';
import { agentPromptsFixture } from './support/fixture.mjs';
import { agentPromptsField } from './support/field.mjs';

// Places the active installation's Agent Prompts field on the Task edit and view screens of the
// lifecycle runner's retained fixture spaces (verify-lifecycle.mjs), which a new app
// registration's field doesn't reach on its own: on the isolation site the Agent Prompts,
// forge-sandbox and tenant-isolation spaces, on the primary site the tenant-isolation space.
// `check` only reads; `apply` writes a missing field to the screen's first tab. It writes only to
// a screen whose every screen scheme belongs to issue type screen schemes used by that fixture
// space alone. Each write is journaled before it is sent and read back after; a journal left
// mid-write stops a rerun until inspected. Nothing is ever removed.
const [mode] = process.argv.slice(2);
assert.ok(['check', 'apply'].includes(mode), 'Usage: prepare-lifecycle-fixtures.mjs check|apply');
if (mode === 'apply')
  assert.equal(
    process.env.NATIVE_LIFECYCLE_FIXTURE_PREPARE,
    '1',
    'Explicit fixture preparation required',
  );
const target = activeTarget();
const fixtures =
  target.host === siteFor('isolation')
    ? [agentPromptsFixture, 'forge-sandbox', 'tenant-isolation']
    : target.host === siteFor('primary')
      ? ['tenant-isolation']
      : assert.fail('Lifecycle fixtures live on the isolation and primary sites only');
const journal = `${target.directory}/lifecycle-fixture-screens.json`;
const request = await tokenRequest();
const api = client(request);
const record = existsSync(journal) ? JSON.parse(readFileSync(journal, 'utf8')) : { writes: [] };
const save = () => writeFileSync(journal, JSON.stringify(record, null, 1), { mode: 0o600 });
let field;

/** Every value of a paged list, following `isLast`. */
async function pages(path) {
  const values = [];
  for (let startAt = 0, page = 0; ; page++) {
    assert.ok(page < 50, `Too many pages: ${path}`);
    const sep = path.includes('?') ? '&' : '?';
    const body = await api(`${path}${sep}startAt=${startAt}&maxResults=100`);
    assert.ok(Array.isArray(body.values) && typeof body.isLast === 'boolean', `Unpaged: ${path}`);
    values.push(...body.values);
    if (body.isLast) return values;
    startAt += body.values.length;
  }
}
const onTab = async (screen) => {
  for (const tab of await api(`/screens/${screen}/tabs`))
    if ((await api(`/screens/${screen}/tabs/${tab.id}/fields`)).some((f) => f.id === field.id))
      return tab.id;
  return null;
};

try {
  field = await agentPromptsField(api);
  const pending = record.writes.find((w) => w.status === 'sending');
  if (pending) {
    const tab = await onTab(pending.screen);
    assert.fail(
      `An earlier write to screen ${pending.screen} is unresolved (field ${tab ? `on tab ${tab}` : 'absent'}); inspect ${journal}`,
    );
  }
  // Which screen schemes use each screen, site-wide, and which issue type screen schemes use them.
  const schemes = await pages('/screenscheme?expand=issueTypeScreenSchemes');
  for (const name of fixtures) {
    const key = fixtureProject(name);
    const project = await api(`/project/${key}`);
    assert.ok(
      isMarker(project?.description, markers.browserProject(name)) &&
        project.key === key &&
        project.style === 'classic',
      `Space ownership mismatch ${key}`,
    );
    const task = project.issueTypes.find((t) => t.name === 'Task' && !t.subtask);
    assert.ok(task, `${key} has no Task type`);
    const [link] = await pages(`/issuetypescreenscheme/project?projectId=${project.id}`);
    const itss = link.issueTypeScreenScheme;
    const users = (await pages(`/issuetypescreenscheme/${itss.id}/project`)).map((p) =>
      String(p.id),
    );
    assert.deepEqual(users, [project.id], `${key}'s issue type screen scheme is shared`);
    const rows = await pages(`/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${itss.id}`);
    const row =
      rows.find((m) => m.issueTypeId === task.id) ?? rows.find((m) => m.issueTypeId === 'default');
    const scheme = schemes.find((s) => String(s.id) === String(row.screenSchemeId));
    assert.ok(scheme, `${key}: screen scheme ${row.screenSchemeId} not listed`);
    const screens = [
      ...new Set(
        ['edit', 'view'].map((op) => String(scheme.screens[op] ?? scheme.screens.default)),
      ),
    ];
    for (const screen of screens) {
      const tab = await onTab(screen);
      if (tab) {
        console.log(JSON.stringify({ key, screen, field: field.id, state: 'present', tab }));
        continue;
      }
      const using = schemes.filter((s) => Object.values(s.screens).map(String).includes(screen));
      const private_ = using.every(
        (s) =>
          s.issueTypeScreenSchemes?.isLast === true &&
          s.issueTypeScreenSchemes.values.every((v) => String(v.id) === String(itss.id)),
      );
      if (!private_) {
        console.log(JSON.stringify({ key, screen, state: 'shared: not written' }));
        process.exitCode = 1;
        continue;
      }
      const [first] = await api(`/screens/${screen}/tabs`);
      assert.ok(first, `Screen ${screen} has no tabs`);
      if (mode === 'check') {
        console.log(
          JSON.stringify({ key, screen, tab: first.id, field: field.id, state: 'missing' }),
        );
        continue;
      }
      const entry = {
        key,
        screen,
        tab: first.id,
        field: field.id,
        status: 'sending',
        at: new Date().toISOString(),
      };
      record.writes.push(entry);
      save();
      await api(`/screens/${screen}/tabs/${first.id}/fields`, 'POST', { fieldId: field.id });
      assert.equal(await onTab(screen), first.id, `Screen ${screen} does not show the field`);
      entry.status = 'added';
      save();
      console.log(JSON.stringify({ key, screen, tab: first.id, field: field.id, state: 'added' }));
    }
  }
} finally {
  await request.dispose();
}
