import './typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createService, JiraRejected, UserError } = await import('../src/service.ts');
const { sourceContent } = await import('../src/prompt-text.ts');
const { createSettings } = await import('../src/settings.ts');
const doc = (text) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const sourceDoc = doc;
const c = { accountId: 'actor', projectId: '1', issueId: '10' };
function fixture() {
  let stored;
  let calls = 0;
  let failAfterWrite = false;
  const target = {
    id: '10',
    key: 'TEST-10',
    fields: {
      project: { id: '1' },
      issuetype: { id: '2' },
      summary: 'Work',
      updated: '1',
      description: doc('Keep this'),
    },
  };
  const source = {
    id: '20',
    key: 'TEST-20',
    fields: {
      project: { id: '1' },
      issuetype: { id: '3' },
      summary: 'Review',
      description: sourceDoc('Check errors'),
      updated: '1',
    },
  };
  const ports = {
    refreshAfterSave: async () => false,
    retainedTypes: async () => [],
    config: async () => '3',
    field: async () => 'customfield_1',
    allowed: async () => {},
    search: async () => ({
      prompts: [{ id: '20', key: source.key, name: source.fields.summary }],
      incomplete: false,
    }),
    issue: async (id) => structuredClone(id === '10' ? target : source),
    get: async () => structuredClone(stored),
    cas: async (id, revision, data) => {
      if ((stored?.revision ?? 0) !== revision) throw Error('conflict');
      stored = { revision: revision + 1, data: structuredClone(data) };
    },
    update: async (id, fields) => {
      calls++;
      Object.assign(target.fields, structuredClone(fields));
      target.fields.updated += '1';
      if (failAfterWrite) throw Error('lost');
    },
  };
  return {
    ports,
    service: createService(ports),
    target,
    source,
    calls: () => calls,
    loseResponse: () => {
      failAfterWrite = true;
    },
  };
}
test('saved snapshots stay unchanged until an explicit Sync, then removal preserves original ADF', async () => {
  const f = fixture();
  const original = structuredClone(f.target.fields.description);
  const loaded = await f.service.load(c);
  let saved = await f.service.save(c, { ...loaded, ids: ['20'] });
  const linked = structuredClone(f.target.fields.description);
  assert.deepEqual(f.target.fields.customfield_1, ['TEST-20']);
  assert.deepEqual(linked.content[0], original.content[0]);
  assert.equal(linked.content[1].type, 'expand');
  assert.match(JSON.stringify(linked), /Check errors/);
  f.source.fields.description = sourceDoc('Updated instructions');
  assert.deepEqual(f.target.fields.description, linked);
  saved = await f.service.save(c, saved);
  assert.match(JSON.stringify(f.target.fields.description), /Updated instructions/);
  assert.doesNotMatch(JSON.stringify(f.target.fields.description), /Check errors/);
  assert.equal((await f.service.read(c, '20')).content, 'Updated instructions');
  await f.service.save(c, { ...saved, ids: [] });
  assert.deepEqual(f.target.fields.description, original);
});
test('stale work item, modified managed content and moved source stop writes', async () => {
  for (const mode of ['stale', 'managed', 'moved']) {
    const f = fixture();
    let loaded = await f.service.load(c);
    if (mode === 'stale') f.target.fields.updated = '2';
    if (mode === 'moved') f.source.fields.project.id = '2';
    if (mode === 'managed') {
      await f.service.save(c, { ...loaded, ids: ['20'] });
      f.target.fields.description.content[1].attrs.resourceId = 'Manual edit';
      loaded = await f.service.load(c);
    }
    const before = f.calls();
    await assert.rejects(f.service.save(c, { ...loaded, ids: ['20'] }));
    assert.equal(f.calls(), before);
  }
});
test('lost successful response recovers by observation without repeating mutation', async () => {
  const f = fixture();
  const loaded = await f.service.load(c);
  f.loseResponse();
  await assert.rejects(f.service.save(c, { ...loaded, ids: ['20'] }), /could not be confirmed/);
  assert.deepEqual((await f.service.load(c)).ids, ['20']);
  assert.equal(f.calls(), 1);
});
test('concurrent saves claim the target once', async () => {
  const f = fixture();
  const loaded = await f.service.load(c);
  const results = await Promise.allSettled(
    [1, 2].map(() => f.service.save(c, { ...loaded, ids: ['20'] })),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls(), 1);
});
test('source text is bounded and refuses embedded cards', () => {
  assert.throws(() => sourceContent(doc('x'.repeat(4001))), /4000/);
  assert.throws(
    () =>
      sourceContent({
        type: 'doc',
        version: 1,
        content: [{ type: 'inlineCard', attrs: { url: 'https://example.com' } }],
      }),
    /unsupported/,
  );
});

test('plain-text reads reject meaningful or unknown marks instead of silently changing instructions', () => {
  for (const mark of [
    { type: 'link', attrs: { href: 'https://example.com/required-policy' } },
    { type: 'strike' },
    { type: 'subsup', attrs: { type: 'sup' } },
    { type: 'future-semantic-mark' },
  ]) {
    const value = doc('Follow this instruction');
    value.content[0].content[0].marks = [mark];
    assert.throws(() => sourceContent(value), /cannot be safely represented.*Read it in Jira/);
  }
  const formatted = doc('Ordinary emphasis and code');
  formatted.content[0].content[0].marks = [{ type: 'strong' }, { type: 'em' }, { type: 'code' }];
  assert.equal(sourceContent(formatted), 'Ordinary emphasis and code');
});

test('Rovo refuses lossy text while snapshots preserve rich source formatting', async () => {
  const f = fixture();
  f.source.fields.description.content[0].content[0].marks = [{ type: 'strike' }];
  const original = structuredClone(f.source.fields.description);
  await assert.rejects(f.service.read(c, '20'), /Read it in Jira/);
  await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
  assert.deepEqual(f.source.fields.description, original);
  assert.equal(f.target.fields.description.content[1].type, 'expand');
  assert.deepEqual(f.target.fields.description.content[1].content[1], original.content[0]);
});

test('reordered Jira object keys do not prevent successful readback recovery', async () => {
  const f = fixture();
  const update = f.ports.update;
  f.ports.update = async (...args) => {
    await update(...args);
    const d = f.target.fields.description;
    f.target.fields.description = { content: d.content, version: d.version, type: d.type };
  };
  const loaded = await f.service.load(c);
  await f.service.save(c, { ...loaded, ids: ['20'] });
  assert.equal(f.calls(), 1);
});

test('type replacement preserves existing selected sources but rejects new selections of previous types', async () => {
  const f = fixture();
  const loaded = await f.service.load(c);
  await f.service.save(c, { ...loaded, ids: ['20'] });
  f.ports.config = async () => '4';
  f.ports.retainedTypes = async () => ['3'];
  let current = await f.service.load(c);
  await f.service.save(c, current);
  current = await f.service.load(c);
  await f.service.save(c, { ...current, ids: [] });
  current = await f.service.load(c);
  await assert.rejects(f.service.save(c, { ...current, ids: ['20'] }), /changed type/);
});

test('selected current-type prompts outside search results retain their visible metadata', async () => {
  for (const retained of [[], ['4']]) {
    const f = fixture();
    await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
    f.ports.search = async () => ({ prompts: [], incomplete: true });
    f.ports.retainedTypes = async () => retained;
    const value = await f.service.load(c);
    assert.deepEqual(value.prompts, [{ id: '20', key: 'TEST-20', name: 'Review' }]);
    assert.equal(value.incomplete, true);
  }
});

test('selected hidden or moved sources remain removable without exposing metadata', async () => {
  for (const mode of ['hidden', 'moved']) {
    const f = fixture();
    await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
    f.ports.search = async () => ({ prompts: [], incomplete: false });
    if (mode === 'moved') f.source.fields.project.id = '2';
    else {
      const read = f.ports.issue;
      f.ports.issue = async (id) => {
        if (id === '20') throw Error('denied');
        return read(id);
      };
    }
    const value = await f.service.load(c);
    assert.deepEqual(value.prompts, []);
    assert.deepEqual(value.ids, ['20']);
    await f.service.save(c, { ...value, ids: [] });
    assert.deepEqual(f.target.fields.customfield_1, []);
  }
});

test('unchanged saves never issue a write or publish a recoverable in-flight claim', async () => {
  const f = fixture();
  const saved = await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
  f.ports.update = async () => assert.fail('unchanged content must not be written');
  f.ports.cas = async () => assert.fail('unchanged state must not acquire a pending claim');
  assert.deepEqual(await f.service.save(c, saved), saved);
  assert.deepEqual((await f.service.load(c)).ids, ['20']);
});

test('changing setup to a type whose prompts are selected permits only cleanup without searching the new catalog', async () => {
  const f = fixture();
  let config = { revision: 1, data: { type: '3' } };
  const types = ['2', '3'].map((id) => ({
    id,
    name: `Type ${id}`,
    subtask: false,
    hierarchyLevel: 0,
  }));
  f.ports.config = async () => config.data.type;
  f.ports.retainedTypes = async () => config.data.previousTypes ?? [];
  f.ports.project = async () => ({
    id: '1',
    key: 'TEST',
    style: 'classic',
    projectTypeKey: 'software',
    issueTypes: types,
  });
  const read = f.ports.issue;
  f.ports.issue = async (id) =>
    id === '21' ? { ...structuredClone(f.source), id: '21', key: 'TEST-21' } : read(id);
  await f.service.save(c, { ...(await f.service.load(c)), ids: ['20', '21'] });
  const settings = createSettings(f.ports, {
    get: async () => structuredClone(config),
    cas: async (_project, revision, data) => {
      assert.equal(revision, config.revision);
      config = { revision: revision + 1, data: structuredClone(data) };
    },
    types: async () => types,
    scheme: async () => ({ id: '9', name: 'Dedicated', isDefault: false, projectIds: ['1'] }),
    impact: async () => ({ keys: ['TEST-10'], incomplete: false }),
    create: async () => assert.fail('existing type must not be created'),
    attach: async () => assert.fail('associated type must not be attached again'),
  });
  await settings.apply(c, { ...(await settings.preview(c, { type: '2' })), type: '2' });
  assert.equal(config.data.type, '2');
  f.ports.search = async () => assert.fail('cleanup must not depend on a searchable catalog');
  let loaded = await f.service.load(c);
  assert.equal(loaded.cleanupOnly, true);
  assert.deepEqual(loaded.ids, ['20', '21']);
  assert.deepEqual(
    loaded.prompts.map((p) => [p.id, p.selectedOnly]),
    [
      ['20', true],
      ['21', true],
    ],
  );
  await assert.rejects(f.service.save(c, { ...loaded, ids: ['20', '21', '22'] }), /only remove/);
  await f.service.save(c, { ...loaded, ids: ['21'] });
  loaded = await f.service.load(c);
  assert.deepEqual(loaded.ids, ['21']);
  f.ports.issue = async (id) => {
    if (id !== '10') throw new UserError('Source is unavailable');
    return read(id);
  };
  loaded = await f.service.load(c);
  assert.deepEqual(loaded.prompts, []);
  await f.service.save(c, { ...loaded, ids: [] });
  assert.deepEqual(f.target.fields.customfield_1, []);
  assert.deepEqual(f.target.fields.description, doc('Keep this'));
});

test('prompt targets without selected prompts still reject loading and forged save inputs', async () => {
  const f = fixture();
  f.target.fields.issuetype.id = '3';
  await assert.rejects(f.service.load(c), /cannot use other prompts/);
  for (const ids of [[], ['20']]) {
    await assert.rejects(
      f.service.save(c, { ids, revision: 0, fingerprint: 'unused' }),
      /only remove/,
    );
  }
  assert.equal(f.calls(), 0);
});

test('cleanup after a target becomes a prompt preserves permission and block-ownership guards', async () => {
  for (const mode of ['denied', 'modified']) {
    const f = fixture();
    await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
    f.ports.config = async () => '2';
    f.ports.retainedTypes = async () => ['3'];
    if (mode === 'modified') f.target.fields.description.content[1].attrs.resourceId = 'Changed';
    const loaded = await f.service.load(c);
    if (mode === 'denied')
      f.ports.allowed = async () => {
        throw new UserError('Missing Edit work items');
      };
    await assert.rejects(
      f.service.save(c, { ...loaded, ids: [] }),
      /Missing Edit work items|changed, moved or duplicated/,
    );
    assert.equal(f.calls(), 1);
    assert.deepEqual(f.target.fields.customfield_1, ['TEST-20']);
  }
});

test('a lost successful save is recoverable for cleanup after the target type becomes the prompt type', async () => {
  const f = fixture();
  f.loseResponse();
  await assert.rejects(
    f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] }),
    /could not be confirmed/,
  );
  f.ports.config = async () => '2';
  f.ports.retainedTypes = async () => ['3'];
  const loaded = await f.service.load(c);
  assert.equal(loaded.cleanupOnly, true);
  assert.deepEqual(loaded.ids, ['20']);
  assert.equal((await f.ports.get('10')).data.pending, undefined);
  assert.equal(f.calls(), 1);
});

test('a definite Jira rejection releases only its own claim and requires an explicit fresh save', async () => {
  const f = fixture();
  const saved = await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
  const before = await f.ports.get('10');
  const update = f.ports.update;
  let rejected = 0;
  f.ports.update = async () => {
    rejected++;
    throw new JiraRejected(
      409,
      'Jira rejected this save (HTTP 409). Review your selection and save again.',
    );
  };
  await assert.rejects(f.service.save(c, { ...saved, ids: [] }), /rejected.*Review your selection/);
  const restored = await f.ports.get('10');
  assert.deepEqual(restored.data, before.data);
  assert.equal(restored.revision, before.revision + 3);
  assert.equal(rejected, 1);
  assert.equal(f.calls(), 1);
  const loaded = await f.service.load(c);
  assert.deepEqual(loaded.ids, ['20']);
  f.ports.update = update;
  await f.service.save(c, { ...loaded, ids: [] });
  assert.equal(f.calls(), 2);
});

test('a failed rejection cleanup retains the uncertain claim without another Jira write', async () => {
  const f = fixture();
  const loaded = await f.service.load(c);
  f.ports.update = async () => {
    throw new JiraRejected(400, 'Rejected');
  };
  const cas = f.ports.cas;
  f.ports.cas = async (id, revision, data) => {
    if (revision === 2) throw Error('Storage unavailable');
    return cas(id, revision, data);
  };
  await assert.rejects(
    f.service.save(c, { ...loaded, ids: ['20'] }),
    /status could not be verified/,
  );
  assert.ok((await f.ports.get('10')).data.pending);
  await assert.rejects(f.service.load(c), /previous save could not be verified/);
  assert.equal(f.calls(), 0);
});

test('rejection cleanup cannot overwrite a later state revision', async () => {
  const f = fixture();
  const loaded = await f.service.load(c);
  const newer = { ids: ['30'], managed: null };
  f.ports.update = async () => {
    await f.ports.cas('10', 2, newer);
    throw new JiraRejected(400, 'Rejected');
  };
  await assert.rejects(
    f.service.save(c, { ...loaded, ids: ['20'] }),
    /status could not be verified/,
  );
  assert.deepEqual(await f.ports.get('10'), { revision: 3, data: newer });
});

test('ordinary failures cannot masquerade as a definite Jira rejection', async () => {
  const f = fixture();
  const loaded = await f.service.load(c);
  f.ports.update = async () => {
    throw new UserError('Jira request failed (HTTP 403)');
  };
  await assert.rejects(f.service.save(c, { ...loaded, ids: ['20'] }), /could not be confirmed/);
  assert.ok((await f.ports.get('10')).data.pending);
  assert.equal(f.calls(), 0);
});

test('unresolved source reference names the source and leaves Jira and stored links untouched', async () => {
  const f = fixture();
  f.source.fields.description = { type: 'doc', version: 1, content: [{ type: 'syncBlock' }] };
  const before = structuredClone(f.target);
  const loaded = await f.service.load(c);
  await assert.rejects(f.service.save(c, { ...loaded, ids: ['20'] }), /TEST-20: Use text/);
  assert.deepEqual(f.target, before);
  assert.equal(f.calls(), 0);
  assert.equal(await f.ports.get(), undefined);
});

test('Jira dropping empty copied attributes cannot strand save, Sync or removal', async () => {
  const f = fixture();
  f.source.fields.description.content[0].attrs = { localId: 'editor-source-id' };
  const update = f.ports.update;
  f.ports.update = async (id, fields) => {
    const normalized = JSON.parse(JSON.stringify(fields), (key, value) =>
      key === 'attrs' && !Object.keys(value).length ? undefined : value,
    );
    await update(id, normalized);
  };
  let saved = await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
  assert.deepEqual((await f.service.load(c)).ids, ['20']);
  saved = await f.service.save(c, saved);
  assert.equal(f.calls(), 1, 'unchanged refresh must not write');
  await f.service.save(c, { ...saved, ids: [] });
  assert.deepEqual(f.target.fields.description, doc('Keep this'));
  assert.equal((await f.ports.get('10')).data.pending, undefined);
});

test('initial suggestions use one ten-summary search without fetching source bodies', async () => {
  const f = fixture();
  const searches = [];
  const reads = [];
  const prompts = Array.from({ length: 10 }, (_, i) => ({
    id: String(20 + i),
    key: `TEST-${20 + i}`,
    name: `Prompt ${i}`,
  }));
  const issue = f.ports.issue;
  f.ports.issue = async (id) => {
    reads.push(id);
    return issue(id);
  };
  f.ports.search = async (project, type, query) => {
    searches.push({ project, type, query });
    return { prompts, incomplete: true };
  };
  const loaded = await f.service.load(c);
  assert.deepEqual(searches, [{ project: '1', type: '3', query: { limit: 10 } }]);
  assert.deepEqual(loaded.prompts, prompts);
  assert.deepEqual(reads, ['10']);
  await f.service.search(c, { query: '' });
  assert.deepEqual(searches[1].query, { query: '', limit: 10 });
  assert.equal(f.calls(), 0);
});
