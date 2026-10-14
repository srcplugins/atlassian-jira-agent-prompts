import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { registerResolvers } = await import('../src/integration.ts');

// Space configuration through the registered resolvers: the real handlers and Jira and storage
// adapters, a small Jira that answers by endpoint, and a conditional storage emulator. Expected
// request bodies and storage conditions are written out by hand.
const FIELD = 'customfield_10001';
const context = { accountId: 'admin', extension: {} };

function jira() {
  const task = { id: '10', name: 'Task', subtask: false, hierarchyLevel: 0 };
  const project = {
    id: '1',
    key: 'ONE',
    name: 'One',
    style: 'classic',
    projectTypeKey: 'software',
    issueTypes: [task],
  };
  const types = [task];
  // One screen (50) serves every work type and operation; screen 51 serves Task's edit and view.
  const screens = {
    50: { name: 'Default screen', tabs: { 60: ['summary', 'description'] } },
    51: { name: 'Task screen', tabs: { 61: ['summary'], 62: [] } },
  };
  const screenSchemes = {
    40: { default: 50 },
    41: { default: 50, edit: 51, view: 51 },
  };
  const mapping = [{ issueTypeId: 'default', screenSchemeId: '40' }];
  const writes = [];
  const reads = [];
  const answer = (method, path, body) => {
    const url = new URL(`https://jira.invalid${path}`);
    const query = Object.fromEntries(url.searchParams);
    const route = `${method} ${url.pathname}`;
    if (method !== 'GET') writes.push({ route, query, body });
    else reads.push(route);
    switch (route) {
      case 'GET /rest/api/3/mypermissions':
        assert.equal(query.permissions, 'ADMINISTER');
        return { permissions: { ADMINISTER: { havePermission: true } } };
      case 'GET /rest/api/3/project/search':
        assert.equal(query.typeKey, 'software');
        return {
          startAt: Number(query.startAt),
          isLast: true,
          values: [{ id: '1', key: 'ONE', name: 'One', style: 'classic' }],
        };
      case 'GET /rest/api/3/project/1':
        return structuredClone(project);
      case 'GET /rest/api/3/issuetype':
        return structuredClone(types);
      case 'GET /rest/api/3/issuetypescheme/project':
        assert.equal(query.projectId, '1');
        return { isLast: true, values: [{ issueTypeScheme: { id: '5' }, projectIds: ['1'] }] };
      case 'GET /rest/api/3/issuetypescheme':
        assert.deepEqual(query, { id: '5', expand: 'projects' });
        return {
          isLast: true,
          values: [
            {
              id: '5',
              name: 'ONE scheme',
              isDefault: false,
              projects: { isLast: true, total: 1, values: [{ id: '1', key: 'ONE', name: 'One' }] },
            },
          ],
        };
      case 'GET /rest/api/3/field':
        return [{ id: FIELD, schema: { custom: 'exact-field' } }];
      case 'GET /rest/api/3/issue/createmeta/1/issuetypes/20':
        return { total: 2, fields: [{ fieldId: 'summary' }, { fieldId: 'description' }] };
      case 'POST /rest/api/3/issuetype': {
        const created = { id: '20', name: body.name, subtask: false, hierarchyLevel: 0 };
        types.push(created);
        return created;
      }
      case 'GET /rest/api/3/issuetypescreenscheme/project':
        assert.equal(query.projectId, '1');
        return {
          isLast: true,
          values: [{ issueTypeScreenScheme: { id: '30' }, projectIds: ['1'] }],
        };
      case 'GET /rest/api/3/issuetypescreenscheme/mapping':
        assert.deepEqual(query, { issueTypeScreenSchemeId: '30', startAt: '0', maxResults: '100' });
        return {
          startAt: 0,
          isLast: true,
          values: mapping.map((row) => ({ ...row, issueTypeScreenSchemeId: '30' })),
        };
      case 'GET /rest/api/3/screenscheme': {
        // Scheme 42 shares screen 51 with another space's work type screen scheme; scheme 43
        // is unassigned, so Jira omits its expansion.
        const all = { ...screenSchemes, 42: { default: 51 }, 43: { default: 52 } };
        const users = { 40: ['30'], 41: ['30'], 42: ['31'] };
        const item = (id, expand) => ({
          id: Number(id),
          screens: all[id],
          ...(expand && users[id]
            ? {
                issueTypeScreenSchemes: { isLast: true, values: users[id].map((i) => ({ id: i })) },
              }
            : {}),
        });
        const ids = url.searchParams.getAll('id');
        if (ids.length) return { isLast: true, values: ids.map((id) => item(id)) };
        assert.deepEqual(query, {
          startAt: '0',
          maxResults: '100',
          expand: 'issueTypeScreenSchemes',
        });
        return { startAt: 0, isLast: true, values: Object.keys(all).map((id) => item(id, true)) };
      }
      case 'GET /rest/api/3/issuetypescreenscheme/30/project':
      case 'GET /rest/api/3/issuetypescreenscheme/31/project': {
        const two = url.pathname.includes('/31/');
        return {
          startAt: 0,
          isLast: true,
          values: [
            two ? { id: '2', key: 'TWO', name: 'Two' } : { id: '1', key: 'ONE', name: 'One' },
          ],
        };
      }
      case 'GET /rest/api/3/screens':
        return {
          isLast: true,
          values: url.searchParams
            .getAll('id')
            .filter((id) => screens[id])
            .map((id) => ({ id: Number(id), name: screens[id].name })),
        };
      case `GET /rest/api/3/field/${FIELD}/screens`:
        assert.deepEqual(query, { startAt: '0', maxResults: '100', expand: 'tab' });
        return {
          startAt: 0,
          isLast: true,
          values: Object.entries(screens).flatMap(([id, screen]) =>
            Object.entries(screen.tabs)
              .filter(([, fields]) => fields.includes(FIELD))
              .map(([tab]) => ({ id: Number(id), name: screen.name, tab: { id: Number(tab) } })),
          ),
        };
      default:
        break;
    }
    const tabRoute = url.pathname.match(
      /^\/rest\/api\/3\/screens\/(\d+)\/tabs(?:\/(\d+)\/fields(?:\/([^/]+))?)?$/,
    );
    if (tabRoute) {
      const [, screen, tab, field] = tabRoute;
      const tabs = screens[screen].tabs;
      if (method === 'GET' && !tab) return Object.keys(tabs).map((id) => ({ id: Number(id) }));
      if (method === 'GET' && !field) return tabs[tab].map((id) => ({ id, name: id }));
      if (method === 'POST' && !field) {
        tabs[tab].push(body.fieldId);
        return { id: body.fieldId, name: 'Agent Prompts' };
      }
      if (method === 'DELETE' && field) {
        tabs[tab].splice(tabs[tab].indexOf(decodeURIComponent(field)), 1);
        return null;
      }
    }
    switch (route) {
      case 'PUT /rest/api/3/issuetypescheme/5/issuetype':
        for (const id of body.issueTypeIds)
          project.issueTypes.push(types.find((type) => type.id === id));
        return null;
      default:
        throw Error(`Unexpected Jira request: ${route}`);
    }
  };
  const api = {
    asUser: () => ({
      requestJira: async (path, options = {}) => {
        const method = options.method ?? 'GET';
        const body = answer(method, path, options.body && JSON.parse(options.body));
        return {
          ok: true,
          status: body === null ? 204 : 200,
          json: async () => structuredClone(body),
        };
      },
    }),
    asApp: () => {
      throw Error('Unexpected asApp actor');
    },
  };
  return { api, writes, reads, project, types, screens, screenSchemes, mapping };
}

function store() {
  const records = new Map();
  const conditions = [];
  class Filter {
    and(name, condition) {
      this.condition = [name, condition];
      return this;
    }
  }
  return {
    records,
    conditions,
    Filter,
    FilterConditions: { notExists: () => 'missing', equalTo: (value) => ['equal', value] },
    kvs: {
      entity: (name) => {
        assert.equal(name, 'native-prompt-state');
        return { get: async (key) => structuredClone(records.get(key)) };
      },
      transact: () => {
        // All operations commit together, and only when every condition holds.
        const operations = [];
        const transaction = {
          set: (key, value, options) => (operations.push([key, value, options]), transaction),
          delete: (key, options) => (operations.push([key, undefined, options]), transaction),
          execute: async () => {
            for (const [key, , options] of operations) {
              assert.equal(options.entityName, 'native-prompt-state');
              const [attribute, condition] = options.conditions.condition;
              assert.equal(attribute, 'revision');
              conditions.push([key, condition]);
              const current = records.get(key);
              if (condition === 'missing' ? current : current?.revision !== condition[1])
                throw Error('conditional write failed');
            }
            for (const [key, value] of operations)
              if (value === undefined) records.delete(key);
              else records.set(key, structuredClone(value));
          },
        };
        return transaction;
      },
    },
  };
}

function harness() {
  const site = jira();
  const kv = store();
  const route = (strings, ...values) =>
    strings.reduce(
      (out, part, i) =>
        out +
        part +
        (i >= values.length
          ? ''
          : values[i] instanceof URLSearchParams
            ? values[i].toString()
            : encodeURIComponent(String(values[i]))),
      '',
    );
  class Resolver {
    definitions = {};
    define(name, callback) {
      this.definitions[name] = callback;
    }
    getDefinitions() {
      return this.definitions;
    }
  }
  const resolvers = registerResolvers({
    Resolver,
    api: site.api,
    route,
    ...kv,
    fieldType: () => 'exact-field',
  });
  const call = async (name, payload) => {
    const result = await resolvers[name]({ context, payload });
    assert.equal(result.ok, true, `${name}: ${result.error}`);
    return result.value;
  };
  return { site, kv, call, resolvers };
}

test('configure, review, apply and finish through the resolvers creates one type and attaches it once', async () => {
  const h = harness();
  // Opening the dialog reads the work types only; the space inventory is the health view's.
  const catalog = await h.call('configuration-catalog', {});
  assert.deepEqual(
    catalog.types.map((t) => t.name),
    ['Task'],
  );
  assert.equal('projects' in catalog, false);
  assert.deepEqual(h.site.reads, ['GET /rest/api/3/mypermissions', 'GET /rest/api/3/issuetype']);
  // The Work types step reads only the space itself: the site and space permission checks, then
  // the space. No work type, scheme or screen reads.
  const optionReads = h.site.reads.length;
  const options = await h.call('configuration-options', { projectId: '1' });
  assert.deepEqual(options, { availableTypes: [{ id: '10', name: 'Task' }], screenTypes: [] });
  assert.deepEqual(h.site.reads.slice(optionReads), [
    'GET /rest/api/3/mypermissions',
    'GET /rest/api/3/mypermissions',
    'GET /rest/api/3/project/1',
  ]);
  const input = { name: 'Prompt', reloadAfterSave: 'on' };
  const preview = await h.call('configuration-preview', { projectId: '1', ...input });
  assert.equal(typeof preview.fingerprint, 'string');
  assert.deepEqual(h.site.writes, [], 'review never writes');
  assert.deepEqual(h.kv.conditions, [], 'review never writes storage');

  const started = await h.call('configuration-start', {
    ...input,
    entries: [{ projectId: '1', fingerprint: preview.fingerprint }],
    revision: 0,
  });
  assert.equal(started.data.status, 'ready');
  assert.equal(started.data.actor, 'admin');
  assert.deepEqual(started.data.input, { name: 'Prompt', reloadAfterSave: 'on' });
  assert.deepEqual(h.site.writes, [], 'starting the batch never writes Jira');

  const readsBefore = h.site.reads.length;
  const finished = await h.call('configuration-advance', {
    id: started.data.id,
    revision: started.revision,
  });
  assert.equal(finished.data.status, 'complete');
  assert.equal(finished.data.entries[0].status, 'done');

  // The step reviews the space once and applies from that review. Derived by hand: the review
  // reads the space, its types, its scheme, and the new type's create screen with its tabs and
  // fields once (no other screen is selected, so the field's screen list is not read); the
  // apply path re-reads only the scheme (before creation, before attachment and after it) and
  // the space after attachment.
  const stepReads = h.site.reads.slice(readsBefore);
  const count = (route) => stepReads.filter((r) => r === route).length;
  const matching = (route) => stepReads.filter((r) => route.test(r)).length;
  assert.equal(count('GET /rest/api/3/issuetype'), 1);
  assert.equal(count('GET /rest/api/3/issuetypescreenscheme/project'), 1);
  assert.equal(count('GET /rest/api/3/screens'), 1);
  assert.equal(matching(/^GET \/rest\/api\/3\/screens\/\d+\/tabs$/), 1);
  assert.equal(matching(/^GET \/rest\/api\/3\/screens\/\d+\/tabs\/\d+\/fields$/), 1);
  assert.equal(count(`GET /rest/api/3/field/${FIELD}/screens`), 0);
  assert.equal(count('GET /rest/api/3/project/1'), 2);
  assert.equal(count('GET /rest/api/3/issuetypescheme/project'), 4);

  // Exactly one created type and one scheme addition, with the bodies Jira documents.
  assert.deepEqual(h.site.writes, [
    {
      route: 'POST /rest/api/3/issuetype',
      query: {},
      body: {
        name: 'Prompt',
        hierarchyLevel: 0,
        description: 'Reusable instructions managed through Agent Prompts for Jira.',
      },
    },
    {
      route: 'PUT /rest/api/3/issuetypescheme/5/issuetype',
      query: {},
      body: { issueTypeIds: ['20'] },
    },
  ]);
  assert.equal(h.kv.records.get('config-1').data.type, '20');
  assert.equal(h.kv.records.get('config-1').data.refreshAfterSave, true);
  assert.equal(h.kv.records.get('config-1').data.pending, undefined);

  // Every storage write was conditional: first writes require absence, later ones the exact
  // previous revision.
  const byKey = (key) =>
    h.kv.conditions.filter(([k]) => k === key).map(([, condition]) => condition);
  // The batch keeps its original storage key so a batch saved before an upgrade stays readable.
  assert.deepEqual(byKey('configuration-batch')[0], 'missing');
  for (const [i, condition] of byKey('configuration-batch').slice(1).entries())
    assert.deepEqual(condition, ['equal', i + 1]);
  assert.deepEqual(byKey('config-1')[0], 'missing');
  for (const [i, condition] of byKey('config-1').slice(1).entries())
    assert.deepEqual(condition, ['equal', i + 1]);

  const status = await h.call('configuration-status', {});
  assert.equal(status.revision, finished.revision);
});

test('a reviewed configuration that is stopped before it advances writes nothing to Jira', async () => {
  const h = harness();
  const input = { type: '10', reloadAfterSave: 'off' };
  const preview = await h.call('configuration-preview', { projectId: '1', ...input });
  const started = await h.call('configuration-start', {
    ...input,
    entries: [{ projectId: '1', fingerprint: preview.fingerprint }],
    revision: 0,
  });
  const stopped = await h.call('configuration-stop', {
    id: started.data.id,
    revision: started.revision,
  });
  assert.equal(stopped.data.status, 'stopped');
  assert.deepEqual(h.site.writes, []);
  assert.equal(h.kv.records.has('config-1'), false);
  // A stale revision is refused rather than overwriting the stopped batch.
  const stale = await h.resolvers['configuration-advance']({
    context,
    payload: { id: started.data.id, revision: started.revision },
  });
  assert.equal(stale.ok, false);
  assert.deepEqual(h.site.writes, []);
});

test('a review whose facts changed before apply is refused without a Jira write', async () => {
  const h = harness();
  const input = { name: 'Prompt', reloadAfterSave: 'keep' };
  const preview = await h.call('configuration-preview', { projectId: '1', ...input });
  // A well-formed fingerprint from a review of different facts.
  const stale = preview.fingerprint.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  const started = await h.call('configuration-start', {
    ...input,
    entries: [{ projectId: '1', fingerprint: stale }],
    revision: 0,
  });
  const advanced = await h.call('configuration-advance', {
    id: started.data.id,
    revision: started.revision,
  });
  assert.equal(advanced.data.status, 'stopped');
  assert.match(advanced.data.message, /changed after review/);
  assert.deepEqual(h.site.writes, []);
  assert.equal(h.kv.records.has('config-1'), false);
});

test('a field used by more than a thousand screens blocks the space after ten pages, before any write', async () => {
  const h = harness();
  h.site.mapping.push({ issueTypeId: '10', screenSchemeId: '41' });
  const route = `GET /rest/api/3/field/${FIELD}/screens`;
  const asUser = h.site.api.asUser;
  // The field's screen list never reports its last page.
  h.site.api.asUser = () => {
    const actor = asUser();
    return {
      requestJira: async (path, options) => {
        if (!path.startsWith(`/rest/api/3/field/${FIELD}/screens`))
          return actor.requestJira(path, options);
        h.site.reads.push(route);
        const start = Number(new URL(`https://jira.invalid${path}`).searchParams.get('startAt'));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            startAt: start,
            isLast: false,
            values: Array.from({ length: 100 }, (_, i) => ({
              id: 1000 + start + i,
              name: 'Screen',
              tab: { id: 1 },
            })),
          }),
        };
      },
    };
  };
  // Like any screen blocker, the cap blocks the space on the Review step rather than failing it.
  const preview = await h.call('configuration-preview', {
    projectId: '1',
    name: 'Prompt',
    reloadAfterSave: 'keep',
    screenTypes: ['10'],
  });
  assert.equal(preview.blocked, 'Too many screens use the Agent Prompts field to review at once.');
  assert.equal(h.site.reads.filter((r) => r === route).length, 10);
  assert.deepEqual(h.site.writes, []);
});

test('selected work types get the field on a shared screen with approval, and lose it on deselection', async () => {
  const h = harness();
  h.site.mapping.push({ issueTypeId: '10', screenSchemeId: '41' });
  const input = { name: 'Prompt', reloadAfterSave: 'keep', screenTypes: ['10'] };
  const preview = await h.call('configuration-preview', { projectId: '1', ...input });
  assert.deepEqual(preview.availableTypes, [{ id: '10', name: 'Task' }]);
  assert.deepEqual(
    preview.screens.changes.map((ch) => [ch.action, ch.screen, ch.tab, ch.impact.shared]),
    [['add', { id: '51', name: 'Task screen' }, '61', true]],
  );
  assert.deepEqual(
    preview.screenProjects['51'].map((p) => p.key),
    ['ONE', 'TWO'],
  );
  assert.deepEqual(h.site.writes, [], 'review never writes');
  const entries = [{ projectId: '1', fingerprint: preview.fingerprint, screenTypes: ['10'] }];
  let run = await h.call('configuration-start', {
    name: 'Prompt',
    reloadAfterSave: 'keep',
    entries,
    revision: 0,
  });
  run = await h.call('configuration-advance', { id: run.data.id, revision: run.revision });
  assert.equal(run.data.status, 'stopped');
  assert.match(run.data.message, /Confirm the shared screens/);
  assert.deepEqual(h.site.writes, []);

  run = await h.call('configuration-start', {
    name: 'Prompt',
    reloadAfterSave: 'keep',
    allowSharedScreens: true,
    entries,
    revision: run.revision,
  });
  run = await h.call('configuration-advance', { id: run.data.id, revision: run.revision });
  assert.equal(run.data.status, 'complete', run.data.message);
  assert.deepEqual(h.site.writes.slice(2), [
    {
      route: 'POST /rest/api/3/screens/51/tabs/61/fields',
      query: {},
      body: { fieldId: FIELD },
    },
  ]);
  assert.deepEqual(h.kv.records.get('screen-51'), {
    revision: 1,
    data: { field: FIELD, projects: ['1'] },
  });
  assert.deepEqual(h.kv.records.get('config-1').data.screenTypes, ['10']);
  assert.deepEqual(h.kv.records.get('config-1').data.screens, ['51']);
  const recorded = h.kv.conditions.filter(([key]) => key === 'screen-51');
  assert.deepEqual(recorded, [['screen-51', 'missing']]);

  const removal = await h.call('configuration-preview', {
    projectId: '1',
    type: '20',
    reloadAfterSave: 'keep',
    screenTypes: [],
  });
  assert.deepEqual(
    removal.screens.changes.map((ch) => [ch.action, ch.screen.id, ch.tab]),
    [['remove', '51', '61']],
  );
  const before = h.kv.records.get('config-1').revision;
  run = await h.call('configuration-start', {
    type: '20',
    reloadAfterSave: 'keep',
    allowSharedScreens: true,
    entries: [{ projectId: '1', fingerprint: removal.fingerprint, screenTypes: [] }],
    revision: run.revision,
  });
  run = await h.call('configuration-advance', { id: run.data.id, revision: run.revision });
  assert.equal(run.data.status, 'complete', run.data.message);
  assert.deepEqual(h.site.writes.slice(3), [
    {
      route: `DELETE /rest/api/3/screens/51/tabs/61/fields/${FIELD}`,
      query: {},
      body: undefined,
    },
  ]);
  assert.equal(h.kv.records.has('screen-51'), false);
  // The removal is recorded with the space's setup in one transaction, then the setup is saved.
  assert.deepEqual(h.kv.conditions.filter(([key]) => key !== 'configuration-batch').slice(-3), [
    ['config-1', ['equal', before]],
    ['screen-51', ['equal', 1]],
    ['config-1', ['equal', before + 1]],
  ]);
  assert.equal(h.kv.records.get('config-1').data.screenTypes, undefined);
});

test('the reload choice keeps, sets or clears each space’s saved preference', async () => {
  // Expected stored preference after configuring a space whose saved value is on, off or unset.
  const cases = [
    ['keep', true, true],
    ['keep', false, false],
    ['keep', undefined, undefined],
    ['on', false, true],
    ['on', undefined, true],
    ['off', true, false],
    ['off', undefined, false],
  ];
  for (const [reloadAfterSave, saved, expected] of cases) {
    const h = harness();
    h.kv.records.set('config-1', {
      revision: 1,
      data: { type: '10', ...(saved === undefined ? {} : { refreshAfterSave: saved }) },
    });
    const input = { type: '10', reloadAfterSave };
    const preview = await h.call('configuration-preview', { projectId: '1', ...input });
    let run = await h.call('configuration-start', {
      ...input,
      entries: [{ projectId: '1', fingerprint: preview.fingerprint }],
      revision: 0,
    });
    run = await h.call('configuration-advance', { id: run.data.id, revision: run.revision });
    assert.equal(run.data.status, 'complete', run.data.message);
    const data = h.kv.records.get('config-1').data;
    assert.equal(data.type, '10');
    assert.equal(data.refreshAfterSave, expected, `${reloadAfterSave} from ${saved}`);
    assert.equal('refreshAfterSave' in data, expected !== undefined);
    assert.deepEqual(h.site.writes, []);
  }
});

test('a missing or unknown reload choice is refused before any Jira request', async () => {
  for (const reloadAfterSave of [undefined, true, false, 'yes', 'Keep', null]) {
    const h = harness();
    const input = {
      type: '10',
      ...(reloadAfterSave === undefined ? {} : { reloadAfterSave }),
    };
    for (const [name, payload] of [
      ['configuration-preview', { projectId: '1', ...input }],
      [
        'configuration-start',
        { ...input, entries: [{ projectId: '1', fingerprint: 'a'.repeat(64) }], revision: 0 },
      ],
    ]) {
      const result = await h.resolvers[name]({ context, payload });
      assert.deepEqual(result, { ok: false, error: 'Invalid display preference.' }, name);
    }
    assert.deepEqual(h.site.reads, []);
    assert.deepEqual(h.site.writes, []);
    assert.deepEqual(h.kv.conditions, []);
  }
  // The retired boolean field is not accepted under either name.
  const h = harness();
  const result = await h.resolvers['configuration-preview']({
    context,
    payload: { projectId: '1', type: '10', refreshAfterSave: true },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(h.site.reads, []);
});

test('a configuration run saved with the retired reload option stops without a change', async () => {
  const h = harness();
  h.kv.records.set('config-1', { revision: 1, data: { type: '10', refreshAfterSave: true } });
  const preview = await h.call('configuration-preview', {
    projectId: '1',
    type: '10',
    reloadAfterSave: 'off',
  });
  // A run saved by an earlier version, which stored the reload option as a boolean.
  h.kv.records.set('configuration-batch', {
    revision: 1,
    data: {
      id: 'earlier',
      actor: 'admin',
      input: { type: '10', refreshAfterSave: false },
      entries: [{ projectId: '1', fingerprint: preview.fingerprint, status: 'waiting' }],
      index: 0,
      status: 'ready',
      started: Date.now(),
    },
  });
  const run = await h.call('configuration-advance', { id: 'earlier', revision: 1 });
  assert.equal(run.data.status, 'stopped');
  assert.match(
    run.data.message,
    /^Nothing was changed for this space: Invalid display preference\./,
  );
  assert.deepEqual(h.site.writes, []);
  assert.deepEqual(h.kv.records.get('config-1'), {
    revision: 1,
    data: { type: '10', refreshAfterSave: true },
  });
});
