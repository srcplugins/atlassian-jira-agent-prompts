import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createService, JiraRejected, UserError, limited } = await import('../src/service.ts');
const { JiraHttpError } = await import('../src/shared/jira.mjs');
const { sourceContent } = await import('../src/prompt-text.ts');
const { createSettings } = await import('../src/settings.ts');
const { screenFixture } = await import('./screen-fixture.mjs');
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
test('only a stale selection stops a save; description edits and a changed section do not', async () => {
  for (const mode of ['stale', 'edited', 'managed', 'moved']) {
    const f = fixture();
    let loaded = await f.service.load(c);
    if (mode === 'stale') {
      await f.service.save(c, { ...loaded, ids: ['20'] });
      await assert.rejects(f.service.save(c, { ...loaded, ids: [] }), /work item changed/);
      assert.equal(f.calls(), 1);
      continue;
    }
    if (mode === 'edited') {
      f.target.fields.description.content.push(doc('Typed while the field was open').content[0]);
      f.target.fields.updated = '2';
    }
    if (mode === 'moved') f.source.fields.project.id = '2';
    if (mode === 'managed') {
      await f.service.save(c, { ...loaded, ids: ['20'] });
      f.target.fields.description.content[1].attrs.resourceId = 'Manual edit';
      f.target.fields.description.content[1].content.push(doc('Typed inside').content[0]);
      loaded = await f.service.load(c);
    }
    const saved = await f.service.save(c, { ...loaded, ids: ['20'] });
    const text = JSON.stringify(f.target.fields.description);
    if (mode === 'moved') {
      assert.deepEqual(saved.dropped, ['TEST-20']);
      assert.deepEqual(f.target.fields.customfield_1 ?? [], []);
      assert.doesNotMatch(text, /agent-prompts-10/);
      continue;
    }
    assert.deepEqual(f.target.fields.customfield_1, ['TEST-20']);
    assert.doesNotMatch(text, /Manual edit|Typed inside/);
    assert.match(text, /Check errors/);
    if (mode === 'edited') assert.match(text, /Typed while the field was open/);
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
test('a Sync that a concurrent reader settled first is reported as a success', async () => {
  const f = fixture();
  await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
  f.source.fields.description = sourceDoc('Updated instructions');
  // Another viewer opens the field right after the Sync lands in Jira, before the saver settles.
  const update = f.ports.update;
  f.ports.update = async (...args) => {
    f.ports.update = update;
    await update(...args);
    await f.service.load({ ...c, accountId: 'viewer' });
  };
  const loaded = await f.service.load(c);
  const synced = await f.service.save(c, { ...loaded, ids: ['20'] });
  assert.match(JSON.stringify(f.target.fields.description), /Updated instructions/);
  const stored = await f.ports.get('10');
  assert.equal(stored.data.pending, undefined);
  assert.deepEqual(stored.data.ids, ['20']);
  // The reply carries the record's revision, so the next save is not refused as stale.
  assert.equal(synced.revision, stored.revision);
  const next = await f.service.load(c);
  assert.equal(next.revision, synced.revision);
  assert.equal(next.fingerprint, synced.fingerprint);
});
test('a lost settle race against a different record still fails', async () => {
  const f = fixture();
  await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
  f.source.fields.description = sourceDoc('Updated instructions');
  // Storage moves on to an unrelated record between the Jira write and the saver's settle.
  const cas = f.ports.cas;
  let writes = 0;
  f.ports.cas = async (id, revision, data) => {
    if (++writes === 3) {
      await cas(id, revision, { ids: [], managed: null });
      throw Error('conflict');
    }
    return cas(id, revision, data);
  };
  const loaded = await f.service.load(c);
  await assert.rejects(f.service.save(c, { ...loaded, ids: ['20'] }), /conflict/);
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
  // Chosen again, a prompt of the previous type is no longer a prompt: it is dropped.
  assert.deepEqual((await f.service.save(c, { ...current, ids: ['20'] })).dropped, ['TEST-20']);
  assert.deepEqual(f.target.fields.customfield_1, []);
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

test('a retired selected prompt stays selected with its label, and Sync still copies it', async () => {
  const f = fixture();
  await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
  // Search leaves out prompts in a Done-category status, so load reads the selection by ID.
  f.ports.search = async () => ({ prompts: [], incomplete: false });
  for (const key of ['new', 'indeterminate', undefined]) {
    f.source.fields.status = key ? { statusCategory: { key } } : undefined;
    assert.deepEqual(
      (await f.service.load(c)).prompts,
      [{ id: '20', key: 'TEST-20', name: 'Review' }],
      String(key),
    );
  }
  f.source.fields.status = { id: '10001', statusCategory: { key: 'done' } };
  let loaded = await f.service.load(c);
  assert.deepEqual(loaded.prompts, [
    { id: '20', key: 'TEST-20', name: 'Review (retired)', selectedOnly: true },
  ]);
  f.source.fields.description = sourceDoc('Check errors twice');
  f.source.fields.updated = '2';
  const writes = f.calls();
  await f.service.save(c, loaded);
  assert.equal(f.calls(), writes + 1);
  assert.match(JSON.stringify(f.target.fields.description), /Check errors twice/);
  // A prompt of a previous type is labelled by its type alone, retired or not.
  f.ports.config = async () => '4';
  f.ports.retainedTypes = async () => ['3'];
  loaded = await f.service.load(c);
  assert.deepEqual(loaded.prompts, [
    { id: '20', key: 'TEST-20', name: 'Review (previous type)', selectedOnly: true },
  ]);
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
    create: async () => assert.fail('existing type must not be created'),
    attach: async () => assert.fail('associated type must not be attached again'),
    ...screenFixture(() => ['1']).ports,
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

test('cleanup after a target becomes a prompt needs Edit work items and rewrites a changed section', async () => {
  for (const mode of ['denied', 'modified']) {
    const f = fixture();
    await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
    f.ports.config = async () => '2';
    f.ports.retainedTypes = async () => ['3'];
    if (mode === 'modified') f.target.fields.description.content[1].attrs.resourceId = 'Changed';
    const loaded = await f.service.load(c);
    if (mode === 'denied') {
      f.ports.allowed = async () => {
        throw new UserError('Missing Edit work items');
      };
      await assert.rejects(f.service.save(c, { ...loaded, ids: [] }), /Missing Edit work items/);
      assert.equal(f.calls(), 1);
      assert.deepEqual(f.target.fields.customfield_1, ['TEST-20']);
    } else {
      await f.service.save(c, { ...loaded, ids: [] });
      assert.equal(f.calls(), 2);
      assert.deepEqual(f.target.fields.customfield_1, []);
      assert.deepEqual(f.target.fields.description, doc('Keep this'));
    }
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
test('limited runs at most four reads at once and keeps their order', async () => {
  let running = 0;
  let most = 0;
  const out = await limited([5, 1, 4, 2, 3, 0, 6], async (ms) => {
    most = Math.max(most, ++running);
    await new Promise((resolve) => setTimeout(resolve, ms));
    running--;
    return ms * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30, 0, 60]);
  assert.equal(most, 4);
  assert.deepEqual(await limited([], async () => 1), []);
});
test('the Space settings page opens in company-managed and team-managed Software spaces only', async () => {
  const f = fixture();
  for (const [style, projectTypeKey, ok] of [
    ['classic', 'software', true],
    ['next-gen', 'software', true],
    ['next-gen', 'business', false],
  ]) {
    f.ports.project = async () => ({ id: '1', key: 'TEST', style, projectTypeKey, issueTypes: [] });
    const service = createService(f.ports);
    // The page needs only the space; it reads no prompt type or other setup.
    if (ok) assert.deepEqual(Object.keys(await service.setup(c)), ['project']);
    else await assert.rejects(service.setup(c), /^Error: Jira software spaces only\.$/);
  }
});

test('Save and Sync drop prompts that are gone and stop only for one the user may not see', async () => {
  const f = fixture();
  const prompt = (id, extra = {}) => {
    const p = structuredClone(f.source);
    Object.assign(p, { id, key: `TEST-${id}` });
    Object.assign(
      p.fields,
      { summary: `Prompt ${id}`, description: sourceDoc(`Text ${id}`) },
      extra,
    );
    return p;
  };
  const prompts = { 20: f.source, 21: prompt('21'), 22: prompt('22'), 23: prompt('23') };
  f.ports.issue = async (id) => {
    if (id === '10') return structuredClone(f.target);
    if (!prompts[id]) throw new JiraHttpError(404);
    return structuredClone(prompts[id]);
  };
  // 23 has an issue security level when it is copied.
  prompts[23].fields.security = { id: '10100' };
  await f.service.save(c, { ...(await f.service.load(c)), ids: ['20', '21', '22', '23'] });
  assert.deepEqual(f.target.fields.customfield_1, ['TEST-20', 'TEST-21', 'TEST-22', 'TEST-23']);
  // Jira now finds neither 21 (deleted) nor 23 (it has a security level the user isn't in): the
  // user may not see 23, so nothing is written, and the message names it.
  delete prompts[21];
  delete prompts[23];
  const before = structuredClone(f.target.fields);
  const calls = f.calls();
  await assert.rejects(f.service.save(c, { sync: true }), {
    name: 'Error',
    message:
      "Nothing was synced: you can't see TEST-23 in Jira. A Jira administrator manages who can see it.",
  });
  assert.equal(f.calls(), calls);
  assert.deepEqual(f.target.fields, before);
  // Without 23, Sync drops 21 and moves on; 22 moved to another space and is dropped too.
  const loaded = await f.service.load(c);
  await f.service.save(c, { ids: ['20', '21', '22'], revision: loaded.revision });
  prompts[22].fields.project = { id: '2' };
  prompts[22].key = 'OTHER-1';
  prompts[20].fields.description = sourceDoc('Check errors again');
  const synced = await f.service.save(c, { sync: true });
  assert.deepEqual(synced.ids, ['20']);
  assert.deepEqual(synced.dropped, ['TEST-22']);
  assert.deepEqual(f.target.fields.customfield_1, ['TEST-20']);
  const section = f.target.fields.description.content.at(-1);
  assert.match(JSON.stringify(section), /Check errors again/);
  assert.doesNotMatch(JSON.stringify(section), /Text 2[123]/);
  // Every prompt gone: the section is removed and the field cleared.
  delete prompts[20];
  const emptied = await f.service.save(c, { sync: true });
  assert.deepEqual(emptied, { revision: emptied.revision, ids: [], dropped: ['TEST-20'] });
  assert.deepEqual(f.target.fields.description, doc('Keep this'));
  assert.deepEqual(f.target.fields.customfield_1, []);
  assert.deepEqual((await f.service.load(c)).ids, []);
});
test('Sync writes the saved prompts whatever the client last saw', async () => {
  const f = fixture();
  await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
  // Another tab removed the prompts, and someone edited the description since.
  await f.service.save(c, { ids: [], revision: (await f.service.load(c)).revision });
  f.target.fields.description.content.unshift(doc('Added in Jira').content[0]);
  f.target.fields.updated = '9';
  const synced = await f.service.save(c, { sync: true });
  assert.deepEqual(synced.ids, []);
  assert.deepEqual(
    f.target.fields.description.content.map((n) => n.content[0].text),
    ['Added in Jira', 'Keep this'],
  );
});
test('a field value written outside the app is replaced by the saved selection on Sync and by the chosen one on Save', async () => {
  // Jira's own field editors (bulk edit, the list view, REST) write the field without the app
  // (agent-prompts#ee9j): the field then holds keys the app never saved, and the section is stale.
  const f = fixture();
  await f.service.save(c, { ...(await f.service.load(c)), ids: ['20'] });
  const linked = structuredClone(f.target.fields.description);
  f.target.fields.customfield_1 = ['TEST-20', 'TEST-99', 'NOT A KEY'];
  f.target.fields.updated = '9';
  // The field opens on the selection the app saved, not on the value Jira holds.
  const loaded = await f.service.load(c);
  assert.deepEqual(loaded.ids, ['20']);
  const writes = f.calls();
  const synced = await f.service.save(c, { sync: true });
  assert.deepEqual(synced.ids, ['20']);
  assert.equal(f.calls(), writes + 1);
  assert.deepEqual(f.target.fields.customfield_1, ['TEST-20']);
  assert.deepEqual(f.target.fields.description, linked);
  // Removing every prompt clears the field, whatever was written there meanwhile.
  f.target.fields.customfield_1 = ['TEST-99'];
  await f.service.save(c, { ids: [], revision: (await f.service.load(c)).revision });
  assert.deepEqual(f.target.fields.customfield_1, []);
  assert.deepEqual(f.target.fields.description, doc('Keep this'));
});
