import './typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchFixture as fixture } from './batch-fixture.mjs';
const { UserError, JiraRejected, JiraUnavailable, StorageUnavailable } =
  await import('../src/service.ts');
test('configuration creates one global type for the exact reviewed spaces and can later reuse it', async () => {
  const f = fixture();
  let r = await f.start();
  assert.deepEqual(f.writes, []);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'ready');
  assert.equal(f.configs.get('1').data.type, '5');
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete');
  assert.equal(f.configs.get('2').data.type, '5');
  assert.equal(f.configs.has('7'), false);
  assert.deepEqual(f.writes, ['create', 'attach 91', 'attach 92']);
  r = await f.start({ type: '5' }, ['7']);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete');
  assert.equal(f.writes.filter((x) => x === 'create').length, 1);
});
test('configuration rejects case-insensitive name overlaps including ineligible types without writes', async () => {
  const f = fixture();
  f.types.push({ id: '9', name: 'PROMPT', hierarchyLevel: -1, subtask: true });
  await assert.rejects(f.start(), /already exists/);
  assert.deepEqual(f.writes, []);
});
function sharedFixture() {
  const f = fixture();
  const scheme = { id: '91', name: 'Shared', projectIds: ['1', '2', '7'], isDefault: false };
  for (const id of scheme.projectIds) f.schemes.set(id, scheme);
  return f;
}
// A refusal before the claim ends the batch with no writes instead of leaving it ready.
async function refused(f, r, pattern) {
  const writes = [...f.writes];
  const stopped = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(stopped.data.status, 'stopped');
  assert.match(stopped.data.message, /^Nothing was changed for this space: /);
  assert.match(stopped.data.message, pattern);
  assert.match(stopped.data.entries[stopped.data.index].message, pattern);
  assert.deepEqual(f.writes, writes);
  assert.equal((await f.api.status()).revision, stopped.revision);
  return stopped;
}
test('shared scheme changes require explicit approval before any Jira write or space claim', async () => {
  const f = sharedFixture();
  const r = await f.start();
  await refused(f, r, /Confirm the shared/);
  assert.deepEqual(f.writes, []);
  assert.equal(f.configs.size, 0);
  assert.equal(f.state().data.status, 'stopped');
});
test('shared scheme is updated once, including after response loss; only selected spaces get app setup', async () => {
  for (const existing of [false, true]) {
    const f = sharedFixture();
    if (existing) f.types.push({ id: '5', name: 'Prompt', hierarchyLevel: 0, subtask: false });
    const r = await f.start({
      ...(existing ? { type: '5' } : { name: 'Prompt' }),
      allowShared: true,
    });
    await f.api.advance('admin', r.data.id, r.revision);
    const saved = await f.api.status();
    const done = await f.api.advance('admin', saved.data.id, saved.revision);
    assert.equal(done.data.status, 'complete');
    assert.deepEqual(f.writes, existing ? ['attach 91'] : ['create', 'attach 91']);
    assert.equal(f.configs.get('1').data.type, '5');
    assert.equal(f.configs.get('2').data.type, '5');
    assert.equal(f.configs.has('7'), false);
    assert.ok(f.projects.get('7').issueTypes.some((t) => t.id === '5'));
    assert.equal(done.data.schemeEffects.length, 1);
  }
});
test('shared membership drift or removal after a committed step stops without repeating writes', async () => {
  for (const drift of ['membership', 'removal']) {
    const f = sharedFixture();
    let r = await f.start({ name: 'Prompt', allowShared: true });
    r = await f.api.advance('admin', r.data.id, r.revision);
    if (drift === 'membership') f.schemes.get('2').projectIds.push('8');
    else
      f.projects.get('2').issueTypes = f.projects.get('2').issueTypes.filter((t) => t.id !== '5');
    await refused(f, r, /shared scheme changed/);
    assert.deepEqual(f.writes, ['create', 'attach 91']);
    assert.equal(f.configs.has('2'), false);
  }
});
test('default schemes remain manual and shared membership changes invalidate the original review', async () => {
  const f = fixture();
  f.schemes.get('2').isDefault = true;
  await assert.rejects(f.start(), /default/);
  f.schemes.get('2').isDefault = false;
  const r = await f.start({ name: 'Prompt', allowShared: true });
  f.schemes.get('1').projectIds.push('7');
  await refused(f, r, /changed after review/);
  assert.deepEqual(f.writes, []);
});
test('duplicate advance calls cannot create two types; stale and foreign-actor calls do not write', async () => {
  const f = fixture();
  const r = await f.start();
  await assert.rejects(f.api.advance('other', r.data.id, r.revision), /administrator/);
  const results = await Promise.allSettled([
    f.api.advance('admin', r.data.id, r.revision),
    f.api.advance('admin', r.data.id, r.revision),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.writes.filter((x) => x === 'create').length, 1);
  await assert.rejects(f.api.advance('admin', r.data.id, r.revision), /changed/);
});
test('lost browser response recovers saved cursor without repeating creation', async () => {
  const f = fixture();
  const r = await f.start();
  await f.api.advance('admin', r.data.id, r.revision);
  const saved = await f.api.status();
  assert.equal(saved.data.index, 1);
  await f.api.advance('admin', saved.data.id, saved.revision);
  assert.equal(f.writes.filter((x) => x === 'create').length, 1);
});
test('unknown Jira creation outcome stops the run and keeps both recovery claims', async () => {
  const f = fixture();
  f.s.create = async () => {
    f.writes.push('create');
    throw Error('Response lost');
  };
  let r = await f.start();
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'attention');
  assert.ok(f.configs.get('1').data.pending);
  assert.equal(f.configs.has('2'), false);
  await assert.rejects(f.api.advance('admin', r.data.id, r.revision), /interrupted/);
  await assert.rejects(
    f.api.start(
      'admin',
      { name: 'Other' },
      [{ projectId: '2', fingerprint: 'a'.repeat(64) }],
      r.revision,
    ),
    /unfinished/,
  );
  await assert.rejects(f.api.stop('admin', r.data.id, r.revision, true), /two minutes/);
  assert.deepEqual(f.writes, ['create']);
});
test('review fingerprint prevents applying a changed setup even with a valid type', async () => {
  const f = fixture();
  let r = await f.start({ type: '3' }, ['1']);
  f.configs.set('1', { revision: 1, data: { type: '3' } });
  await refused(f, r, /changed after review/);
  assert.deepEqual(f.writes, []);
});
test('a briefly unavailable Jira before the claim keeps the run ready for Continue', async () => {
  const f = fixture();
  const r = await f.start();
  const scheme = f.s.scheme;
  f.s.scheme = async () => {
    throw Error('Jira unavailable');
  };
  await assert.rejects(f.api.advance('admin', r.data.id, r.revision));
  const saved = await f.api.status();
  assert.equal(saved.data.status, 'ready');
  assert.equal(saved.revision, r.revision);
  assert.deepEqual(f.writes, []);
  f.s.scheme = scheme;
  assert.equal((await f.api.advance('admin', r.data.id, r.revision)).data.index, 1);
});
test('global admin denial precedes inventory and all configuration mutations', async () => {
  const f = fixture();
  f.w.admin = async () => {
    throw new UserError('Denied');
  };
  for (const action of [
    () => f.api.catalog(),
    () => f.api.status(),
    () => f.start(),
    () => f.api.advance('admin', 'x', 1),
    () => f.api.stop('admin', 'x', 1, true),
  ])
    await assert.rejects(action(), /Denied/);
  assert.deepEqual(f.writes, []);
});

test('storage uncertainty after space success preserves progress or blocks without repeating Jira writes', async () => {
  for (const committed of [false, true]) {
    const f = fixture();
    const r = await f.start();
    const cas = f.w.cas;
    f.w.cas = async (revision, data) => {
      if (revision === r.revision + 1) {
        if (committed && data.status === 'ready') await cas(revision, data);
        throw Error('Storage response lost');
      }
      return cas(revision, data);
    };
    await assert.rejects(f.api.advance('admin', r.data.id, r.revision));
    assert.equal(f.configs.get('1').data.type, '5');
    const saved = await f.api.status();
    assert.equal(saved.data.status, committed ? 'ready' : 'running');
    assert.equal(saved.data.index, committed ? 1 : 0);
    f.w.cas = cas;
    if (committed) await f.api.advance('admin', saved.data.id, saved.revision);
    else await assert.rejects(f.api.advance('admin', saved.data.id, saved.revision), /interrupted/);
    assert.equal(f.writes.filter((x) => x === 'create').length, 1);
  }
});
test('a failed global claim performs no Jira writes; acknowledged stop retains completed spaces', async () => {
  const f = fixture();
  let r = await f.start();
  const cas = f.w.cas;
  f.w.cas = async () => {
    throw Error('Storage unavailable');
  };
  await assert.rejects(f.api.advance('admin', r.data.id, r.revision));
  assert.deepEqual(f.writes, []);
  f.w.cas = cas;
  r = await f.api.advance('admin', r.data.id, r.revision);
  f.s.attach = async () => {
    throw Error('Unknown association outcome');
  };
  r = await f.api.advance('admin', r.data.id, r.revision);
  f.state().data.started = Date.now() - 120001;
  await assert.rejects(f.api.stop('admin', r.data.id, r.revision, false), /acknowledge/);
  r = await f.api.stop('admin', r.data.id, r.revision, true);
  assert.equal(r.data.status, 'stopped');
  assert.equal(f.configs.get('1').data.type, '5');
  assert.ok(f.configs.get('2').data.pending);
});

test('new configuration visit cancels own interrupted ready run, retaining completed changes', async () => {
  const f = fixture();
  let r = await f.start();
  r = await f.api.advance('admin', r.data.id, r.revision);
  const before = structuredClone(f.configs.get('1'));
  const writes = [...f.writes];
  const stopped = await f.api.cancelInterrupted('admin');
  assert.equal(stopped.data.status, 'stopped');
  assert.equal(stopped.data.index, 1);
  assert.deepEqual(f.configs.get('1'), before);
  assert.deepEqual(f.writes, writes);
  await assert.rejects(f.api.advance('admin', r.data.id, r.revision), /changed/);
  assert.equal((await f.api.cancelInterrupted('admin')).revision, stopped.revision);
  assert.equal((await f.start({ type: '5' }, ['2'])).data.status, 'ready');
});

test('cancellation waits for in-flight space commit, then prevents the next space', async () => {
  const f = fixture();
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const create = f.s.create;
  f.s.create = async (name) => {
    entered();
    await wait;
    return create(name);
  };
  const r = await f.start();
  const advancing = f.api.advance('admin', r.data.id, r.revision);
  await started;
  const cancelling = await f.api.cancelInterrupted('admin');
  assert.equal(cancelling.data.status, 'running');
  assert.equal(cancelling.data.cancelRequested, true);
  assert.equal((await f.api.cancelInterrupted('admin')).revision, cancelling.revision);
  release();
  const stopped = await advancing;
  assert.equal(stopped.data.status, 'stopped');
  assert.equal(stopped.data.index, 1);
  assert.equal(stopped.data.inspectProject, undefined);
  assert.equal(f.configs.get('1').data.type, '5');
  assert.equal(f.configs.has('2'), false);
  await assert.rejects(f.api.advance('admin', stopped.data.id, stopped.revision), /interrupted/);
});

test('expired running and uncertain attempts cancel without clearing space safety claims or retrying writes', async () => {
  for (const status of ['running', 'attention']) {
    const f = fixture();
    f.s.create = async () => {
      f.writes.push('create');
      throw Error('Unknown result');
    };
    const r = await f.start();
    await f.api.advance('admin', r.data.id, r.revision);
    const pending = structuredClone(f.configs.get('1'));
    f.state().data.status = status;
    f.state().data.started = Date.now() - 121000;
    const stopped = await f.api.cancelInterrupted('admin');
    assert.equal(stopped.data.status, 'stopped');
    assert.equal(stopped.data.inspectProject, '1');
    assert.deepEqual(f.configs.get('1'), pending);
    assert.deepEqual(f.writes, ['create']);
    await assert.rejects(f.api.preview('admin', '1', { type: '3' }), /earlier configuration/);
    assert.equal((await f.start({ type: '3' }, ['2'])).data.status, 'ready');
  }
});

test('opening another administrator’s page cannot cancel their run; denied admins cannot cancel', async () => {
  const f = fixture();
  const r = await f.start();
  assert.equal((await f.api.cancelInterrupted('other')).revision, r.revision);
  assert.equal(f.state().data.status, 'ready');
  f.w.admin = async () => {
    throw new UserError('Denied');
  };
  await assert.rejects(f.api.cancelInterrupted('admin'), /Denied/);
});

test('a late callback cannot overwrite an expired cancelled run or a new run', async () => {
  const f = fixture();
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  f.s.create = async () => {
    entered();
    await wait;
    throw Error('Late failure');
  };
  const r = await f.start();
  const advancing = f.api.advance('admin', r.data.id, r.revision);
  await started;
  f.state().data.started = Date.now() - 121000;
  await f.api.cancelInterrupted('admin');
  const newer = await f.start({ type: '3' }, ['2']);
  release();
  await assert.rejects(advancing, /progress changed/);
  assert.equal(f.state().data.id, newer.data.id);
  assert.equal(f.state().data.status, 'ready');
  assert.ok(f.configs.get('1').data.pending);
});
test('interrupted cancellation reconciles a lost metadata response without repeating writes', async () => {
  const f = fixture();
  await f.start();
  const cas = f.w.cas;
  let calls = 0;
  f.w.cas = async (...args) => {
    calls++;
    await cas(...args);
    throw Error('Response lost');
  };
  const cancelled = await f.api.cancelInterrupted('admin');
  assert.equal(cancelled.data.status, 'stopped');
  assert.equal(calls, 1);
  assert.deepEqual(f.writes, []);
});
test('interrupted cancellation never cancels a replacement run after a conflict', async () => {
  const f = fixture();
  await f.start();
  f.w.cas = async () => {
    f.state().revision++;
    f.state().data.id = 'replacement';
    throw Error('Conflict');
  };
  const current = await f.api.cancelInterrupted('admin');
  assert.equal(current.data.id, 'replacement');
  assert.equal(current.data.status, 'ready');
  assert.equal(current.data.cancelRequested, undefined);
  assert.deepEqual(f.writes, []);
});

test('interrupted bulk setup removal retains completed removals and leaves remaining spaces configured', async () => {
  const f = fixture();
  for (const id of ['1', '2'])
    f.configs.set(id, { revision: 1, data: { type: '3', refreshAfterSave: true } });
  const start = await f.start({ unlink: true });
  await f.api.advance('admin', start.data.id, start.revision);
  await f.api.cancelInterrupted('admin');
  assert.deepEqual(f.configs.get('1').data, { previousTypes: ['3'] });
  assert.equal(f.configs.get('2').data.type, '3');
  assert.equal(f.state().data.status, 'stopped');
  assert.deepEqual(f.writes, []);
});

test('bulk options reject invalid combinations and changed preferences invalidate review', async () => {
  const f = fixture();
  for (const input of [
    { unlink: true, type: '3' },
    { unlink: true, refreshAfterSave: true },
    { type: '3', refreshAfterSave: 'yes' },
  ])
    await assert.rejects(f.start(input));
  const plan = await f.api.preview('admin', '1', { type: '3', refreshAfterSave: true });
  const r = await f.api.start(
    'admin',
    { type: '3', refreshAfterSave: false },
    [{ projectId: '1', fingerprint: plan.fingerprint }],
    0,
  );
  await refused(f, r, /changed after review/);
  assert.equal(f.configs.size, 0);
});

test('cancellation notice describes this visit rather than replaying historical completion', async () => {
  const f = fixture();
  await f.start();
  const fresh = await f.api.cancelInterrupted('admin');
  assert.equal(fresh.cancelledNow, true);
  assert.equal(f.state().cancelledNow, undefined);
  assert.equal((await f.api.cancelInterrupted('admin')).cancelledNow, false);
});

test('catalog reports independent discovery failures without hiding saved state or blocking setup removal', async () => {
  for (const failure of ['types', 'inventory', 'both']) {
    const f = fixture();
    const r = await f.start({ type: '3' }, ['1']);
    if (failure !== 'inventory')
      f.s.types = async () => {
        throw Error('Types failed');
      };
    if (failure !== 'types')
      f.w.projects = async () => {
        throw Error('Inventory failed');
      };
    const catalog = await f.api.catalog();
    assert.equal(catalog.typesAvailable, failure === 'inventory');
    assert.equal(catalog.inventoryAvailable, failure === 'types');
    assert.equal((await f.api.status()).data.id, r.data.id);
    await f.api.stop('admin', r.data.id, r.revision, true);
    const unlink = await f.start({ unlink: true }, ['1']);
    const result = await f.api.advance('admin', unlink.data.id, unlink.revision);
    assert.equal(result.data.status, 'complete');
    assert.deepEqual(f.writes, []);
  }
});

test('stale abandoned-run release cannot overwrite a competing continuation', async () => {
  const f = fixture();
  const before = await f.start();
  const after = await f.api.advance('admin', before.data.id, before.revision);
  await assert.rejects(
    f.api.stop('admin', before.data.id, before.revision, true),
    /progress changed/,
  );
  assert.equal(f.state().data.status, 'ready');
  assert.equal(f.state().data.index, 1);
  assert.equal(f.state().revision, after.revision);
  assert.deepEqual(f.writes, ['create', 'attach 91']);
});

test('a brief outage before any write returns the run to ready at the same space', async () => {
  const f = fixture();
  let r = await f.start();
  const types = f.s.types;
  let reads = 0;
  f.s.types = async () => {
    // The first read is advance's fresh review; the second is apply's own review.
    if (++reads === 2) throw new JiraUnavailable('Jira connection failed. No write was retried.');
    return types();
  };
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'ready');
  assert.equal(r.data.index, 0);
  assert.equal(r.data.inspectProject, undefined);
  assert.match(r.data.entries[0].message, /Nothing was changed/);
  assert.deepEqual(f.writes, []);
  f.s.types = types;
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.index, 1);
  assert.deepEqual(f.writes, ['create', 'attach 91']);
});

test('a rejected creation stops the run without an outcome check and never creates again', async () => {
  const f = fixture();
  let r = await f.start();
  f.s.create = async () => {
    f.writes.push('create');
    throw new JiraRejected(409, 'Jira rejected creating the type (HTTP 409).');
  };
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'stopped');
  assert.equal(r.data.inspectProject, undefined);
  assert.match(r.data.message, /HTTP 409.*Nothing was changed.*Review the remaining spaces/);
  assert.equal(f.configs.get('1')?.data.pending, undefined);
  assert.deepEqual(f.writes, ['create']);
  // The run has ended on its own; a new review can start.
  await f.start({ name: 'Other' }, ['1']);
});

test('a not-applied outcome during cancellation keeps its reason and needs no outcome check', async () => {
  const f = fixture();
  let r = await f.start();
  f.s.create = async () => {
    // The owner opens Project configuration in another tab while the step runs.
    await f.api.cancelInterrupted('admin');
    throw new JiraRejected(403, 'Jira rejected creating the type (HTTP 403).');
  };
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'stopped');
  assert.equal(r.data.inspectProject, undefined);
  assert.match(r.data.message, /HTTP 403/);
});

test('a later space proceeds when Jira stores the created type under a normalized name', async () => {
  const f = fixture();
  let r = await f.start({ name: 'Prompt' }, ['1', '2']);
  const create = f.s.create;
  f.s.create = async (name) => {
    const id = await create(name);
    f.types.find((t) => t.id === id).name = 'PROMPT';
    return id;
  };
  r = await f.api.advance('admin', r.data.id, r.revision);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete');
  assert.equal(f.writes.filter((w) => w === 'create').length, 1);
});

test('releasing another administrator’s ready run needs acknowledgement; the owner’s does not', async () => {
  const f = fixture();
  let r = await f.start();
  await assert.rejects(f.api.stop('other-admin', r.data.id, r.revision, false), /Acknowledge/);
  assert.equal(f.state().data.status, 'ready');
  r = await f.api.stop('other-admin', r.data.id, r.revision, true);
  assert.equal(r.data.status, 'stopped');
  assert.match(r.data.message, /^Configuration released/);
  const g = fixture();
  const own = await g.start();
  assert.equal(
    (await g.api.stop('admin', own.data.id, own.revision, false)).data.status,
    'stopped',
  );
});

test('a storage outage before any write keeps the run ready; a defect stops it honestly', async () => {
  // Storage briefly unavailable during apply's own review: an outage, so the step can be
  // continued later.
  let f = fixture();
  let r = await f.start();
  const types = f.s.types;
  let reads = 0;
  f.s.types = async () => {
    if (++reads === 2)
      throw new StorageUnavailable('App storage is unavailable. Try again shortly.');
    return types();
  };
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'ready');
  assert.equal(r.data.index, 0);
  assert.equal(
    r.data.entries[0].message,
    'App storage is unavailable. Try again shortly. Nothing was changed.',
  );
  assert.deepEqual(f.writes, []);

  // A defect in the same place is not an outage: repeating it would fail the same way, so the
  // batch stops with a message that says so, and still writes nothing.
  f = fixture();
  r = await f.start();
  reads = 0;
  f.s.types = async () => {
    if (++reads === 2) throw new TypeError('private defect detail');
    return f.types;
  };
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'stopped');
  assert.equal(
    r.data.entries[0].message,
    'An unexpected error stopped this step. Nothing was changed.',
  );
  assert.doesNotMatch(JSON.stringify(r.data), /private defect detail|could not be read/);
  assert.deepEqual(f.writes, []);
});

test('a polling view that names an older run never cancels a newer one', async () => {
  const f = fixture();
  const old = await f.start();
  const stopped = await f.api.cancelInterrupted('admin');
  assert.equal(stopped.data.status, 'stopped');
  const next = await f.start({ type: '3' }, ['2']);
  const polled = await f.api.cancelInterrupted('admin', old.data.id);
  assert.equal(polled.data.id, next.data.id);
  assert.equal(polled.data.status, 'ready');
  assert.equal(polled.cancelledNow, false);
  assert.equal(f.state().revision, next.revision);
});
