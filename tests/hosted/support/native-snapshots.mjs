import { gunzipSync } from 'node:zlib';
import {
  expect,
  installation,
  projectPage,
  observeAction,
  dismissOnboarding,
  adf,
} from '@srcplugins/atlassian-forge-test-framework/jira';
import { activeTarget, markers } from '@srcplugins/atlassian-forge-test-framework/core';
export function editor(page) {
  const t = installation('agent-prompts');
  return page.frameLocator(`iframe[src*="${t.appId}"][src*="${t.environmentId}"]`);
}
// The field bundle embeds Atlaskit feature-gate endpoints but declares no egress, so Forge's CSP
// must block them. Watch only the app's own iframe: Jira's host page uses the same services.
const telemetryHosts =
  /statsig|featureassets\.org|prodregistryv2\.org|xp\.atlassian\.com|api(?:\.dev|\.stg)?\.atlassian\.com\/flags|cloudflare-dns\.com/i;
// Structure only (paths, parameter and field names, event and gate names), never values.
function requestShape(request) {
  const url = new URL(request.url());
  const shape = { path: url.pathname, params: [...url.searchParams.keys()].sort() };
  let body = request.postDataBuffer();
  if (!body?.length) return { ...shape, body: 'none' };
  try {
    if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body);
    const parsed = JSON.parse(body.toString('utf8'));
    const keys = (value) =>
      value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
    return {
      ...shape,
      bodyKeys: keys(parsed),
      userKeys: keys(parsed.user),
      events: (Array.isArray(parsed.events) ? parsed.events : []).map((event) => ({
        eventName: event?.eventName,
        gate: typeof event?.metadata?.gate === 'string' ? event.metadata.gate : undefined,
        metadataKeys: keys(event?.metadata),
        userKeys: keys(event?.user),
        customIDKeys: keys(event?.user?.customIDs),
      })),
    };
  } catch {
    return { ...shape, body: `unparsed ${body.length} bytes` };
  }
}
function watchAppEgress(page) {
  const { appId } = installation('agent-prompts');
  const seen = [];
  // Positive control: the iframe's own assets must be observed, or zero telemetry proves nothing.
  seen.appRequests = 0;
  // The app's project page URL contains the app ID too, so exclude Jira's own main frame.
  const fromApp = (request) => {
    const frame = request.frame();
    return !!frame && frame !== page.mainFrame() && frame.url().includes(appId);
  };
  page.on('request', (request) => {
    if (fromApp(request)) seen.appRequests++;
  });
  page.on('requestfinished', async (request) => {
    if (!fromApp(request) || !telemetryHosts.test(request.url())) return;
    const shape = requestShape(request);
    const status = (await request.response().catch(() => null))?.status() ?? 0;
    seen.push({ host: new URL(request.url()).host, status, ...shape });
  });
  page.on('requestfailed', (request) => {
    if (fromApp(request) && telemetryHosts.test(request.url()))
      seen.push({ host: new URL(request.url()).host, blocked: request.failure()?.errorText });
  });
  return seen;
}

export async function snapshotJourney({ page, owned, blank, testInfo, retainLinked = false }) {
  const egress = watchAppEgress(page);
  await dismissOnboarding(page);
  const setup = await observeAction(
    page,
    'setup',
    () => projectPage(page, 'agent-prompts', owned.project.key),
    installation('agent-prompts'),
  );
  const source = await owned.propertyIssue(
    `Error handling ${owned.run.state.runId.slice(0, 8)}`,
    `SNAPSHOT-PROMPT-${owned.run.state.runId}`,
    setup.type,
  );
  const searchLink = page.getByRole('link', { name: 'View in Jira', exact: true });
  await expect(searchLink).toHaveAttribute('href', new RegExp('jql='));
  const searchUrl = new URL(await searchLink.getAttribute('href'), activeTarget().site);
  expect(searchUrl.searchParams.get('jql')).toBe(
    `project = ${owned.project.id} AND issuetype = ${setup.type} ORDER BY key ASC`,
  );
  const marker = markers.runMarker(owned.run.state.runId, owned.run.state.resources.length);
  const target = blank
    ? await owned.run.create('issue', {
        summary: 'Native blank Description round-trip',
        labels: [marker],
        description: null,
        marker,
        comments: [],
      })
    : await owned.issue('Native synced prompt comparison');
  const editorSource = structuredClone(source.expected.description);
  editorSource.content[0].attrs = { localId: `editor-${owned.run.state.runId}` };
  source.expected.descriptionVariants = [source.expected.description, editorSource];
  owned.run.persist();
  await owned.api(`/issue/${source.id}`, 'PUT', { fields: { description: editorSource } });
  const sourceIssue = await owned.api(`/issue/${source.id}?fields=summary,description,issuetype`);
  const targetIssue = await owned.api(`/issue/${target.id}?fields=description`);
  const sentinel = `SNAPSHOT-PROMPT-${owned.run.state.runId}`;
  owned.run.state.snapshotIntent = { sourceId: source.id, targetId: target.id, sentinel };
  owned.run.persist();
  const field = (await owned.api('/field')).find(
    (f) =>
      f.schema?.custom?.includes(`/${installation('agent-prompts').appId}/`) &&
      f.schema.custom.includes(installation('agent-prompts').environmentId) &&
      f.name === 'Agent Prompts',
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
  const calls = [];
  page.on('request', (r) => {
    try {
      const i = r.postDataJSON()?.variables?.input;
      if (
        i?.extensionId?.includes(installation('agent-prompts').appId) &&
        i?.payload?.call?.functionKey
      )
        calls.push(i.payload.call.functionKey);
    } catch {
      /* unrelated */
    }
  });
  await page.goto(`${activeTarget().site}/browse/${targetIssue.key}`);
  const readView = page
    .getByRole('button', { name: /^(Agent Prompts, .*edit|Edit Agent Prompts)$/ })
    .locator('..')
    .locator('[data-component-selector="jira-issue-view-select-inline-edit-read-view-container"]');
  await expect(readView).toBeVisible();
  await page.waitForTimeout(1500);
  expect(calls).toEqual([]);
  const started = Date.now();
  const loaded = await observeAction(
    page,
    'load',
    () => readView.click({ position: { x: 2, y: 2 } }),
    installation('agent-prompts'),
  );
  owned.run.state.loadedPromptIds = loaded.prompts.map((p) => p.id);
  owned.run.persist();
  expect(loaded.prompts.map((p) => p.id)).toContain(source.id);
  const combo = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
  await expect(combo).toBeEnabled();
  owned.run.state.nativePickerMs = Date.now() - started;
  await expect(editor(page).getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(editor(page).getByRole('button', { name: 'Sync', exact: true })).toBeDisabled();

  await observeAction(
    page,
    'library',
    () =>
      editor(page)
        .getByRole('combobox', { name: 'Agent Prompts', exact: true })
        .fill(sourceIssue.key),
    installation('agent-prompts'),
  );
  await combo.press('ArrowDown');
  await editor(page)
    .getByText(`${sourceIssue.key} — ${source.expected.summary}`, { exact: true })
    .click();
  expect(calls).toContain('library');
  async function save(action = 'Save') {
    const click = () => editor(page).getByRole('button', { name: action, exact: true }).click();
    if (loaded.refreshAfterSave) {
      // Navigation can discard the resolver body. The independent Jira assertions
      // below verify each mutation; do not make a response-body race the oracle.
      await Promise.all([
        page.waitForEvent('framenavigated', { predicate: (frame) => frame === page.mainFrame() }),
        click(),
      ]);
    } else {
      await observeAction(page, 'save', click, installation('agent-prompts'));
    }
    if (loaded.refreshAfterSave) {
      await observeAction(
        page,
        'load',
        () => readView.click({ position: { x: 2, y: 2 } }),
        installation('agent-prompts'),
      );
    } else {
      await expect(
        editor(page).getByText(action === 'Sync' ? '✓ Synced' : 'Saved.', { exact: true }),
      ).toBeVisible();
    }
    await expect(combo).toBeEnabled();
    await expect(editor(page).getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  }
  const expectedLinked = {
    ...(target.expected.description ?? { type: 'doc', version: 1 }),
    content: [
      ...(target.expected.description?.content ?? []),
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
  target.expected.descriptionVariants = [target.expected.description, expectedLinked];
  target.expected.customField = { id: field.id, value: [sourceIssue.key] };
  owned.run.persist();
  await save();
  const linked = (await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields;
  expect(linked.description.content.slice(0, -1)).toEqual(
    target.expected.description?.content ?? [],
  );
  const ref = linked.description.content.at(-1);
  expect(ref.type).toBe('expand');
  expect(ref.attrs).toEqual({ localId: `npl-${target.id}`, title: 'Agent Prompts' });
  expect(ref.content.slice(1)).toEqual(source.expected.description.content);
  expect(JSON.stringify(linked.description)).toContain(sentinel);
  expect(linked[field.id]).toEqual([sourceIssue.key]);
  target.expected.descriptionVariants = [target.expected.description, linked.description];
  target.expected.customField = { id: field.id, value: linked[field.id] };
  owned.run.persist();
  if (retainLinked) {
    return {
      sourceId: source.id,
      sourceKey: sourceIssue.key,
      targetId: target.id,
      targetKey: targetIssue.key,
      fieldId: field.id,
      linked,
      sourceFields: (await owned.api(`/issue/${source.id}?fields=description,summary,issuetype`))
        .fields,
    };
  }
  // Only the test explicitly reloads, after asserting the editor remained mounted.
  await page.reload();
  await page.getByRole('button', { name: 'Agent Prompts', exact: true }).click();
  await expect(page.getByText(sentinel, { exact: false })).toBeVisible();
  // Ordinary API edits are now sufficient: no native synced-block publishing.
  const updated = adf(`${sentinel}-UPDATED`);
  source.expected.descriptionVariants = [...source.expected.descriptionVariants, updated];
  owned.run.persist();
  await owned.api(`/issue/${source.id}`, 'PUT', { fields: { description: updated } });
  expect((await owned.api(`/issue/${target.id}?fields=description`)).fields.description).toEqual(
    linked.description,
  );
  await readView.click({ position: { x: 2, y: 2 } });
  await expect(combo).toBeEnabled();
  const expectedRefresh = structuredClone(expectedLinked);
  expectedRefresh.content.at(-1).content.splice(1, Infinity, ...updated.content);
  target.expected.descriptionVariants.push(expectedRefresh);
  owned.run.persist();
  await save('Sync');
  const refreshed = (await owned.api(`/issue/${target.id}?fields=description`)).fields.description;
  expect(refreshed.content.slice(0, -1)).toEqual(linked.description.content.slice(0, -1));
  expect(refreshed.content.at(-1).content[1]).toEqual(updated.content[0]);
  target.expected.descriptionVariants.push(refreshed);
  owned.run.persist();
  await page.screenshot({
    path: `${activeTarget().runs}/${owned.run.state.runId}-snapshot-refresh.png`,
  });
  await editor(page)
    .getByRole('button', { name: /remove.*Error handling/i })
    .click();
  const unlinkedDescription = blank
    ? { type: 'doc', version: 1, content: [] }
    : target.expected.description;
  target.expected.descriptionVariants.push(unlinkedDescription);
  owned.run.persist();
  await save();
  const cleared = (await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields;
  expect(cleared.description).toEqual(unlinkedDescription);
  expect(cleared[field.id] ?? []).toEqual([]);
  target.expected.customField = { id: field.id, value: cleared[field.id] };
  owned.run.persist();
  if (blank) {
    await page.reload();
    await readView.click({ position: { x: 2, y: 2 } });
    await expect(combo).toBeEnabled();
    await expect(page.getByText(/earlier save|outcome is uncertain/i)).toHaveCount(0);
  }
  // No telemetry request from the field may succeed; blocked or absent attempts are expected.
  testInfo.annotations.push({
    type: 'app-telemetry',
    description: JSON.stringify({ appRequests: egress.appRequests, telemetry: egress }),
  });
  expect(egress.appRequests).toBeGreaterThan(0);
  expect(egress.filter((request) => request.status >= 200 && request.status < 400)).toEqual([]);
}

// Resume a pre-upgrade target: prove the old stored ownership still supports Sync and removal.
export async function resumeLinkedJourney({ page, owned, backup }) {
  const target = owned.run.state.resources.find((r) => r.id === backup.targetId);
  const source = owned.run.state.resources.find((r) => r.id === backup.sourceId);
  expect(target && source).toBeTruthy();
  const installationTarget = installation('agent-prompts');
  const updated = adf(`UPGRADE-SYNC-${owned.run.state.runId}`);
  source.expected.descriptionVariants.push(updated);
  owned.run.persist();
  await owned.api(`/issue/${source.id}`, 'PUT', { fields: { description: updated } });
  const fields = async () =>
    (await owned.api(`/issue/${target.id}?fields=description,${backup.fieldId}`)).fields;
  expect(await fields()).toEqual(backup.linked);
  await page.goto(`${activeTarget().site}/browse/${backup.targetKey}`);
  const readView = page
    .getByRole('button', { name: /^(Agent Prompts, .*edit|Edit Agent Prompts)$/ })
    .locator('..')
    .locator('[data-component-selector="jira-issue-view-select-inline-edit-read-view-container"]');
  const loaded = await observeAction(
    page,
    'load',
    () => readView.click({ position: { x: 2, y: 2 } }),
    installationTarget,
  );
  expect(loaded.ids).toEqual([source.id]);
  expect(loaded.refreshAfterSave).toBe(false);
  const refreshed = structuredClone(backup.linked.description);
  refreshed.content.at(-1).content.splice(1, Infinity, ...updated.content);
  target.expected.descriptionVariants.push(refreshed);
  owned.run.persist();
  await observeAction(
    page,
    'save',
    () => editor(page).getByRole('button', { name: 'Sync', exact: true }).click(),
    installationTarget,
  );
  expect(await fields()).toEqual({ description: refreshed, [backup.fieldId]: [backup.sourceKey] });
  await editor(page)
    .getByRole('button', { name: /remove.*Error handling/i })
    .click();
  // The original ordinary Description is already a journaled allowed outcome.
  await observeAction(
    page,
    'save',
    () => editor(page).getByRole('button', { name: 'Save', exact: true }).click(),
    installationTarget,
  );
  const cleared = await fields();
  expect(cleared.description).toEqual(target.expected.description);
  expect(cleared[backup.fieldId] ?? []).toEqual([]);
  target.expected.customField = { id: backup.fieldId, value: cleared[backup.fieldId] };
  owned.run.persist();
}
