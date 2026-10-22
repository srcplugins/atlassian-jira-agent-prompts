import { gunzipSync } from 'node:zlib';
import {
  installation,
  observeAction,
  dismissOnboarding,
  adf,
} from '@srcplugins/atlassian-forge-test-framework/jira';
import { activeTarget, markers } from '@srcplugins/atlassian-forge-test-framework/core';
import { expect } from './expect.mjs';
import { spaceHealth } from './space-settings.mjs';
import { agentPromptsField, fieldReadView } from './field.mjs';
/** Searches for a retired prompt's exact key: the resolver must return no prompts. */
async function searchHides(page, combo, key, id) {
  const found = await observeAction(
    page,
    'search',
    () => combo.fill(key),
    installation('agent-prompts'),
  );
  expect(found.prompts.map((p) => p.id)).not.toContain(id);
  expect(found.prompts).toEqual([]);
}
export function editor(page) {
  const t = installation('agent-prompts');
  return page.frameLocator(`iframe[src*="${t.appId}"][src*="${t.environmentId}"]`);
}
/**
 * Opens the field's editor from its read view. On a slower host (GitHub's runners) Jira can drop
 * a click on a freshly loaded work item before it is interactive, so click again until the
 * editor shows. Opening only reads; a second click lands only when the first opened nothing.
 * When Jira fails the editor's own read, press its Try again, which only reads again.
 */
export async function openField(page, readView) {
  const combo = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
  const retry = editor(page).getByRole('button', { name: 'Try again', exact: true });
  await expect(async () => {
    if (await retry.isVisible()) await retry.click({ timeout: 5000 });
    else if (!(await combo.isVisible()))
      await readView.click({ position: { x: 2, y: 2 }, timeout: 5000 });
    await expect(combo).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 40000, intervals: [1000, 3000] });
}
/**
 * Expands the description's Agent Prompts section until `text` shows. Like `openField`, a click
 * on a freshly loaded work item can be dropped; click only while the section reports collapsed.
 */
export async function expandPrompts(page, text) {
  const section = page.getByRole('button', { name: 'Agent Prompts', exact: true });
  await expect(async () => {
    if ((await section.getAttribute('aria-expanded', { timeout: 5000 })) !== 'true')
      await section.click({ timeout: 5000 });
    await expect(page.getByText(text, { exact: false })).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 40000, intervals: [1000, 3000] });
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
  // Positive control: the iframe's own assets must be observed, or zero telemetry proves nothing.
  const seen = Object.assign(
    /** @type {Array<{ host: string, status?: number, blocked?: string }>} */ ([]),
    {
      appRequests: 0,
    },
  );
  // The app's space page URL contains the app ID too, so exclude Jira's own main frame.
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

/**
 * Saves a prompt to a work item, Syncs an edit to it and removes it. With `retire`, the prompt is
 * moved to its work type's Done-category status after the first save: search must stop offering
 * it, while the work item keeps it, labelled, and Sync still copies its text. The space's prompt
 * type comes from its health in space settings, read through `page`; a caller whose `page` is an
 * ordinary user, who can't open space settings, passes `promptType` from an administrator's read.
 */
export async function snapshotJourney({
  page,
  owned,
  blank,
  testInfo,
  retainSaved = false,
  retire = false,
  editInJira = false,
  promptType = undefined,
}) {
  const egress = watchAppEgress(page);
  await dismissOnboarding(page);
  const type = promptType ?? (await spaceHealth(page, owned.project)).state.data.type;
  expect(type).toBeTruthy();
  const source = await owned.propertyIssue(
    `Error handling ${owned.run.state.runId.slice(0, 8)}`,
    `SNAPSHOT-PROMPT-${owned.run.state.runId}`,
    type,
  );
  const marker = markers.runMarker(owned.run.state.runId, owned.run.state.resources.length);
  const target = blank
    ? await owned.run.create('issue', {
        summary: 'Blank Description round-trip',
        labels: [marker],
        description: null,
        marker,
        comments: [],
      })
    : await owned.issue('Synced prompt comparison');
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
  const field = await agentPromptsField(owned.api);
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
  const readView = fieldReadView(page, field.id);
  await expect(readView).toBeVisible();
  await page.waitForTimeout(1500);
  expect(calls).toEqual([]);
  const started = Date.now();
  const loaded = await observeAction(
    page,
    'load',
    () => openField(page, readView),
    installation('agent-prompts'),
  );
  owned.run.state.loadedPromptIds = loaded.prompts.map((p) => p.id);
  owned.run.persist();
  expect(loaded.prompts.map((p) => p.id)).toContain(source.id);
  const combo = editor(page).getByRole('combobox', { name: 'Agent Prompts', exact: true });
  await expect(combo).toBeEnabled();
  owned.run.state.pickerMs = Date.now() - started;
  await expect(editor(page).getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  // With no prompts saved, Sync is still offered: it removes any Agent Prompts section added by hand.
  await expect(editor(page).getByRole('button', { name: 'Sync', exact: true })).toBeEnabled();

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
  await editor(page)
    .getByText(`${sourceIssue.key} — ${source.expected.summary}`, { exact: true })
    .click();
  expect(calls).toContain('search');
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
      await openField(page, readView);
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
        attrs: { localId: `agent-prompts-${target.id}`, title: 'Agent Prompts' },
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
  expect(ref.attrs).toEqual({ localId: `agent-prompts-${target.id}`, title: 'Agent Prompts' });
  expect(ref.content.slice(1)).toEqual(source.expected.description.content);
  expect(JSON.stringify(linked.description)).toContain(sentinel);
  expect(linked[field.id]).toEqual([sourceIssue.key]);
  target.expected.descriptionVariants = [target.expected.description, linked.description];
  target.expected.customField = { id: field.id, value: linked[field.id] };
  owned.run.persist();
  if (retainSaved) {
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
  await expandPrompts(page, sentinel);
  // A person edits the Description in Jira's own editor, which round-trips the whole document,
  // the Agent Prompts section included. Sync and removal must still recognise the section.
  let saved = linked.description;
  if (editInJira) {
    const note = `Edited in Jira ${owned.run.state.runId.slice(0, 8)}`;
    const description = page.getByTestId('issue.views.field.rich-text.description');
    await description.click();
    // The editor's document box; the section's expand has its own nested text box.
    const content = page.locator('#ak-editor-textarea');
    await expect(content).toBeVisible();
    await content.press('ControlOrMeta+Home');
    await page.keyboard.type(note);
    await page.keyboard.press('Enter');
    // The editor's document is unknown until saved: journal that a save is pending, which no
    // description matches, so an interrupted run stops cleanup for inspection.
    target.expected.descriptionVariants.push({ pendingJiraEditorSave: note });
    owned.run.persist();
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await expect(async () => {
      const now = (await owned.api(`/issue/${target.id}?fields=description`)).fields.description;
      expect(JSON.stringify(now)).toContain(note);
      saved = now;
    }).toPass({ timeout: 30000, intervals: [1000, 3000] });
    target.expected.descriptionVariants.splice(-1, 1, saved);
    owned.run.persist();
    await testInfo.attach('jira-editor-description', {
      body: JSON.stringify(saved, null, 1),
      contentType: 'application/json',
    });
    // Jira's mobile editor also gives every node inside the section except text its own 12-hex
    // `localId` when it saves (agent-prompts#netc); the desktop editor above doesn't, so write it.
    const stamped = structuredClone(saved);
    const ownSection = stamped.content.find(
      (n) => n.type === 'expand' && n.attrs?.localId === `agent-prompts-${target.id}`,
    );
    let stamps = 0;
    const stamp = (node) => {
      node.attrs = { ...node.attrs, localId: (0xa9e000000000 + stamps++).toString(16) };
      node.content?.filter((child) => child.type !== 'text').forEach(stamp);
    };
    ownSection.content.forEach(stamp);
    target.expected.descriptionVariants.push(stamped);
    owned.run.persist();
    await owned.api(`/issue/${target.id}`, 'PUT', { fields: { description: stamped } });
    saved = (await owned.api(`/issue/${target.id}?fields=description`)).fields.description;
    expect(saved).toEqual(stamped);
    await page.reload();
  }
  if (retire) {
    const { transitions } = await owned.api(`/issue/${source.id}/transitions`);
    const retiring = transitions.find((t) => t.to?.statusCategory?.key === 'done');
    if (!retiring)
      throw Error(
        'Fixture lacks a Done-category transition; run NATIVE_PROMPT_WORKFLOW_PREPARE=1 node tests/hosted/prepare-prompt-workflow.mjs.',
      );
    const { status } = (await owned.api(`/issue/${source.id}?fields=status`)).fields;
    source.expected.statusIds = [...new Set([status.id, retiring.to.id])];
    owned.run.persist();
    await owned.api(`/issue/${source.id}/transitions`, 'POST', {
      transition: { id: retiring.id },
    });
    // Search reads Jira's index, which lags the transition.
    await expect(async () => {
      const ids = async (jql) =>
        (
          await owned.api('/search/jql', 'POST', { jql, maxResults: 1, fields: ['summary'] })
        ).issues.map((i) => i.id);
      expect(await ids(`key = ${sourceIssue.key} AND statusCategory != Done`)).toEqual([]);
      expect(await ids(`key = ${sourceIssue.key} AND statusCategory = Done`)).toEqual([source.id]);
    }).toPass({ timeout: 60000, intervals: [1000, 3000] });
  }
  // Ordinary API edits are now sufficient: no synced-block publishing.
  const updated = adf(`${sentinel}-UPDATED`);
  source.expected.descriptionVariants = [...source.expected.descriptionVariants, updated];
  owned.run.persist();
  await owned.api(`/issue/${source.id}`, 'PUT', { fields: { description: updated } });
  expect((await owned.api(`/issue/${target.id}?fields=description`)).fields.description).toEqual(
    saved,
  );
  // Everything outside the section, as last saved; the section itself is found by its id.
  const ownId = `agent-prompts-${target.id}`;
  const outside = (doc) =>
    doc.content.filter((n) => n.type !== 'expand' || n.attrs?.localId !== ownId);
  const section = (doc) =>
    doc.content.find((n) => n.type === 'expand' && n.attrs?.localId === ownId);
  if (retire) {
    const reopened = await observeAction(
      page,
      'load',
      () => openField(page, readView),
      installation('agent-prompts'),
    );
    expect(reopened.ids).toEqual([source.id]);
    expect(reopened.prompts.find((p) => p.id === source.id)).toEqual({
      id: source.id,
      key: sourceIssue.key,
      name: `${source.expected.summary} (retired)`,
      selectedOnly: true,
    });
    await expect(
      editor(page).getByText(`${sourceIssue.key} — ${source.expected.summary} (retired)`, {
        exact: true,
      }),
    ).toBeVisible();
    await searchHides(page, combo, sourceIssue.key, source.id);
    await observeAction(page, 'search', () => combo.fill(''), installation('agent-prompts'));
  } else await openField(page, readView);
  await expect(combo).toBeEnabled();
  const expectedRefresh = structuredClone(expectedLinked);
  expectedRefresh.content.at(-1).content.splice(1, Infinity, ...updated.content);
  target.expected.descriptionVariants.push(expectedRefresh);
  if (editInJira) {
    // The app writes its own section in place of the edited one, without the editor's ids.
    const own = section(saved);
    target.expected.descriptionVariants.push({
      ...saved,
      content: saved.content.map((n) => (n === own ? section(expectedRefresh) : n)),
    });
  }
  owned.run.persist();
  await save('Sync');
  const refreshed = (await owned.api(`/issue/${target.id}?fields=description`)).fields.description;
  expect(outside(refreshed)).toEqual(outside(saved));
  expect(section(refreshed).content[1]).toEqual(updated.content[0]);
  if (editInJira) expect(section(refreshed)).toEqual(section(expectedRefresh));
  target.expected.descriptionVariants.push(refreshed);
  owned.run.persist();
  await page.screenshot({
    path: `${activeTarget().runs}/${owned.run.state.runId}-snapshot-refresh.png`,
  });
  await editor(page)
    .getByRole('button', { name: /remove.*Error handling/i })
    .click();
  const removedDescription = editInJira
    ? { ...saved, content: outside(saved) }
    : blank
      ? { type: 'doc', version: 1, content: [] }
      : target.expected.description;
  target.expected.descriptionVariants.push(removedDescription);
  owned.run.persist();
  await save();
  const cleared = (await owned.api(`/issue/${target.id}?fields=description,${field.id}`)).fields;
  expect(cleared.description).toEqual(removedDescription);
  expect(cleared[field.id] ?? []).toEqual([]);
  target.expected.customField = { id: field.id, value: cleared[field.id] };
  owned.run.persist();
  if (retire) {
    await searchHides(page, combo, sourceIssue.key, source.id);
    await expect(
      editor(page).getByText(`${sourceIssue.key} — ${source.expected.summary} (retired)`, {
        exact: true,
      }),
    ).toHaveCount(0);
  }
  if (blank) {
    await page.reload();
    await openField(page, readView);
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
export async function resumeSavedJourney({ page, owned, backup }) {
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
  const readView = fieldReadView(page, backup.fieldId);
  const loaded = await observeAction(
    page,
    'load',
    () => openField(page, readView),
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
