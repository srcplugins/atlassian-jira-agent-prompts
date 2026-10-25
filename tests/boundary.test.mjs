import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createPorts, registerResolvers } = await import('../src/integration.ts');
const { JiraRejected, JiraUnavailable } = await import('../src/service.ts');
import { forgeContract } from './support/forge-contract.mjs';
const context = { accountId: 'actor', extension: { project: { id: '1' } } };
const project = {
  id: '1',
  key: 'TEST',
  style: 'classic',
  projectTypeKey: 'software',
  issueTypes: [],
};
const sdk = (...responses) => ({
  ...forgeContract(...responses),
  kvs: { entity: () => ({ get: async () => undefined }) },
  fieldType: () => 'exact-field',
  appContext: () => ({ environmentType: 'DEVELOPMENT' }),
});
test('space inventory uses asUser live-software pagination and marks team-managed spaces', async () => {
  const { createBatchPorts } = await import('../src/integration.ts');
  const s = sdk(
    {
      body: {
        startAt: 0,
        isLast: false,
        values: [
          { id: '1', key: 'ONE', name: 'One', style: 'classic' },
          { id: '2', key: 'TWO', name: 'Two', style: 'next-gen' },
        ],
      },
    },
    {
      body: {
        startAt: 2,
        isLast: true,
        values: [{ id: '3', key: 'THREE', name: 'Three', style: 'classic' }],
      },
    },
  );
  assert.deepEqual(await createBatchPorts(s).projects(), {
    projects: [
      { id: '1', key: 'ONE', name: 'One', teamManaged: false },
      { id: '2', key: 'TWO', name: 'Two', teamManaged: true },
      { id: '3', key: 'THREE', name: 'Three', teamManaged: false },
    ],
    incomplete: false,
  });
  assert.equal(
    s.calls[1].path,
    '/rest/api/3/project/search?typeKey=software&status=live&orderBy=key&startAt=2&maxResults=100',
  );
  assert.ok(s.calls.every((c) => c.actor === 'asUser'));
});
test('malformed inventory paging never claims a complete site inventory', async () => {
  const { createBatchPorts } = await import('../src/integration.ts');
  for (const body of [
    { startAt: 1, isLast: true, values: [] },
    { startAt: 0, isLast: false, values: [] },
    { startAt: 0, isLast: true, values: [{ id: '1', key: 'ONE', name: 'One' }] },
  ])
    await assert.rejects(createBatchPorts(sdk({ body })).projects());
});
test('configuration handlers reject payload injection and recheck global administrator permission', async () => {
  for (const action of ['configuration-catalog', 'configuration-status']) {
    for (const payload of [{ projectId: '1' }, { accountId: 'admin' }]) {
      const s = sdk();
      assert.equal((await registerResolvers(s)[action]({ context, payload })).ok, false);
      assert.equal(s.calls.length, 0);
    }
    const s = sdk({ body: { permissions: { ADMINISTER: { havePermission: false } } } });
    assert.equal((await registerResolvers(s)[action]({ context, payload: {} })).ok, false);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].path, '/rest/api/3/mypermissions?permissions=ADMINISTER');
  }
  // A run's one-time key, when sent, must be a non-empty string.
  for (const action of ['configuration-advance', 'configuration-stop'])
    for (const key of ['', 5, null, {}]) {
      const s = sdk();
      const result = await registerResolvers(s)[action]({
        context,
        payload: { id: 'x', revision: 0, key },
      });
      assert.equal(result.ok, false);
      assert.equal(s.calls.length, 0);
    }
});
test('actual setup handler verifies trusted space through asUser without loading prompts', async () => {
  const s = sdk({ body: project });
  const value = await registerResolvers(s).setup({ context, payload: {} });
  assert.equal(value.ok, true);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].actor, 'asUser');
  assert.equal(s.calls[0].path, '/rest/api/3/project/1');
});
test('invalid context and target injection rejected before API calls', async () => {
  for (const request of [{ context: {} }, { context, payload: { issueId: '2' } }]) {
    const s = sdk();
    assert.equal((await registerResolvers(s).load(request)).ok, false);
    assert.equal(s.calls.length, 0);
  }
});
test('work item recovery binds trusted target and refuses malformed or denied administrator release', async () => {
  const issueContext = { ...context, extension: { project: { id: '1' }, issue: { id: '10' } } };
  for (const name of ['save-status', 'resolve-save']) {
    for (const payload of [{ issueId: '20' }, { accountId: 'admin' }]) {
      const s = sdk();
      const result = await registerResolvers(s)[name]({ context: issueContext, payload });
      assert.equal(result.ok, false);
      assert.equal(s.calls.length, 0);
    }
  }
  const malformed = sdk();
  assert.equal(
    (
      await registerResolvers(malformed)['resolve-save']({
        context: issueContext,
        payload: { revision: 1, fingerprint: 'review', acknowledged: false },
      })
    ).ok,
    false,
  );
  assert.equal(malformed.calls.length, 0);
  const denied = sdk({ body: { permissions: { ADMINISTER: { havePermission: false } } } });
  const result = await registerResolvers(denied)['resolve-save']({
    context: issueContext,
    payload: { revision: 1, fingerprint: 'review', acknowledged: true },
  });
  assert.equal(result.ok, false);
  assert.equal(denied.calls.length, 1);
  assert.equal(denied.calls[0].actor, 'asUser');
  assert.match(denied.calls[0].path, /permissions=ADMINISTER/);
});
test('denial and malformed responses fail at once; a network failure is read three times', async () => {
  for (const response of [
    { status: 403 },
    { status: 429 },
    { invalidJson: true },
    Error('PRIVATE'),
    { body: {} },
  ]) {
    const s = sdk(response);
    const result = await registerResolvers(s).setup({ context });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.error, /PRIVATE/);
    assert.equal(s.calls.length, response instanceof Error ? 3 : 1);
  }
});
test('work item edits distinguish documented rejections from uncertain failures without retry', async () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429]) {
    const s = sdk({ status, body: { errorMessages: ['PRIVATE'] } });
    await assert.rejects(createPorts(s).update('10', { description: null }), (error) => {
      assert.ok(error instanceof JiraRejected);
      assert.equal(error.status, status);
      assert.match(
        error.message,
        status === 429 ? /limiting requests/ : new RegExp(`HTTP ${status}`),
      );
      assert.doesNotMatch(error.message, /PRIVATE|Reload prompts/);
      return true;
    });
    assert.equal(s.calls.length, 1);
  }
  for (const response of [
    { status: 500 },
    { status: 503 },
    Error('PRIVATE'),
    { status: 200, invalidJson: true },
  ]) {
    const s = sdk(response);
    await assert.rejects(createPorts(s).update('10', { description: null }), (error) => {
      assert.ok(!(error instanceof JiraRejected));
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    });
    assert.equal(s.calls.length, 1);
  }
});
test('provisioning writes classify rejections per endpoint and keep other failures uncertain', async () => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  const cases = [
    ['create', 409, true],
    ['create', 429, true],
    ['create', 404, false],
    ['create', 500, false],
    ['attach', 404, true],
    ['attach', 400, true],
    ['attach', 409, false],
    ['attach', 502, false],
  ];
  for (const [operation, status, rejected] of cases) {
    const s = sdk({ status, body: { errorMessages: ['PRIVATE'] } });
    const ports = createSettingsPorts(s);
    await assert.rejects(
      operation === 'create' ? ports.create('Runbook') : ports.attach('9', '5'),
      (error) => {
        assert.equal(error instanceof JiraRejected, rejected, `${operation} ${status}`);
        assert.doesNotMatch(error.message, /PRIVATE/);
        return true;
      },
    );
    assert.equal(s.calls.length, 1);
  }
  // A successful create without a readable ID is not a rejection: the type may exist.
  const unreadable = sdk({ status: 201, body: {} });
  await assert.rejects(createSettingsPorts(unreadable).create('Runbook'), (error) => {
    assert.ok(!(error instanceof JiraRejected));
    return true;
  });
});

test('Rovo trusts the hosted principal, ignores payload identity and returns bounded metadata', async () => {
  const { registerRovo } = await import('../src/integration.ts');
  const denied = sdk();
  // Without a principal nothing runs, whatever identity the payload claims.
  assert.equal(
    (await registerRovo(denied)({ projectKey: 'TEST', query: '', accountId: 'injected' }, {})).ok,
    false,
  );
  assert.equal(denied.calls.length, 0);
  // With a principal, identity fields in the payload change nothing: every call is still asUser.
  const injected = sdk({ body: project }, { body: { issues: [], isLast: true } });
  injected.kvs.entity = () => ({ get: async () => ({ revision: 1, data: { type: '3' } }) });
  const ignored = await registerRovo(injected)(
    { projectKey: 'TEST', query: 'x', accountId: 'injected', context: { accountId: 'injected' } },
    { principal: { accountId: 'actor' } },
  );
  assert.equal(ignored.ok, true);
  assert.ok(injected.calls.length > 0 && injected.calls.every((c) => c.actor === 'asUser'));
  // A read needs a key-shaped promptKey; a numeric issue ID never reaches Jira.
  const numericKey = sdk({ body: project });
  const refused = await registerRovo(numericKey)(
    { projectKey: 'TEST', query: '', promptKey: '20' },
    { principal: { accountId: 'actor' } },
  );
  assert.equal(refused.ok, false);
  assert.match(refused.error, /exact prompt key/);
  assert.equal(numericKey.calls.length, 0);
  // The whole request is validated before the space lookup.
  for (const payload of [
    { projectKey: 'TEST', promptKey: 'TEST-1;DROP' },
    { projectKey: 'TEST', query: 7 },
    { projectKey: 'TEST', query: 'x'.repeat(201) },
  ]) {
    const early = sdk({ body: project });
    const result = await registerRovo(early)(payload, { principal: { accountId: 'actor' } });
    assert.equal(result.ok, false);
    assert.match(result.error, /exact prompt key|search query/);
    assert.equal(early.calls.length, 0);
  }
  // Jira keys are case-insensitive: a key typed in lower case reads the same prompt.
  const lower = sdk(
    { body: project },
    {
      expect: { path: /^\/rest\/api\/3\/issue\/TEST-2\?/ },
      body: {
        id: '2',
        key: 'TEST-2',
        fields: {
          project: { id: '1' },
          issuetype: { id: '3' },
          summary: 'Check errors',
          updated: '1',
          description: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Check errors.' }] }],
          },
        },
      },
    },
  );
  lower.kvs.entity = () => ({ get: async () => ({ revision: 1, data: { type: '3' } }) });
  const read = await registerRovo(lower)(
    { projectKey: 'TEST', query: '', promptKey: ' test-2 ' },
    { principal: { accountId: 'actor' } },
  );
  assert.equal(read.ok, true, read.error);
  assert.equal(read.value.key, 'TEST-2');
  const s = sdk(
    { body: project },
    {
      body: {
        issues: [
          {
            id: '2',
            key: 'TEST-2',
            fields: { summary: 'Check errors', project: { id: '1' }, issuetype: { id: '3' } },
          },
        ],
        isLast: true,
      },
    },
  );
  s.kvs.entity = () => ({ get: async () => ({ revision: 1, data: { type: '3' } }) });
  const result = await registerRovo(s)(
    { projectKey: 'TEST', query: 'errors' },
    { principal: { accountId: 'actor' } },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.prompts, [{ id: '2', key: 'TEST-2', name: 'Check errors' }]);
  assert.ok(s.calls.every((c) => c.actor === 'asUser'));
});

test('storage claims are per-work-item, conditional and non-expiring', async () => {
  const writes = [];
  class Filter {
    and(...args) {
      this.condition = args;
      return this;
    }
  }
  const s = {
    ...sdk(),
    Filter,
    FilterConditions: { notExists: () => 'missing', equalTo: (value) => ['equal', value] },
    kvs: {
      transact: () => ({
        set: (...args) => {
          writes.push(args);
          return { execute: async () => {} };
        },
      }),
    },
  };
  const ports = createPorts(s);
  await ports.cas('10', 0, { ids: [], managed: null });
  await ports.cas('11', 3, { ids: ['20'], managed: null });
  assert.equal(writes[0][0], 'issue-10');
  assert.equal(writes[1][0], 'issue-11');
  assert.deepEqual(writes[0][2].conditions.condition, ['revision', 'missing']);
  assert.deepEqual(writes[1][2].conditions.condition, ['revision', ['equal', 3]]);
  assert.equal(writes[1][1].revision, 4);
  assert.equal(writes[0].length, 3);
});

test('settings adapter creates only a standard type and attaches only the requested ID asUser', async () => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  const s = sdk({ body: { id: '5' } }, { status: 204 });
  const p = createSettingsPorts(s);
  assert.equal(await p.create('Runbook'), '5');
  await p.attach('9', '5');
  assert.deepEqual(
    s.calls.map((c) => [c.actor, c.method, c.path]),
    [
      ['asUser', 'POST', '/rest/api/3/issuetype'],
      ['asUser', 'PUT', '/rest/api/3/issuetypescheme/9/issuetype'],
    ],
  );
  assert.deepEqual(JSON.parse(s.calls[0].body), {
    name: 'Runbook',
    hierarchyLevel: 0,
    description: 'Reusable instructions managed through Agent Prompts for Jira.',
  });
  assert.deepEqual(JSON.parse(s.calls[1].body), { issueTypeIds: ['5'] });
});
test('type adapter retains hierarchy and rejects malformed supplied levels', async () => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  const types = [
    { id: '3', name: 'Base', subtask: false, hierarchyLevel: 0 },
    { id: '4', name: 'Epic', subtask: false, hierarchyLevel: 1 },
    { id: '5', name: 'Initiative', subtask: false, hierarchyLevel: 2 },
    { id: '6', name: 'Subtask', subtask: true, hierarchyLevel: -1 },
    {
      id: '7',
      name: 'Project type',
      subtask: false,
      hierarchyLevel: 0,
      scope: { type: 'PROJECT', project: { id: '1' } },
    },
  ];
  assert.deepEqual(await createSettingsPorts(sdk({ body: types })).types(), types);
  for (const hierarchyLevel of [null, '0', 0.5, NaN, Infinity]) {
    const s = sdk({ body: [{ id: '3', name: 'Unknown', subtask: false, hierarchyLevel }] });
    await assert.rejects(createSettingsPorts(s).types(), /Incomplete/);
    assert.equal(s.calls.length, 1);
  }
});
test('the work type cap counts global types only, not team-managed ones', async () => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  const scoped = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: String(100 + i),
      name: `Task ${i}`,
      subtask: false,
      hierarchyLevel: 0,
      scope: { type: 'PROJECT', project: { id: String(1000 + i) } },
    }));
  const global = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: String(10_000 + i),
      name: `Global ${i}`,
      subtask: false,
      hierarchyLevel: 0,
    }));
  const many = await createSettingsPorts(sdk({ body: [...global(1), ...scoped(5000)] })).types();
  assert.equal(many.length, 5001);
  await assert.rejects(
    createSettingsPorts(sdk({ body: [...global(2001), ...scoped(1)] })).types(),
    /oversized/,
  );
});
test('optional missing hierarchy stays unknown without rejecting valid types in the same list', async () => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  const types = [
    { id: '3', name: 'Base', subtask: false, hierarchyLevel: 0 },
    { id: '4', name: 'Unknown hierarchy', subtask: false },
    {
      id: '5',
      name: 'Scoped unknown hierarchy',
      subtask: false,
      scope: { type: 'PROJECT', project: { id: '1' } },
    },
  ];
  const s = sdk({ body: types });
  assert.deepEqual(await createSettingsPorts(s).types(), types);
  assert.equal(s.calls.length, 1);
});
test('scheme adapter verifies complete expanded space ownership, not filtered projectIds', async () => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  const s = sdk(
    { body: { isLast: true, values: [{ issueTypeScheme: { id: '9' }, projectIds: ['1'] }] } },
    {
      body: {
        isLast: true,
        values: [
          {
            id: '9',
            name: 'Shared',
            projects: { isLast: true, values: [{ id: '1' }, { id: '2' }] },
          },
        ],
      },
    },
  );
  assert.deepEqual((await createSettingsPorts(s).scheme('1')).projectIds, ['1', '2']);
  assert.equal(s.calls[1].path, '/rest/api/3/issuetypescheme?id=9&expand=projects');
});
test('settings handler checks administration on the selected space before configuration writes', async () => {
  const s = sdk({ status: 403 });
  assert.equal(
    (await registerResolvers(s)['settings-health']({ context, payload: { projectId: '2' } })).ok,
    false,
  );
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].path, '/rest/api/3/mypermissions?projectId=2&permissions=ADMINISTER');
  const denied = sdk({ body: { permissions: { ADMINISTER: { havePermission: false } } } });
  assert.equal(
    (await registerResolvers(denied)['settings-health']({ context, payload: {} })).ok,
    false,
  );
  assert.equal(denied.calls.length, 1);
});

test('field discovery is invocation-scoped, including recovery from a failed lookup', async () => {
  const fields = (id) => ({ body: [{ id, schema: { custom: 'exact-field' } }] });
  const s = sdk({ status: 403 }, fields('customfield_1'), fields('customfield_2'));
  await assert.rejects(createPorts(s).field());
  assert.equal(await createPorts(s).field(), 'customfield_1');
  assert.equal(await createPorts(s).field(), 'customfield_2');
  assert.equal(s.calls.filter((call) => call.path === '/rest/api/3/field').length, 3);
  assert.equal(s.remaining(), 0);
});

test('health space inventory is admin-only and independent of type diagnostics or storage', async () => {
  const denied = sdk({ body: { permissions: { ADMINISTER: { havePermission: false } } } });
  assert.equal(
    (await registerResolvers(denied)['settings-projects']({ context, payload: {} })).ok,
    false,
  );
  assert.equal(denied.calls.length, 1);
  const s = sdk(
    { body: { permissions: { ADMINISTER: { havePermission: true } } } },
    {
      body: {
        startAt: 0,
        isLast: true,
        values: [{ id: '1', key: 'ONE', name: 'One', style: 'classic' }],
      },
    },
  );
  const result = await registerResolvers(s)['settings-projects']({ context, payload: {} });
  assert.equal(result.ok, true);
  assert.equal(result.value.projects[0].id, '1');
  assert.equal(s.calls.length, 2);
  const injected = sdk();
  assert.equal(
    (
      await registerResolvers(injected)['settings-projects']({
        context,
        payload: { accountId: 'admin' },
      })
    ).ok,
    false,
  );
  assert.equal(injected.calls.length, 0);
});

test('preference and resolution resolvers reject extra authority fields, bad revisions and non-administrators', async () => {
  for (const action of ['settings-preferences', 'settings-resolve']) {
    const payload =
      action === 'settings-preferences'
        ? { revision: 0, refreshAfterSave: true }
        : { revision: 0, acknowledged: true };
    for (const forged of [
      { ...payload, accountId: 'admin' },
      { ...payload, revision: true },
      { ...payload, revision: '1' },
      { ...payload, revision: -1 },
    ]) {
      const s = sdk();
      assert.equal((await registerResolvers(s)[action]({ context, payload: forged })).ok, false);
      assert.equal(s.calls.length, 0);
    }
    const denied = sdk({ body: { permissions: { ADMINISTER: { havePermission: false } } } });
    assert.equal((await registerResolvers(denied)[action]({ context, payload })).ok, false);
    assert.equal(denied.calls.length, 1);
  }
  // Type changes and setup removal run only through the reviewed multi-space configuration.
  const definitions = registerResolvers(sdk());
  for (const removed of ['settings-preview', 'settings-apply', 'settings-unlink'])
    assert.equal(definitions[removed], undefined);
});
test('settings requests name their space by numeric ID only, refused before any Jira read', async () => {
  for (const projectId of ['TEST', '0', '1.5', 7, ' 1']) {
    const s = sdk();
    const result = await registerResolvers(s)['settings-health']({
      context: { accountId: 'actor', extension: {} },
      payload: { projectId },
    });
    assert.deepEqual(result, { ok: false, error: 'Choose a Jira space.' });
    assert.equal(s.calls.length, 0);
  }
});
test('a partly listed shared scheme is marked incomplete; inconsistent lists are refused', async () => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  const read = (projects) =>
    sdk(
      { body: { isLast: true, values: [{ issueTypeScheme: { id: '9' } }] } },
      { body: { isLast: true, values: [{ id: '9', name: 'Shared', projects }] } },
    );
  for (const projects of [
    { isLast: false, values: [{ id: '2' }] },
    { isLast: true, total: 2, values: [{ id: '2' }] },
  ]) {
    const s = read(projects);
    assert.deepEqual(await createSettingsPorts(s).scheme('1'), {
      id: '9',
      name: 'Shared',
      isDefault: false,
      projectIds: [],
      projects: [],
      complete: false,
    });
    assert.ok(s.calls.every((c) => c.method === 'GET'));
  }
  for (const projects of [
    { isLast: true, values: [{ id: '1' }, { id: '1' }] },
    { isLast: true, values: [{ id: '2' }] },
  ])
    await assert.rejects(createSettingsPorts(read(projects)).scheme('1'), /inconsistent/);
});

test('discovery requests one newest-first page, scoped metadata, exact keys and bounded cursors', async () => {
  const issue = {
    id: '200',
    key: 'TEST-200',
    fields: { summary: 'Older prompt', project: { id: '1' }, issuetype: { id: '3' } },
  };
  const s = sdk(
    { body: { issues: [issue], isLast: false, nextPageToken: 'page-2' } },
    { body: { issues: [], isLast: true } },
    { body: { issues: [issue], isLast: true } },
  );
  const first = await createPorts(s).search('1', '3', { query: 'Review code', limit: 10 });
  assert.equal(first.nextCursor, 'page-2');
  assert.deepEqual(JSON.parse(s.calls[0].body), {
    jql: 'project = 1 AND issuetype = 3 AND (summary ~ "review*" OR summary ~ "review") AND (summary ~ "code*" OR summary ~ "code") AND statusCategory != Done ORDER BY created DESC, key DESC',
    fields: ['summary', 'project', 'issuetype'],
    maxResults: 10,
  });
  await createPorts(s).search('1', '3', {
    query: 'Review code',
    limit: 10,
    cursor: first.nextCursor,
  });
  assert.equal(JSON.parse(s.calls[1].body).nextPageToken, 'page-2');
  // An exact key is one lookup, and it never finds a retired prompt either.
  const exact = await createPorts(s).search('1', '3', { query: 'test-200', limit: 10 });
  assert.deepEqual(
    exact.prompts.map((p) => p.key),
    ['TEST-200'],
  );
  assert.equal(s.calls.length, 3);
  assert.equal(
    JSON.parse(s.calls[2].body).jql,
    'project = 1 AND issuetype = 3 AND key = "TEST-200" AND statusCategory != Done ORDER BY created DESC, key DESC',
  );
  assert.ok(s.calls.every((c) => c.actor === 'asUser'));
});
test('a query shaped like a key that no prompt has is searched as words', async () => {
  const found = (query) => ({
    body: {
      issues: [
        {
          id: '200',
          key: 'TEST-200',
          fields: {
            summary: `${query} review rules`,
            project: { id: '1' },
            issuetype: { id: '3' },
          },
        },
      ],
      isLast: false,
      nextPageToken: 'page-2',
    },
  });
  for (const query of ['GPT-4', 'sha-256', 'UTF-8', 'PEP-8']) {
    const [word, number] = query.toLowerCase().split('-');
    const words = `(summary ~ "${word}*" OR summary ~ "${word}") AND (summary ~ "${number}*" OR summary ~ "${number}")`;
    // Jira refuses a key that does not exist with 400; a key in another space finds nothing.
    for (const miss of [
      { status: 400, body: { errorMessages: [`An issue with key '${query}' does not exist.`] } },
      { body: { issues: [], isLast: true } },
    ]) {
      const s = sdk(miss, found(query), { body: { issues: [], isLast: true } });
      const page = await createPorts(s).search('1', '3', { query, limit: 10 });
      assert.deepEqual(
        page.prompts.map((p) => p.id),
        ['200'],
      );
      assert.deepEqual(
        s.calls.map((c) => JSON.parse(c.body).jql),
        [
          `project = 1 AND issuetype = 3 AND key = "${query.toUpperCase()}" AND statusCategory != Done ORDER BY created DESC, key DESC`,
          `project = 1 AND issuetype = 3 AND ${words} AND statusCategory != Done ORDER BY created DESC, key DESC`,
        ],
      );
      // Load more continues the word search, never the key lookup.
      await createPorts(s).search('1', '3', { query, limit: 10, cursor: page.nextCursor });
      assert.deepEqual(JSON.parse(s.calls[2].body), {
        jql: `project = 1 AND issuetype = 3 AND ${words} AND statusCategory != Done ORDER BY created DESC, key DESC`,
        fields: ['summary', 'project', 'issuetype'],
        maxResults: 10,
        nextPageToken: 'page-2',
      });
    }
  }
});
test('combining marks stay inside the word they belong to', async () => {
  const s = sdk({ body: { issues: [], isLast: true } }, { body: { issues: [], isLast: true } });
  await createPorts(s).search('1', '3', { query: 'हिन्दी', limit: 10 });
  assert.equal(
    JSON.parse(s.calls[0].body).jql,
    'project = 1 AND issuetype = 3 AND (summary ~ "हिन्दी*" OR summary ~ "हिन्दी") AND statusCategory != Done ORDER BY created DESC, key DESC',
  );
  // "café" with a decomposed accent: e followed by U+0301.
  const decomposed = 'café menu';
  await createPorts(s).search('1', '3', { query: decomposed, limit: 10 });
  assert.equal(
    JSON.parse(s.calls[1].body).jql,
    `project = 1 AND issuetype = 3 AND (summary ~ "café*" OR summary ~ "café") AND (summary ~ "menu*" OR summary ~ "menu") AND statusCategory != Done ORDER BY created DESC, key DESC`,
  );
});
test('search drops operator and stop words and treats Jira 400 as no match', async () => {
  // Observed on Jira Cloud: inside a multi-word query a stop-word clause matches nothing.
  const s = sdk({ body: { issues: [], isLast: true } }, { body: { issues: [], isLast: true } });
  await createPorts(s).search('1', '3', { query: 'NOT the coding', limit: 10 });
  assert.equal(
    JSON.parse(s.calls[0].body).jql,
    'project = 1 AND issuetype = 3 AND (summary ~ "coding*" OR summary ~ "coding") AND statusCategory != Done ORDER BY created DESC, key DESC',
  );
  // Only stop words: no text clause, as Jira's own search treats them.
  await createPorts(s).search('1', '3', { query: 'the and', limit: 10 });
  assert.equal(
    JSON.parse(s.calls[1].body).jql,
    'project = 1 AND issuetype = 3 AND statusCategory != Done ORDER BY created DESC, key DESC',
  );
  // Jira answers 400 for an exact key that is missing or hidden, and for text it cannot parse.
  // A missing key is then searched as words, which here Jira cannot parse either.
  for (const [query, requests] of [
    ['TEST-9999', 2],
    ['prompt', 1],
  ]) {
    const refused = {
      status: 400,
      body: { errorMessages: ['Issue does not exist or you do not have permission to see it.'] },
    };
    const missing = sdk(...Array(requests).fill(refused));
    assert.deepEqual(await createPorts(missing).search('1', '3', { query, limit: 10 }), {
      prompts: [],
      incomplete: false,
    });
    assert.equal(missing.calls.length, requests);
  }
  // Without a query, a 400 is still an error (the configured scope itself was refused).
  const scope = sdk({ status: 400 });
  await assert.rejects(createPorts(scope).search('1', '3', { query: '', limit: 10 }), /HTTP 400/);
  // A refused follow-up page (an expired cursor) is a failed page, not the end of the results.
  const expired = sdk({ status: 400 });
  await assert.rejects(
    createPorts(expired).search('1', '3', { query: 'prompt', cursor: 'old', limit: 10 }),
    /HTTP 400/,
  );
});
test('discovery rejects malformed pages, duplicate IDs, foreign scope and repeated cursors', async () => {
  const issue = {
    id: '200',
    key: 'TEST-200',
    fields: { summary: 'Prompt', project: { id: '1' }, issuetype: { id: '3' } },
  };
  for (const body of [
    { issues: [issue], isLast: false, nextPageToken: 'same' },
    { issues: [issue, issue], isLast: true },
    { issues: [{ ...issue, fields: { ...issue.fields, project: { id: '2' } } }], isLast: true },
    { issues: [{ ...issue, fields: { summary: 'Missing scope' } }], isLast: true },
    { issues: [], isLast: false },
    { issues: Array(6).fill(issue), isLast: true },
  ])
    await assert.rejects(
      createPorts(sdk({ body })).search('1', '3', { limit: 10, cursor: 'same' }),
    );
});
test('search text cannot inject JQL and invalid handler payloads never access Jira', async () => {
  const s = sdk({ body: { issues: [], isLast: true } });
  await createPorts(s).search('1', '3', { query: '" OR project = 2 ORDER BY key', limit: 10 });
  const jql = JSON.parse(s.calls[0].body).jql;
  assert.equal(
    jql,
    'project = 1 AND issuetype = 3 AND (summary ~ "project*" OR summary ~ "project") AND (summary ~ "2*" OR summary ~ "2") AND (summary ~ "order*" OR summary ~ "order") AND (summary ~ "key*" OR summary ~ "key") AND statusCategory != Done ORDER BY created DESC, key DESC',
  );
  // Boundaries: 200 characters and an 8,192-character cursor are accepted.
  const accepted = sdk(
    { body: { issues: [], isLast: true } },
    { body: { issues: [], isLast: true } },
  );
  const kvs = { entity: () => ({ get: async () => ({ revision: 1, data: { type: '3' } }) }) };
  const search = registerResolvers({ ...accepted, kvs }).search;
  for (const payload of [{ query: 'x'.repeat(200) }, { cursor: 'c'.repeat(8192) }])
    assert.equal((await search({ context, payload })).ok, true);
  accepted.assertDrained();
  for (const payload of [
    { query: 2 },
    { query: 'x'.repeat(201) },
    { cursor: '' },
    { cursor: 'x'.repeat(8193) },
    { surface: 'picker' },
    { projectId: '2' },
  ]) {
    const bad = sdk();
    const result = await registerResolvers(bad).search({ context, payload });
    assert.equal(result.ok, false);
    assert.equal(bad.calls.length, 0);
  }
});

test('discovery follows cursors through every page without increasing any request size', async () => {
  const pages = Array.from({ length: 7 }, (_, page) => ({
    body: {
      issues: Array.from({ length: 20 }, (_, i) => ({
        id: String(1 + page * 20 + i),
        key: `TEST-${1 + page * 20 + i}`,
        fields: { summary: 'Prompt', project: { id: '1' }, issuetype: { id: '3' } },
      })),
      isLast: page === 6,
      ...(page < 6 ? { nextPageToken: `cursor-${page + 1}` } : {}),
    },
  }));
  const s = sdk(...pages);
  const p = createPorts(s);
  let cursor;
  const ids = [];
  do {
    const page = await p.search('1', '3', {
      query: 'Prompt',
      limit: 20,
      ...(cursor ? { cursor } : {}),
    });
    ids.push(...page.prompts.map((p) => p.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 140);
  assert.equal(new Set(ids).size, 140);
  assert.ok(s.calls.every((c) => JSON.parse(c.body).maxResults === 20));
});

test('storage refuses records over 190,000 bytes before any write', async () => {
  const { createBatchPorts } = await import('../src/integration.ts');
  const writes = [];
  const s = {
    ...sdk(),
    Filter: class {
      and() {
        return this;
      }
    },
    FilterConditions: { notExists: () => 'missing', equalTo: (v) => v },
    kvs: {
      transact: () => ({
        set: (...args) => {
          writes.push(args[0]);
          return { execute: async () => {} };
        },
      }),
    },
  };
  // Serialized `{"ids":[],"managed":null,"pad":"…"}` around the padding.
  const overhead = JSON.stringify({ ids: [], managed: null, pad: '' }).length;
  await createPorts(s).cas('10', 0, {
    ids: [],
    managed: null,
    pad: 'x'.repeat(190_000 - overhead),
  });
  await assert.rejects(
    createPorts(s).cas('10', 1, { ids: [], managed: null, pad: 'x'.repeat(190_001 - overhead) }),
    /too large/,
  );
  await assert.rejects(createBatchPorts(s).cas(0, { pad: 'x'.repeat(190_001) }), /too many spaces/);
  assert.deepEqual(writes, ['issue-10']);
});

test('shared scheme membership lists 1,000 associated spaces and marks 1,001 incomplete', async () => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  for (const [count, ok] of [
    [1000, true],
    [1001, false],
  ]) {
    const values = Array.from({ length: count }, (_, i) => ({ id: String(i + 1) }));
    const s = sdk(
      { body: { isLast: true, values: [{ issueTypeScheme: { id: '9' }, projectIds: ['1'] }] } },
      {
        body: {
          isLast: true,
          values: [{ id: '9', name: 'Shared', projects: { isLast: true, values } }],
        },
      },
    );
    const result = createSettingsPorts(s).scheme('1');
    if (ok) assert.equal((await result).projectIds.length, 1000);
    else assert.equal((await result).complete, false);
  }
});

test('the space inventory treats a documented 404 as empty and stops paging after its time budget', async (t) => {
  const { createBatchPorts } = await import('../src/integration.ts');
  const empty = sdk({ status: 404 });
  assert.deepEqual(await createBatchPorts(empty).projects(), { projects: [], incomplete: false });
  // A 404 on a later page is not "no projects": it stays an error.
  const later = sdk(
    {
      body: {
        startAt: 0,
        isLast: false,
        values: [{ id: '1', key: 'ONE', name: 'One', style: 'classic' }],
      },
    },
    { status: 404 },
  );
  await assert.rejects(createBatchPorts(later).projects(), /HTTP 404/);
  // Slow pages: report a partial inventory instead of timing out.
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const page = (start) => ({
    body: {
      startAt: start,
      isLast: false,
      values: Array.from({ length: 100 }, (_, i) => ({
        id: String(start + i + 1),
        key: `T${start + i}`,
        name: 'Team',
        style: 'next-gen',
      })),
    },
  });
  const slow = sdk(page(0), page(100), page(200));
  const ports = createBatchPorts(slow);
  const original = slow.api.asUser;
  slow.api.asUser = () => {
    const user = original();
    return {
      requestJira: async (...args) => {
        now += 8_000;
        return user.requestJira(...args);
      },
    };
  };
  // The first page took 8 s, so the second (ending past the 15 s budget) is the last one read.
  const partial = await ports.projects();
  assert.equal(partial.incomplete, true);
  assert.equal(partial.projects.length, 200);
  assert.ok(partial.projects.every((p) => p.teamManaged));
  assert.equal(slow.calls.length, 2);
});

test('the Rovo space lookup returns clear errors and accepts only Software spaces', async () => {
  const { registerRovo } = await import('../src/integration.ts');
  const principal = { principal: { accountId: 'actor' } };
  const payload = { projectKey: 'TEST', query: '' };
  for (const [response, pattern] of [
    [{ status: 404 }, /^Space is unavailable\.$/],
    [{ status: 429 }, /limiting requests/],
    [{ status: 200, invalidJson: true }, /unreadable data/],
    [
      { body: { id: '1', key: 'TEST', projectTypeKey: 'business', style: 'next-gen' } },
      /^Jira software spaces only\.$/,
    ],
    [{ body: null }, /Space context does not match/],
  ]) {
    const s = sdk(response);
    const result = await registerRovo(s)(payload, principal);
    assert.equal(result.ok, false);
    assert.match(result.error, pattern);
    assert.equal(s.calls.length, 1);
  }
});

test('Rovo search returns at most twenty matches and reports more', async () => {
  const { registerRovo } = await import('../src/integration.ts');
  const issues = Array.from({ length: 20 }, (_, i) => ({
    id: String(100 + i),
    key: `TEST-${100 + i}`,
    fields: { summary: `Prompt ${i}`, project: { id: '1' }, issuetype: { id: '3' } },
  }));
  const s = {
    ...sdk(
      { body: { ...project, id: '1' } },
      { body: { issues, isLast: false, nextPageToken: 'next' } },
    ),
    kvs: { entity: () => ({ get: async () => ({ revision: 1, data: { type: '3' } }) }) },
  };
  const result = await registerRovo(s)(
    { projectKey: 'TEST', query: '' },
    { principal: { accountId: 'a' } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.prompts.length, 20);
  assert.equal(result.value.incomplete, true);
  assert.equal(JSON.parse(s.calls[1].body).maxResults, 20);
});

test('Rovo searches a team-managed space by its own configured work type', async () => {
  const { registerRovo } = await import('../src/integration.ts');
  const s = {
    ...sdk(
      { body: { ...project, id: '1', style: 'next-gen' } },
      {
        body: {
          issues: [
            {
              id: '100',
              key: 'TEST-100',
              fields: { summary: 'Review', project: { id: '1' }, issuetype: { id: '10430' } },
            },
          ],
          isLast: true,
        },
      },
    ),
    kvs: { entity: () => ({ get: async () => ({ revision: 1, data: { type: '10430' } }) }) },
  };
  const result = await registerRovo(s)(
    { projectKey: 'TEST', query: '' },
    { principal: { accountId: 'a' } },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.prompts.map((p) => p.key),
    ['TEST-100'],
  );
  assert.match(
    JSON.parse(s.calls[1].body).jql,
    /^project = 1 AND issuetype = 10430 AND statusCategory != Done ORDER BY/,
  );
  assert.equal(s.calls.length, 2);
});

test('Rovo still reads a retired prompt by its exact key', async () => {
  const { registerRovo } = await import('../src/integration.ts');
  const s = sdk(
    { body: project },
    {
      expect: { path: /^\/rest\/api\/3\/issue\/TEST-2\?fields=.*%2Cstatus%2Csecurity$/ },
      body: {
        id: '2',
        key: 'TEST-2',
        fields: {
          project: { id: '1' },
          issuetype: { id: '3' },
          summary: 'Old checklist',
          updated: '1',
          status: { id: '10001', statusCategory: { key: 'done' } },
          description: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Check errors.' }] }],
          },
        },
      },
    },
  );
  s.kvs.entity = () => ({ get: async () => ({ revision: 1, data: { type: '3' } }) });
  const read = await registerRovo(s)(
    { projectKey: 'TEST', query: '', promptKey: 'TEST-2' },
    { principal: { accountId: 'actor' } },
  );
  assert.equal(read.ok, true, read.error);
  assert.equal(read.value.name, 'Old checklist');
  assert.match(read.value.content, /Check errors\./);
  s.assertDrained();
});

test('one request reads a space settings record once, and a storage failure is an outage', async () => {
  const { StorageUnavailable } = await import('../src/service.ts');
  const reads = [];
  const s = sdk();
  s.kvs = {
    entity: () => ({
      get: async (key) => {
        reads.push(key);
        return { revision: 2, data: { type: '3', previousTypes: ['4'], refreshAfterSave: true } };
      },
    }),
  };
  const ports = createPorts(s);
  assert.deepEqual(
    await Promise.all([ports.config('1'), ports.retainedTypes('1'), ports.refreshAfterSave('1')]),
    ['3', ['4'], true],
  );
  assert.deepEqual(reads, ['config-1']);
  await ports.config('2');
  assert.deepEqual(reads, ['config-1', 'config-2']);

  const failing = sdk();
  failing.kvs = {
    entity: () => ({
      get: async () => {
        throw new Error('private storage detail');
      },
    }),
  };
  const broken = createPorts(failing);
  for (const lookup of [broken.config, broken.retainedTypes, broken.refreshAfterSave])
    await assert.rejects(lookup('1'), (error) => {
      assert.ok(error instanceof StorageUnavailable);
      assert.equal(error.message, 'App storage is unavailable. Try again shortly.');
      return true;
    });
});
test('create fields are read past 200 a page and reported incomplete past 1,000', async () => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  const page = (start, total, ids) => ({
    expect: {
      method: 'GET',
      path: `/rest/api/3/issue/createmeta/1/issuetypes/20?startAt=${start}&maxResults=200`,
    },
    body: { startAt: start, maxResults: 200, total, fields: ids.map((fieldId) => ({ fieldId })) },
  });
  const custom = (from, n) => Array.from({ length: n }, (_, i) => `customfield_${from + i}`);
  let s = sdk(
    page(0, 202, ['summary', ...custom(0, 199)]),
    page(200, 202, ['description', 'customfield_999']),
  );
  const fields = await createSettingsPorts(s).createFields('1', '20');
  assert.equal(fields.length, 202);
  assert.ok(fields.includes('summary') && fields.includes('description'));
  s.assertDrained();

  s = sdk(...Array.from({ length: 5 }, (_, n) => page(n * 200, 1001, custom(n * 200, 200))));
  await assert.rejects(
    createSettingsPorts(s).createFields('1', '20'),
    /Create fields are incomplete/,
  );
  s.assertDrained();

  // A page shorter than Jira promised is not a complete list.
  s = sdk(page(0, 300, ['summary']), page(1, 300, []));
  await assert.rejects(
    createSettingsPorts(s).createFields('1', '20'),
    /Create fields are incomplete/,
  );
  s.assertDrained();
});
test('screen field writes classify documented rejections and keep other failures uncertain', async () => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  for (const [operation, status, rejected] of [
    ['add', 400, true],
    ['add', 404, true],
    ['add', 429, true],
    ['add', 500, false],
    ['remove', 403, true],
    ['remove', 409, false],
    ['remove', 503, false],
  ]) {
    const s = sdk({ status, body: { errorMessages: ['PRIVATE'] } });
    const ports = createSettingsPorts(s);
    await assert.rejects(
      operation === 'add'
        ? ports.addScreenField('51', '61', 'customfield_1')
        : ports.removeScreenField('51', '61', 'customfield_1'),
      (error) => {
        assert.equal(error instanceof JiraRejected, rejected, `${operation} ${status}`);
        assert.doesNotMatch(error.message, /PRIVATE/);
        return true;
      },
    );
    assert.deepEqual(
      s.calls.map((c) => [c.actor, c.method, c.path]),
      [
        operation === 'add'
          ? ['asUser', 'POST', '/rest/api/3/screens/51/tabs/61/fields']
          : ['asUser', 'DELETE', '/rest/api/3/screens/51/tabs/61/fields/customfield_1'],
      ],
    );
    if (operation === 'add')
      assert.deepEqual(JSON.parse(s.calls[0].body), { fieldId: 'customfield_1' });
  }
});
test('screen adapter resolves a work type’s screens through the space’s complete screen scheme', async () => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  const assigned = {
    isLast: true,
    values: [{ issueTypeScreenScheme: { id: '30' }, projectIds: ['1'] }],
  };
  const row = (issueTypeId, screenSchemeId) => ({
    issueTypeId,
    screenSchemeId,
    issueTypeScreenSchemeId: '30',
  });
  const mapping = {
    body: { startAt: 0, isLast: true, values: [row('default', '40'), row('10', '41')] },
  };
  // Every chosen screen scheme is read in one request.
  const s = sdk({ body: assigned }, mapping, {
    body: {
      isLast: true,
      values: [
        { id: 41, screens: { default: 50, edit: 51 } },
        { id: 40, screens: { default: 52 } },
      ],
    },
  });
  assert.deepEqual(
    await createSettingsPorts(s).screenUses('1', [
      { type: '10', op: 'edit' },
      { type: '10', op: 'view' },
      { type: '11', op: 'create' },
    ]),
    ['51', '50', '52'],
  );
  assert.deepEqual(
    s.calls.map((c) => c.path),
    [
      '/rest/api/3/issuetypescreenscheme/project?projectId=1',
      '/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=30&startAt=0&maxResults=100',
      '/rest/api/3/screenscheme?id=41&id=40&maxResults=100',
    ],
  );
  // A screen scheme missing from the answer, or one not asked for, is refused.
  for (const values of [
    [{ id: 41, screens: { default: 50 } }],
    [
      { id: 41, screens: { default: 50 } },
      { id: 42, screens: { default: 52 } },
    ],
  ]) {
    const partial = sdk({ body: assigned }, mapping, { body: { isLast: true, values } });
    await assert.rejects(
      createSettingsPorts(partial).screenUses('1', [
        { type: '10', op: 'edit' },
        { type: '11', op: 'edit' },
      ]),
      /screen scheme could not be read/,
    );
  }
  // A duplicated row or another scheme's row is inconsistent, never guessed.
  const duplicate = sdk(
    { body: assigned },
    { body: { startAt: 0, isLast: true, values: [row('10', '41'), row('10', '42')] } },
  );
  await assert.rejects(
    createSettingsPorts(duplicate).screenUses('1', [{ type: '10', op: 'edit' }]),
    /inconsistent/,
  );
  const unassigned = sdk({
    body: { isLast: true, values: [{ issueTypeScreenScheme: { id: '30' }, projectIds: ['2'] }] },
  });
  await assert.rejects(
    createSettingsPorts(unassigned).screenUses('1', [{ op: 'edit' }]),
    /screen scheme/,
  );
});
test('screen reads name screens in bulk, place the field from one read and read tabs only when needed', async () => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  const get = (path, body) => ({ expect: { method: 'GET', path: `/rest/api/3/${path}` }, body });
  const placed = (start, isLast, values) =>
    get(`field/customfield_1/screens?startAt=${start}&maxResults=100&expand=tab`, {
      startAt: start,
      isLast,
      values,
    });
  // 50 was deleted in Jira; 51 has the field; 52 is read in full; 53 lacks the field.
  const s = sdk(
    get('screens?id=50&id=51&id=52&id=53&maxResults=100', {
      isLast: true,
      values: [
        { id: 51, name: 'Task screen' },
        { id: 52, name: 'Create screen' },
        { id: 53, name: 'Bug screen' },
      ],
    }),
    placed(0, false, [{ id: 51, name: 'Task screen', tab: { id: 62, name: 'Field Tab' } }]),
    placed(1, true, [{ id: 52, name: 'Create screen', tab: { id: 63 } }]),
    get('screens/52/tabs', [{ id: 63 }, { id: 64 }]),
    get('screens/53/tabs', [{ id: 65 }]),
    get('screens/52/tabs/63/fields', [{ id: 'summary' }, { id: 'customfield_1' }]),
    get('screens/52/tabs/64/fields', [{ id: 'description' }]),
  );
  assert.deepEqual(
    await createSettingsPorts(s).screens(['50', '51', '52', '53'], 'customfield_1', ['52']),
    [
      undefined,
      { id: '51', name: 'Task screen', tabs: [{ id: '62', fields: ['customfield_1'] }] },
      {
        id: '52',
        name: 'Create screen',
        tabs: [
          { id: '63', fields: ['summary', 'customfield_1'] },
          { id: '64', fields: ['description'] },
        ],
      },
      { id: '53', name: 'Bug screen', tabs: [{ id: '65', fields: [] }] },
    ],
  );
  s.assertDrained();

  // More than 100 screens are named 100 at a time; when every screen is read in full, where the
  // field sits is not read.
  const ids = Array.from({ length: 101 }, (_, i) => String(i + 1));
  const named = (chunk) =>
    get(`screens?${chunk.map((id) => `id=${id}`).join('&')}&maxResults=100`, {
      isLast: true,
      values: chunk.map((id) => ({ id: Number(id), name: `Screen ${id}` })),
    });
  const bulk = sdk(
    named(ids.slice(0, 100)),
    named(ids.slice(100)),
    ...ids.map((id) => get(`screens/${id}/tabs`, [])),
  );
  const all = await createSettingsPorts(bulk).screens(ids, '', ids);
  assert.deepEqual(all.at(-1), { id: '101', name: 'Screen 101', tabs: [] });
  bulk.assertDrained();

  // A placement without its tab, or a malformed field ID, is refused.
  await assert.rejects(
    createSettingsPorts(
      sdk(
        get('screens?id=51&maxResults=100', { isLast: true, values: [{ id: 51, name: 'A' }] }),
        placed(0, true, [{ id: 51 }]),
      ),
    ).screens(['51'], 'customfield_1'),
    /Agent Prompts field could not be read/,
  );
  await assert.rejects(
    createSettingsPorts(
      sdk(get('screens?id=51&maxResults=100', { isLast: true, values: [{ id: 51, name: 'A' }] })),
    ).screens(['51'], 'summary'),
    /Invalid prompt field/,
  );
});
test('screen impact lists every screen scheme with its users, then reads the spaces of matching ones', async () => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  const get = (path, body) => ({ expect: { method: 'GET', path: `/rest/api/3/${path}` }, body });
  const listPage = (start, isLast, values, total) =>
    get(`screenscheme?startAt=${start}&maxResults=100&expand=issueTypeScreenSchemes`, {
      startAt: start,
      isLast,
      values,
      ...(total === undefined ? {} : { total }),
    });
  const users = (...ids) => ({ isLast: true, values: ids.map((id) => ({ id })) });
  const spaces = (itss, ...values) =>
    get(`issuetypescreenscheme/${itss}/project?startAt=0&maxResults=100`, {
      startAt: 0,
      isLast: true,
      values,
    });
  // Jira omits the expansion for a screen scheme no work type screen scheme uses (43).
  const list = listPage(0, true, [
    { id: 40, screens: { default: 51 }, issueTypeScreenSchemes: users('30') },
    { id: 43, screens: { edit: 51, default: 52 } },
    { id: 44, screens: { default: 99 }, issueTypeScreenSchemes: users('31') },
  ]);
  let s = sdk(list, spaces(30, { id: '2', key: 'TWO' }, { id: '1', key: 'ONE' }));
  const ports = createSettingsPorts(s);
  const expected = {
    projects: [
      { id: '1', key: 'ONE' },
      { id: '2', key: 'TWO' },
    ],
    complete: true,
  };
  assert.deepEqual(await ports.screenImpact('51'), expected);
  // The list and each work type screen scheme's spaces are read once per request.
  assert.deepEqual(await ports.screenImpact('51'), expected);
  s.assertDrained();

  // A partial expansion falls back to the full mapping, read once.
  s = sdk(
    listPage(0, true, [
      {
        id: 40,
        screens: { default: 51 },
        issueTypeScreenSchemes: { isLast: false, values: [{ id: '30' }] },
      },
      { id: 43, screens: { edit: 51 } },
    ]),
    get('issuetypescreenscheme/mapping?startAt=0&maxResults=100', {
      startAt: 0,
      isLast: true,
      values: [
        { issueTypeId: 'default', issueTypeScreenSchemeId: '30', screenSchemeId: '40' },
        { issueTypeId: '10', issueTypeScreenSchemeId: '31', screenSchemeId: '40' },
        { issueTypeId: 'default', issueTypeScreenSchemeId: '32', screenSchemeId: '44' },
      ],
    }),
    spaces(30, { id: '1', key: 'ONE' }),
    spaces(31, { id: '3', key: 'THREE' }),
  );
  assert.deepEqual(
    (await createSettingsPorts(s).screenImpact('51')).projects.map((p) => p.key),
    ['ONE', 'THREE'],
  );
  s.assertDrained();

  // With a total, the remaining pages are read together; a scheme added meanwhile is read after.
  const schemes = (from, count, used = {}) =>
    Array.from({ length: count }, (_, i) => ({
      id: from + i,
      screens: { default: 1000 + from + i },
      issueTypeScreenSchemes: users(...(used[from + i] ?? [])),
    }));
  s = sdk(
    listPage(0, false, schemes(1, 100), 250),
    listPage(100, false, schemes(101, 100)),
    listPage(200, false, schemes(201, 50, { 240: ['30'] })),
    listPage(250, true, [
      { id: 251, screens: { default: 1240 }, issueTypeScreenSchemes: users('31') },
    ]),
    spaces(30, { id: '1', key: 'ONE' }),
    spaces(31, { id: '3', key: 'THREE' }),
  );
  assert.deepEqual(await createSettingsPorts(s).screenImpact('1240'), {
    projects: [
      { id: '1', key: 'ONE' },
      { id: '3', key: 'THREE' },
    ],
    complete: true,
  });
  s.assertDrained();
  // Without a total, pages are read one after another.
  s = sdk(
    listPage(0, false, schemes(1, 100)),
    listPage(100, true, schemes(101, 1, { 101: ['30'] })),
    spaces(30, { id: '1', key: 'ONE' }),
  );
  assert.equal((await createSettingsPorts(s).screenImpact('1101')).complete, true);
  s.assertDrained();
  // Jira may return shorter pages than the first: the gap after the short page at 10 is read page
  // by page, so scheme 16, the only one linking screen 51 to space TWO, is found.
  const used = { 1: ['30'], 16: ['31'] };
  const short = (from, count) =>
    schemes(from, count, used).map((x) => (used[x.id] ? { ...x, screens: { default: 51 } } : x));
  s = sdk(
    listPage(0, false, short(1, 10), 25),
    listPage(10, false, short(11, 5), 25),
    listPage(20, true, short(21, 5), 25),
    listPage(15, false, short(16, 5), 25),
    listPage(20, true, short(21, 5), 25),
    spaces(30, { id: '1', key: 'ONE' }),
    spaces(31, { id: '2', key: 'TWO' }),
  );
  assert.deepEqual(await createSettingsPorts(s).screenImpact('51'), {
    projects: [
      { id: '1', key: 'ONE' },
      { id: '2', key: 'TWO' },
    ],
    complete: true,
  });
  s.assertDrained();
  // Fewer schemes than Jira's final count (one added at an earlier offset was skipped) is refused
  // as a passing failure, so a review or a configuration step can simply run again.
  s = sdk(listPage(0, false, short(1, 10)), listPage(10, true, short(11, 15), 26));
  await assert.rejects(
    createSettingsPorts(s).screenImpact('51'),
    (error) => error instanceof JiraUnavailable && /changed while being read/.test(error.message),
  );

  // More than one page of spaces per work type screen scheme is read; past ten it is incomplete.
  const page = (start, isLast) =>
    get(`issuetypescreenscheme/30/project?startAt=${start}&maxResults=100`, {
      startAt: start,
      isLast,
      values: Array.from({ length: 100 }, (_, i) => ({ id: String(start + i + 1) })),
    });
  s = sdk(list, ...Array.from({ length: 10 }, (_, i) => page(i * 100, false)));
  const many = await createSettingsPorts(s).screenImpact('51');
  assert.deepEqual([many.projects.length, many.complete, many.timedOut], [1000, false, undefined]);

  s = sdk(list, { body: { startAt: 0, isLast: false, values: [] } });
  await assert.rejects(createSettingsPorts(s).screenImpact('51'), /could not be read completely/);
});
test('screen impact reads stop after twelve seconds of the request and report the timeout', async (t) => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const s = sdk({
    expect: {
      method: 'GET',
      path: '/rest/api/3/screenscheme?startAt=0&maxResults=100&expand=issueTypeScreenSchemes',
    },
    body: { startAt: 0, isLast: false, total: 300, values: [{ id: 40, screens: { default: 51 } }] },
  });
  const asUser = s.api.asUser;
  s.api.asUser = () => {
    const user = asUser();
    return {
      requestJira: (...args) => {
        now += 12_001;
        return user.requestJira(...args);
      },
    };
  };
  const ports = createSettingsPorts(s);
  assert.equal(ports.timeLeft(), 22_000);
  const result = await ports.screenImpact('51');
  assert.deepEqual(result, { projects: [], complete: false, timedOut: true });
  assert.equal(ports.timeLeft(), 9_999);
  s.assertDrained();
});
test('screen reads stop at the review cutoff, and reads confirming writes when the write time ends', async (t) => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const get = (path, body) => ({ expect: { method: 'GET', path: `/rest/api/3/${path}` }, body });
  // A prompt create screen with 30 tabs, each read taking a second.
  const tabs = Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, name: `Tab ${i}` }));
  const routes = () => [
    get('screens?id=50&maxResults=100', { isLast: true, values: [{ id: 50, name: 'Create' }] }),
    get('screens/50/tabs', tabs),
    ...tabs.map((tab) => get(`screens/50/tabs/${tab.id}/fields`, [{ id: 'summary' }])),
  ];
  const timed = (s) => {
    const started = [];
    const asUser = s.api.asUser;
    s.api.asUser = () => {
      const user = asUser();
      return {
        requestJira: (...args) => {
          started.push(now - 1_000_000);
          now += 1_000;
          return user.requestJira(...args);
        },
      };
    };
    return started;
  };
  let s = sdk(...routes());
  let started = timed(s);
  await assert.rejects(
    createSettingsPorts(s).screens(['50'], 'customfield_1', ['50']),
    /could not all be read in time/,
  );
  assert.equal(Math.max(...started), 12_000);
  // The same reads confirming writes go on until the write time ends at 22 seconds.
  now = 1_000_000;
  s = sdk(...routes());
  started = timed(s);
  await assert.rejects(
    createSettingsPorts(s).screens(['50'], 'customfield_1', ['50'], true),
    /could not all be read in time/,
  );
  assert.equal(Math.max(...started), 22_000);
});
test('a read failing near the end of the write time is not tried again, so the step ends in time', async (t) => {
  const { createSettingsPorts } = await import('../src/integration.ts');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const names = {
    expect: { method: 'GET', path: '/rest/api/3/screens?id=50&maxResults=100' },
    body: { isLast: true, values: [{ id: 50, name: 'Edit' }] },
  };
  const placed = {
    expect: { method: 'GET', path: /^\/rest\/api\/3\/field\/customfield_1\/screens\?/ },
    body: { startAt: 0, isLast: true, values: [{ id: 50, tab: { id: 7 } }] },
  };
  // Each Jira answer takes 800 ms; the retry pauses (500 ms, then 1 s) run on the mocked clock.
  const confirm = async (startAt, ...responses) => {
    const s = sdk(...responses);
    const asUser = s.api.asUser;
    s.api.asUser = () => ({
      requestJira: (...args) => (t.mock.timers.tick(800), asUser().requestJira(...args)),
    });
    const ports = createSettingsPorts(s);
    t.mock.timers.tick(startAt);
    const read = ports.screens(['50'], 'customfield_1', [], true).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(100);
    }
    return { outcome: await read, s, ports };
  };
  // Early in the step, a 503 is tried again as usual.
  const early = await confirm(10_000, { status: 503 }, names, placed);
  assert.deepEqual(early.outcome.value, [
    { id: '50', name: 'Edit', tabs: [{ id: '7', fields: ['customfield_1'] }] },
  ]);
  early.s.assertDrained();
  // Started at 21.5 seconds, the 503 arrives at 22.3: no retry, the read fails at once.
  const late = await confirm(21_500, { status: 503 }, names, placed);
  assert.match(late.outcome.error.message, /HTTP 503/);
  assert.equal(late.s.calls.length, 1);
});
