import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expect } from './expect.mjs';
import {
  siteFor,
  activeTarget,
  browserTarget,
  fixtureProject,
} from '@srcplugins/atlassian-forge-test-framework/core';
import { client, observeAction } from '@srcplugins/atlassian-forge-test-framework/jira';
import { editor, openField, snapshotJourney } from './snapshots.mjs';
import { spaceSettings } from './space-settings.mjs';

// Keep the source journal live while probing the other installation. All writes go through
// the destination's owned fixture journal; the peer client is used only for independent reads.
export async function runIsolationProbe({
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
}) {
  const peerHost = [siteFor('primary'), siteFor('isolation')].find(
    (host) => host !== activeTarget().host,
  );
  const peer = JSON.parse(
    readFileSync(
      `${browserTarget(peerHost).directory}/native-lifecycle-runs/${options.peerRunId}.json`,
    ),
  );
  assert.equal(peer.runId, options.peerRunId);
  assert.equal(peer.lifecycle.mode, 'isolation-prepare');
  assert.equal(peer.lifecycle.stage, 'isolation-source-ready');
  assert.equal(peer.lifecycle.site, peerHost);
  assert.equal(peer.lifecycle.environmentId, target.environmentId);
  assert.equal(peer.lifecycle.actors.owner.accountId, expected.owner);
  const foreign = peer.lifecycle.reinstallBackup;
  assert.ok(foreign.sourceKey.startsWith(`${fixtureProject('tenant-isolation')}-`));
  const peerApi = client(request, `https://${peerHost}`);
  assert.equal((await peerApi('/myself')).accountId, expected.owner);
  const verifyPeer = async () => {
    assert.deepEqual(
      (await peerApi(`/issue/${foreign.targetId}?fields=description,${foreign.fieldId}`)).fields,
      foreign.linked,
    );
    assert.deepEqual(
      (await peerApi(`/issue/${foreign.sourceId}?fields=description,summary,issuetype`)).fields,
      foreign.sourceFields,
    );
  };
  await verifyPeer();
  // Jira IDs are tenant-local: the peer's number can name an unrelated local issue.
  // Keep that collision as an additional unchanged-data oracle, never as a prompt match.
  const collisionPath = `/issue/${foreign.sourceId}?fields=summary,description,project,issuetype`;
  const collision = await api(collisionPath);
  if (collision) {
    assert.notEqual(
      collision.fields.project.id,
      project.id,
      'Foreign ID is also a local fixture work item; negative control is ambiguous',
    );
    assert.notEqual(collision.fields.summary, foreign.sourceFields.summary);
  }
  state.lifecycle.foreignIdBaseline = collision;
  owned.run.persist();
  const baseline = await health();
  assert.ok(
    !baseline.state.data.type,
    'Peer configuration leaked or destination is already configured',
  );
  state.lifecycle.baseline = baseline;
  state.lifecycle.peer = { host: peerHost, runId: peer.runId, sourceId: foreign.sourceId };
  owned.run.persist();
  const page = await contexts.owner.newPage();
  const setup = await observeAction(page, 'setup', () => spaceSettings(page, project.key), target);
  assert.ok(!setup.type, 'Unconfigured destination adopted peer type');
  assert.ok(!(await page.locator('body').innerText()).includes(foreign.sourceFields.summary));
  owned.run.check('Same space key on another tenant does not inherit configuration or source name');
  const type = project.issueTypes.find((t) => !t.subtask && t.name === 'Story');
  assert.ok(type);
  state.lifecycle.type = type;
  owned.run.persist();
  await configure(type);
  state.lifecycle.configuredState = (await health()).state;
  assert.equal(state.lifecycle.configuredState.data.type, type.id);
  owned.run.persist();
  const local = await snapshotJourney({
    page,
    owned,
    blank: false,
    testInfo: { annotations: [] },
    retainSaved: true,
  });
  state.lifecycle.localBackup = local;
  owned.run.persist();
  await page.goto(`${activeTarget().site}/browse/${local.targetKey}`);
  const readView = page
    .getByRole('button', { name: /^(Agent Prompts, .*edit|Edit Agent Prompts)$/ })
    .locator('..')
    .locator('[data-component-selector="jira-issue-view-select-inline-edit-read-view-container"]');
  const loaded = await observeAction(page, 'load', () => openField(page, readView), target);
  assert.deepEqual(loaded.ids, [local.sourceId]);
  assert.ok(
    !loaded.prompts.some(
      (p) => p.id === foreign.sourceId || p.name === foreign.sourceFields.summary,
    ),
  );
  const combo = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
  for (const query of [foreign.sourceFields.summary, local.sourceKey]) {
    const found = await observeAction(page, 'search', () => combo.fill(query), target);
    assert.ok(
      !found.prompts.some(
        (p) => p.id === foreign.sourceId || p.name === foreign.sourceFields.summary,
      ),
    );
    if (query === local.sourceKey)
      assert.ok(
        found.prompts.some((p) => p.id === local.sourceId),
        'Local search positive control',
      );
  }
  await editor(page)
    .getByRole('button', { name: /remove.*Error handling/i })
    .click();
  let forged = 0;
  const pattern = '**/gateway/api/graphql/**';
  await page.route(pattern, async (route) => {
    let body;
    try {
      body = route.request().postDataJSON();
    } catch {
      return route.continue();
    }
    const input = body?.variables?.input;
    if (
      input?.payload?.call?.functionKey !== 'save' ||
      !input.extensionId?.includes(target.appId) ||
      !input.extensionId.includes(target.environmentId)
    )
      return route.continue();
    const swap = (value) => {
      if (!value || typeof value !== 'object') return false;
      if (Array.isArray(value.ids) && typeof value.fingerprint === 'string') {
        value.ids = [foreign.sourceId];
        return true;
      }
      return Object.values(value).some(swap);
    };
    assert.equal(forged, 0, 'Never retry the forged save');
    assert.ok(swap(input.payload));
    forged++;
    state.lifecycle.foreignSaveIntent = { sourceId: foreign.sourceId, targetId: local.targetId };
    owned.run.persist();
    return route.continue({ postData: JSON.stringify(body) });
  });
  try {
    await expect(
      observeAction(
        page,
        'save',
        () => editor(page).getByRole('button', { name: 'Save', exact: true }).click(),
        target,
      ),
    ).rejects.toMatchObject({ category: 'resolver-failed' });
  } finally {
    await page.unroute(pattern);
  }
  assert.equal(forged, 1);
  assert.deepEqual(
    (await api(`/issue/${local.targetId}?fields=description,${local.fieldId}`)).fields,
    local.linked,
  );
  assert.deepEqual(
    (await api(`/issue/${local.sourceId}?fields=description,summary,issuetype`)).fields,
    local.sourceFields,
  );
  await verifyPeer();
  assert.deepEqual(
    await api(collisionPath),
    collision,
    'Rejected foreign ID changed its unrelated local collision',
  );
  owned.run.check(
    collision
      ? 'Tenant-local numeric ID collision remained exactly unchanged'
      : 'Foreign numeric ID does not exist on destination',
  );
  owned.run.check(
    'Library and picker exclude foreign prompt; forged foreign-ID save denied; exact source and target unchanged on both sites',
  );
  state.lifecycle.journeysPassed = true;
  owned.run.persist();
}
