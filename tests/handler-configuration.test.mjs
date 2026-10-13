import './typescript-loader.mjs';
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
      case 'POST /rest/api/3/search/jql':
        return { issues: [], isLast: true };
      case 'GET /rest/api/3/issue/createmeta/1/issuetypes/20':
        return { total: 2, fields: [{ fieldId: 'summary' }, { fieldId: 'description' }] };
      case 'POST /rest/api/3/issuetype': {
        const created = { id: '20', name: body.name, subtask: false, hierarchyLevel: 0 };
        types.push(created);
        return created;
      }
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
  return { api, writes, reads, project, types };
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
      transact: () => ({
        set: (key, value, options) => ({
          execute: async () => {
            assert.equal(options.entityName, 'native-prompt-state');
            const [attribute, condition] = options.conditions.condition;
            assert.equal(attribute, 'revision');
            conditions.push([key, condition]);
            const current = records.get(key);
            if (condition === 'missing' ? current : current?.revision !== condition[1])
              throw Error('conditional write failed');
            records.set(key, structuredClone(value));
          },
        }),
      }),
    },
  };
}

function harness() {
  const site = jira();
  const kv = store();
  const route = (strings, ...values) =>
    strings.reduce(
      (out, part, i) =>
        out + part + (i < values.length ? encodeURIComponent(String(values[i])) : ''),
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
  const catalog = await h.call('configuration-catalog', {});
  assert.deepEqual(
    catalog.projects.map((p) => p.key),
    ['ONE'],
  );
  assert.deepEqual(
    catalog.types.map((t) => t.name),
    ['Task'],
  );
  const input = { name: 'Prompt', refreshAfterSave: true };
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
  assert.deepEqual(started.data.input, { name: 'Prompt', refreshAfterSave: true });
  assert.deepEqual(h.site.writes, [], 'starting the batch never writes Jira');

  const finished = await h.call('configuration-advance', {
    id: started.data.id,
    revision: started.revision,
  });
  assert.equal(finished.data.status, 'complete');
  assert.equal(finished.data.entries[0].status, 'done');

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
  const input = { type: '10', refreshAfterSave: false };
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
  const input = { name: 'Prompt' };
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
