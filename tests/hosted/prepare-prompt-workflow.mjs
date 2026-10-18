import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tokenRequest, client } from '@srcplugins/atlassian-forge-test-framework/jira';
import {
  activeTarget,
  fixtureProject,
  isMarker,
  markers,
  siteFor,
} from '@srcplugins/atlassian-forge-test-framework/core';
import { expect } from './support/expect.mjs';
import { agentPromptsFixture } from './support/fixture.mjs';

// Gives the company-managed fixture space's Prompt workflow the statuses the website
// documentation recommends: Prompt available (To Do category) and Prompt retired (Done category),
// with a Retire and a Make available transition and no transition screen. It writes only when the workflow still has its
// earlier form (Prompt available alone, no transitions), and only when that workflow and its
// scheme belong to this space alone. The intent is journaled before the one write, after Jira's
// validation passes; a journal left mid-update stops a rerun until inspected. Boards are not
// edited: the runner fails when either status is mapped to a column of the space's boards.
assert.equal(
  process.env.NATIVE_PROMPT_WORKFLOW_PREPARE,
  '1',
  'Explicit fixture preparation required',
);
const target = activeTarget();
assert.equal(target.host, siteFor('primary'), 'The fixture space lives on the primary site');
const key = fixtureProject(agentPromptsFixture);
const journal = `${target.directory}/prompt-workflow-${key}.json`;
const AVAILABLE = 'Prompt available';
const RETIRED = 'Prompt retired';
const request = await tokenRequest();
const api = client(request);
const save = (data) => writeFileSync(journal, JSON.stringify(data), { mode: 0o600 });
try {
  const project = await api(`/project/${key}`);
  assert.ok(
    isMarker(project?.description, markers.browserProject(agentPromptsFixture)) &&
      project.key === key &&
      project.style === 'classic',
    `Space ownership mismatch ${key}`,
  );
  const scheme = (await api(`/workflowscheme/project?projectId=${project.id}`)).values[0]
    ?.workflowScheme;
  const mappings = Object.entries(scheme?.issueTypeMappings ?? {});
  assert.equal(mappings.length, 1, 'The workflow scheme maps more than one work type; inspect it');
  const [[typeId, name]] = mappings;
  assert.equal(
    (await api(`/issuetype/${typeId}`))?.name,
    'Prompt',
    'The mapped type is not Prompt',
  );
  assert.notEqual(scheme.defaultWorkflow, name, 'The Prompt workflow is the default one');
  const found = (await api(`/workflow/search?workflowName=${encodeURIComponent(name)}`)).values;
  assert.equal(found.length, 1, 'The Prompt workflow name is ambiguous; inspect it');
  const workflowId = found[0].id.entityId;
  const spaces = async (path) => JSON.stringify((await api(path)).projects.values.map((p) => p.id));
  const only = JSON.stringify([project.id]);
  assert.equal(
    await spaces(`/workflowscheme/${scheme.id}/projectUsages?maxResults=50`),
    only,
    'Another space uses the workflow scheme; inspect it',
  );
  assert.equal(
    await spaces(`/workflow/${workflowId}/projectUsages?maxResults=50`),
    only,
    'Another space uses the Prompt workflow; inspect it',
  );
  const read = async () => {
    const result = await api('/workflows', 'POST', { workflowIds: [workflowId] });
    assert.equal(result.workflows.length, 1);
    return { statuses: result.statuses, workflow: result.workflows[0] };
  };
  // The workflow by status names, so the check doesn't depend on site-specific IDs.
  const shape = ({ statuses, workflow }) => {
    const status = (ref) => statuses.find((s) => s.statusReference === ref);
    return {
      statuses: workflow.statuses
        .map(
          (s) => `${status(s.statusReference)?.name} ${status(s.statusReference)?.statusCategory}`,
        )
        .sort(),
      transitions: workflow.transitions
        .map((t) =>
          [
            t.type,
            t.name,
            t.links.map((l) => status(l.fromStatusReference)?.name).join(),
            status(t.toStatusReference)?.name,
            t.transitionScreen ? 'screen' : 'no screen',
          ].join(' | '),
        )
        .sort(),
    };
  };
  const earlier = {
    statuses: [`${AVAILABLE} TODO`],
    transitions: [`INITIAL | Create |  | ${AVAILABLE} | no screen`],
  };
  const prepared = {
    statuses: [`${AVAILABLE} TODO`, `${RETIRED} DONE`],
    transitions: [
      `DIRECTED | Make available | ${RETIRED} | ${AVAILABLE} | no screen`,
      `DIRECTED | Retire | ${AVAILABLE} | ${RETIRED} | no screen`,
      `INITIAL | Create |  | ${AVAILABLE} | no screen`,
    ],
  };
  const typeStatuses = async () =>
    (await api(`/project/${project.id}/statuses`)).map((t) => [
      t.id,
      t.statuses.map((s) => s.id).sort(),
    ]);
  const before = await read();
  if (JSON.stringify(shape(before)) !== JSON.stringify(prepared)) {
    assert.deepEqual(
      shape(before),
      earlier,
      'The Prompt workflow differs from the earlier and the prepared form; inspect it',
    );
    if (existsSync(journal) && JSON.parse(readFileSync(journal, 'utf8')).status !== 'verified')
      throw Error(`Unresolved workflow update ${journal}; inspect before retry`);
    const others = (await typeStatuses()).filter(([id]) => id !== typeId);
    // Reuse a global Prompt retired status left by an earlier attempt; never create a second one.
    const existing = (
      await api(`/statuses/search?searchString=${encodeURIComponent(RETIRED)}&maxResults=50`)
    ).values.filter((s) => s.name === RETIRED);
    assert.ok(existing.length <= 1, 'More than one Prompt retired status; inspect them');
    if (existing[0]) assert.equal(existing[0].statusCategory, 'DONE', 'Prompt retired is not Done');
    const retired = existing[0]?.id ?? randomUUID();
    const available = before.workflow.statuses[0].statusReference;
    const transition = (id, name, from, to) => ({
      id,
      type: 'DIRECTED',
      name,
      description: '',
      toStatusReference: to,
      links: [{ fromStatusReference: from }],
      actions: [],
      validators: [],
      triggers: [],
      properties: {},
    });
    const payload = {
      statuses: [
        ...before.statuses.map(({ id, name, statusCategory, statusReference, description }) => ({
          id,
          name,
          statusCategory,
          statusReference,
          description,
        })),
        {
          ...(existing[0] ? { id: retired } : {}),
          name: RETIRED,
          statusCategory: 'DONE',
          statusReference: retired,
          description:
            existing[0]?.description ?? 'Retired prompt: Agent Prompts no longer offers it.',
        },
      ],
      workflows: [
        {
          id: workflowId,
          version: before.workflow.version,
          description:
            'Prompt work items only: Prompt available and Prompt retired, a transition each way.',
          startPointLayout: before.workflow.startPointLayout,
          statuses: [
            ...before.workflow.statuses.map(({ statusReference, layout, properties }) => ({
              statusReference,
              layout,
              properties,
            })),
            { statusReference: retired, layout: { x: 400, y: 0 }, properties: {} },
          ],
          transitions: [
            ...before.workflow.transitions,
            transition('11', 'Retire', available, retired),
            transition('21', 'Make available', retired, available),
          ],
        },
      ],
    };
    const { errors = [] } = await api('/workflows/update/validation', 'POST', {
      payload,
      validationOptions: { levels: ['ERROR', 'WARNING'] },
    });
    for (const e of errors) console.log(`Validation ${e.level} ${e.code}: ${e.message}`);
    assert.ok(!errors.some((e) => e.level === 'ERROR'), 'Jira refused the workflow update');
    mkdirSync(target.directory, { recursive: true });
    save({
      key,
      projectId: project.id,
      workflowId,
      from: before.workflow.version,
      status: 'updating',
    });
    const result = await api('/workflows/update', 'POST', payload);
    if (result?.taskId)
      await expect(async () =>
        expect((await api(`/task/${result.taskId}`))?.status).toBe('COMPLETE'),
      ).toPass({ timeout: 120000, intervals: [2000, 5000] });
    const after = await read();
    assert.deepEqual(shape(after), prepared);
    assert.deepEqual(
      (await typeStatuses()).filter(([id]) => id !== typeId),
      others,
      'The statuses of another work type changed',
    );
    save({
      key,
      projectId: project.id,
      workflowId,
      from: before.workflow.version,
      to: after.workflow.version,
      retiredStatusId: after.statuses.find((s) => s.name === RETIRED).id,
      status: 'verified',
    });
    console.log('Prompt workflow has Prompt available and Prompt retired');
  }
  // Prompts stay off every board of the space: neither status may be in a column.
  const { statuses } = await read();
  const ids = statuses.map((s) => s.id);
  const agile = async (path) => {
    const response = await request.fetch(`${target.site}/rest/agile/1.0${path}`, {
      timeout: 30000,
      maxRedirects: 0,
    });
    assert.ok(response.ok(), `Board request failed (HTTP ${response.status()})`);
    return response.json();
  };
  for (const board of (await agile(`/board?projectKeyOrId=${project.id}`)).values ?? []) {
    const { columnConfig } = await agile(`/board/${board.id}/configuration`);
    const mapped = columnConfig.columns.flatMap((c) => c.statuses.map((s) => s.id));
    assert.deepEqual(
      ids.filter((id) => mapped.includes(id)),
      [],
      `A Prompt status is in a column of board ${board.id}; move it to Unmapped statuses`,
    );
  }
  console.log(`${key}: Prompt workflow ready`);
} finally {
  await request.dispose();
}
