import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchFixture as fixture } from './batch-fixture.mjs';
const { UserError, JiraRejected, JiraUnavailable, StorageUnavailable } =
  await import('../src/service.ts');
const { createSettings } = await import('../src/settings.ts');
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
    await assert.rejects(
      f.api.preview('admin', '1', { type: '3', reloadAfterSave: 'keep' }),
      /earlier configuration/,
    );
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
  for (const [input, error] of [
    [{ unlink: true, type: '3' }, /Removing setup/],
    [{ unlink: true, reloadAfterSave: 'keep' }, /Removing setup/],
    [{ type: '3', reloadAfterSave: 'yes' }, /Invalid display preference/],
    [{ type: '3', reloadAfterSave: true }, /Invalid display preference/],
    [{ type: '3', reloadAfterSave: undefined }, /Invalid display preference/],
  ])
    for (const attempt of [
      () => f.api.preview('admin', '1', input),
      () => f.api.start('admin', input, [{ projectId: '1', fingerprint: 'a'.repeat(64) }], 0),
    ])
      await assert.rejects(attempt(), error);
  assert.equal(f.state(), undefined);
  const plan = await f.api.preview('admin', '1', { type: '3', reloadAfterSave: 'on' });
  const r = await f.api.start(
    'admin',
    { type: '3', reloadAfterSave: 'keep' },
    [{ projectId: '1', fingerprint: plan.fingerprint }],
    0,
  );
  await refused(f, r, /changed after review/);
  assert.equal(f.configs.size, 0);
});

test('a reload preference saved during a screen-only step is refused, so no added field goes unrecorded', async () => {
  const f = twoScreenFixture();
  // Set up without screens first, so the next run changes only screens and takes no claim.
  let r = await f.start({ name: 'Prompt' }, ['1']);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete', r.data.message);
  const settings = createSettings(f.p, f.s);
  const add = f.s.addScreenField;
  const saves = [];
  f.s.addScreenField = async (...args) => {
    await add(...args);
    // Another administrator saves the reload preference in View details, with the revision
    // their details view just read.
    const { revision } = f.configs.get('1');
    saves.push(
      await settings
        .preferences({ accountId: 'other', projectId: '1' }, { revision, refreshAfterSave: true })
        .then(
          () => 'saved',
          (error) => error.message,
        ),
    );
  };
  r = await f.start({ type: '5' }, ['1'], { 1: ['3'] });
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete', r.data.message);
  assert.deepEqual(saves, [
    'A configuration is changing this space right now. Save the preference after it finishes.',
    'A configuration is changing this space right now. Save the preference after it finishes.',
  ]);
  for (const screen of ['300', '301'])
    assert.deepEqual(f.screens.records.get(screen).data.projects, ['1']);
  assert.equal(f.configs.get('1').data.refreshAfterSave, undefined);
});
test('cancellation notice describes this visit rather than replaying historical completion', async () => {
  const f = fixture();
  await f.start();
  const fresh = await f.api.cancelInterrupted('admin');
  assert.equal(fresh.cancelledNow, true);
  assert.equal(f.state().cancelledNow, undefined);
  assert.equal((await f.api.cancelInterrupted('admin')).cancelledNow, false);
});

test('catalog reports a work type discovery failure without hiding saved state or blocking setup removal', async () => {
  const f = fixture();
  const r = await f.start({ type: '3' }, ['1']);
  assert.deepEqual(await f.api.catalog(), { typesAvailable: true, types: f.types });
  f.s.types = async () => {
    throw Error('Types failed');
  };
  assert.deepEqual(await f.api.catalog(), { typesAvailable: false, types: [] });
  assert.equal((await f.api.status()).data.id, r.data.id);
  await f.api.stop('admin', r.data.id, r.revision, true);
  const unlink = await f.start({ unlink: true }, ['1']);
  const result = await f.api.advance('admin', unlink.data.id, unlink.revision);
  assert.equal(result.data.status, 'complete');
  assert.deepEqual(f.writes, []);
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
  const f = twoScreenFixture();
  let r = await f.start({ name: 'Prompt' }, ['1'], { 1: ['3'] });
  const field = f.p.field;
  let reads = 0;
  f.p.field = async () => {
    // The step reviews the space once (the first read); apply reads the field again before its
    // claim, and nothing else from Jira until then.
    if (++reads === 2) throw new JiraUnavailable('Jira connection failed. No write was retried.');
    return field();
  };
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'ready');
  assert.equal(r.data.index, 0);
  assert.equal(r.data.inspectProject, undefined);
  assert.match(r.data.entries[0].message, /Nothing was changed/);
  assert.deepEqual(f.writes, []);
  f.p.field = field;
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete', r.data.message);
  assert.deepEqual(f.writes, [
    'create',
    'attach 91',
    'add 300 customfield_1',
    'add 301 customfield_1',
  ]);
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
  // Storage briefly unavailable when apply reads the space's record (the step's review read it
  // first): an outage, so the step can be continued later.
  let f = fixture();
  let r = await f.start();
  let get = f.s.get;
  let reads = 0;
  f.s.get = async (id) => {
    if (++reads === 2)
      throw new StorageUnavailable('App storage is unavailable. Try again shortly.');
    return get(id);
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
  get = f.s.get;
  reads = 0;
  f.s.get = async (id) => {
    if (++reads === 2) throw new TypeError('private defect detail');
    return get(id);
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
// Screens: each reviewed space carries its own work type selection.
function sharedScreenFixture() {
  const f = fixture();
  f.screens.use('1', '3', '*', '200');
  f.screens.use('2', '3', '*', '200');
  return f;
}
const taskScreens = { 1: ['3'], 2: ['3'] };
test('a screen shared by two reviewed spaces gets the field once and records both spaces', async () => {
  const f = sharedScreenFixture();
  let r = await f.start({ name: 'Prompt', allowSharedScreens: true }, ['1', '2'], taskScreens);
  assert.deepEqual(
    r.data.entries.map((e) => e.screenTypes),
    [['3'], ['3']],
  );
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'ready');
  // The second space's review still shows the reviewed add, now made by this run.
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete', r.data.message);
  assert.deepEqual(f.writes, ['create', 'attach 91', 'add 200 customfield_1', 'attach 92']);
  assert.deepEqual(f.screens.records.get('200').data.projects, ['1', '2']);
  assert.deepEqual(f.configs.get('1').data.screenTypes, ['3']);
  assert.deepEqual(f.configs.get('2').data.screens, ['200']);
});
test('shared screen changes need their own approval before any write', async () => {
  const f = sharedScreenFixture();
  const r = await f.start({ name: 'Prompt', allowShared: true }, ['1', '2'], taskScreens);
  await refused(f, r, /Confirm the shared screens/);
  assert.equal(f.configs.size, 0);
});
test('a screen changed in Jira after review stops the space before any write', async () => {
  const f = sharedScreenFixture();
  const r = await f.start({ name: 'Prompt', allowSharedScreens: true }, ['1', '2'], taskScreens);
  f.screens.screens.get('200').tabs[0].fields.push('customfield_1');
  await refused(f, r, /changed after review/);
});
test('one space leaving a shared screen does not stop another space joining it in the same run', async () => {
  const f = fixture();
  for (const s of ['1', '2', '7']) f.screens.use(s, '3', '*', '200');
  let r = await f.start(
    { name: 'Prompt', allowShared: true, allowSharedScreens: true },
    ['1', '7'],
    {
      1: ['3'],
      7: ['3'],
    },
  );
  r = await f.api.advance('admin', r.data.id, r.revision);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete', r.data.message);
  f.writes.length = 0;
  // Space 1 deselects Task (leave: space 7 still relies on the field); space 2 selects it (join).
  r = await f.start({ type: '5', allowSharedScreens: true }, ['1', '2'], { 1: [], 2: ['3'] });
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'ready', r.data.message);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete', r.data.message);
  assert.deepEqual(f.screens.records.get('200').data.projects, ['2', '7']);
  assert.ok(!f.writes.some((w) => w.startsWith('add') || w.startsWith('remove')), f.writes.join());
});
test('removing setup from every space sharing an app-added screen stops at the last and says why', async () => {
  const f = fixture();
  for (const s of ['1', '2']) f.screens.use(s, '3', '*', '400');
  let r = await f.start({ name: 'Prompt', allowSharedScreens: true }, ['1', '2'], taskScreens);
  while (r.data.status === 'ready') r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete', r.data.message);
  assert.deepEqual(f.screens.records.get('400').data.projects, ['1', '2']);
  f.writes.length = 0;
  // Each space was reviewed leaving screen 400 to the other one.
  r = await f.start({ unlink: true, allowSharedScreens: true }, ['1', '2']);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'ready', r.data.message);
  assert.deepEqual(f.screens.records.get('400').data.projects, ['2']);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'stopped');
  const reason =
    'PR1 stopped using Agent Prompts on the screen Screen 400 earlier in this run, so this space is now the last one relying on it and would remove the field from it. Review this space again to approve that removal.';
  assert.equal(r.data.entries[1].message, reason);
  assert.equal(
    r.data.message,
    `Nothing was changed for this space: ${reason} Completed spaces remain configured. Review the remaining spaces again.`,
  );
  assert.deepEqual(f.writes, []);
  assert.equal(f.configs.get('2').data.type, '5');
  // A new review of that space shows and approves the removal.
  r = await f.start({ unlink: true, allowSharedScreens: true }, ['2']);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete', r.data.message);
  assert.deepEqual(f.writes, ['remove 400 customfield_1']);
  assert.equal(f.screens.records.has('400'), false);
});
test('screen selections are per space: validated at start and absent for setup removal', async () => {
  const f = fixture();
  await assert.rejects(
    f.api.preview('admin', '1', { name: 'Prompt', reloadAfterSave: 'keep', screenTypes: ['x'] }),
    /Invalid Jira identifier/,
  );
  await assert.rejects(
    f.api.start(
      'admin',
      { name: 'Prompt', screenTypes: ['3'] },
      [{ projectId: '1', fingerprint: 'a'.repeat(64) }],
      0,
    ),
    /per space/,
  );
  await assert.rejects(
    f.api.start(
      'admin',
      { unlink: true },
      [{ projectId: '1', fingerprint: 'a'.repeat(64), screenTypes: ['3'] }],
      0,
    ),
    /Removing setup/,
  );
  // A space reviewed without a selection keeps its saved one.
  let r = await f.start({ name: 'Prompt' }, ['1'], { 1: ['3'] });
  await f.api.advance('admin', r.data.id, r.revision);
  assert.deepEqual(f.configs.get('1').data.screenTypes, ['3']);
  r = await f.start({ type: '5' }, ['1']);
  assert.equal(r.data.entries[0].screenTypes, undefined);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete', r.data.message);
  assert.deepEqual(f.configs.get('1').data.screenTypes, ['3']);
});
function twoScreenFixture() {
  const f = fixture();
  f.screens.use('1', '3', 'edit', '300');
  f.screens.use('1', '3', 'view', '301');
  return f;
}
/** The nth screen write fails before reaching Jira, after the earlier ones succeeded. */
function failScreenWrite(f, method, nth) {
  const write = f.s[method];
  let n = 0;
  f.s[method] = async (...a) => {
    if (++n === nth) throw new JiraUnavailable('Jira connection failed. No write was retried.');
    return write(...a);
  };
}
async function screenCheck(f) {
  const health = await createSettings(f.p, f.s).health({ accountId: 'admin', projectId: '1' });
  return health.checks.find((c) => c.label === 'Agent Prompts on screens');
}
test('a partial screen change keeps its reason, saves the selection and shows in health', async () => {
  const f = twoScreenFixture();
  let r = await f.start({ name: 'Prompt' }, ['1']);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete', r.data.message);
  failScreenWrite(f, 'addScreenField', 2);
  r = await f.start({ type: '5' }, ['1'], { 1: ['3'] });
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'attention');
  assert.match(r.data.message, /partially configured\. Screen changes stopped/);
  assert.match(r.data.entries[0].message, /^Screen changes stopped/);
  assert.deepEqual(f.configs.get('1').data.screenTypes, ['3']);
  assert.deepEqual(f.configs.get('1').data.screens, ['300']);
  const check = await screenCheck(f);
  assert.equal(check.ok, false);
  assert.match(check.detail, /missing from \S+ 301\./);
});
test('an interrupted screen removal shows the screen the app still records in health', async () => {
  const f = twoScreenFixture();
  let r = await f.start({ name: 'Prompt' }, ['1'], { 1: ['3'] });
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete', r.data.message);
  assert.equal((await screenCheck(f)).ok, true);
  failScreenWrite(f, 'removeScreenField', 2);
  r = await f.start({ type: '5' }, ['1'], { 1: [] });
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'attention');
  assert.equal(f.configs.get('1').data.screenTypes, undefined);
  assert.deepEqual(f.configs.get('1').data.screens, ['301']);
  const check = await screenCheck(f);
  assert.equal(check.ok, false);
  assert.match(check.detail, /still records adding the field to \S+ 301,/);
});
test('a screen failure after the type was attached says so and keeps the outcome check', async () => {
  const f = twoScreenFixture();
  failScreenWrite(f, 'addScreenField', 2);
  let r = await f.start({ name: 'Prompt' }, ['1'], { 1: ['3'] });
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'attention');
  assert.match(r.data.message, /work type was added to the space, but screen changes stopped/);
  assert.ok(f.configs.get('1').data.pending);
  assert.deepEqual(f.configs.get('1').data.screenTypes, ['3']);
});
/** Space 1's first step creates and attaches the type, which uses up the request, so both of its
 * screen changes are left for the next step. */
async function typeOnlyStep() {
  const f = twoScreenFixture();
  const attach = f.s.attach;
  f.s.attach = async (...args) => {
    await attach(...args);
    f.screens.clock.left = 3_500;
  };
  let r = await f.start({ name: 'Prompt' }, ['1'], { 1: ['3'] });
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'ready', r.data.message);
  assert.deepEqual(f.writes, ['create', 'attach 91']);
  assert.equal(r.data.entries[0].applied, 0);
  assert.equal(r.data.entries[0].remaining.length, 2);
  f.screens.clock.left = 22_000;
  return { f, r };
}
test('a space whose type was created by an earlier step is never reported as unchanged', async () => {
  let { f, r } = await typeOnlyStep();
  f.screens.screens.get('301').tabs[0].fields.push('customfield_1');
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'stopped');
  assert.equal(
    r.data.message,
    'No further change was made for this space: This space changed after review. Its earlier changes and completed spaces remain configured. Review the remaining spaces again.',
  );
  assert.deepEqual(f.writes, ['create', 'attach 91']);
  // The same holds when Jira refuses the next step's first screen change.
  ({ f, r } = await typeOnlyStep());
  f.s.addScreenField = async () => {
    throw new JiraRejected(400, 'Jira rejected the screen change (HTTP 400).');
  };
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'stopped');
  assert.equal(
    r.data.message,
    'Jira rejected the screen change (HTTP 400). Nothing was changed. This space’s earlier changes and completed spaces remain configured. Review the remaining spaces again.',
  );
});
/** Space 1 selects seven more work types, each with its own edit and view screen: 14 changes. */
function manyScreensFixture() {
  const f = fixture();
  const ids = Array.from({ length: 7 }, (_, i) => String(10 + i));
  for (const [i, id] of ids.entries()) {
    const type = { id, name: `Type ${id}`, subtask: false, hierarchyLevel: 0 };
    f.types.push(type);
    f.projects.get('1').issueTypes.push(type);
    f.screens.use('1', id, 'edit', String(300 + 2 * i));
    f.screens.use('1', id, 'view', String(301 + 2 * i));
  }
  // Nine seconds leave room for four screen changes after the type writes.
  f.screens.clock.left = 9_000;
  return { f, ids };
}
const added = (f) => f.writes.filter((w) => w.startsWith('add')).length;
test('a large selection is applied over several steps of the same run', async () => {
  const { f, ids } = manyScreensFixture();
  let r = await f.start({ name: 'Prompt' }, ['1', '2'], { 1: ids, 2: [] });
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'ready', r.data.message);
  assert.equal(r.data.index, 0);
  assert.equal(r.data.type, '5');
  assert.equal(r.data.entries[0].applied, 4);
  assert.equal(r.data.entries[0].remaining.length, 10);
  assert.match(r.data.entries[0].message, /^4 of 14 screen changes made\./);
  assert.deepEqual(f.writes.slice(0, 2), ['create', 'attach 91']);
  // Later steps reuse the created type and never repeat a write.
  for (const applied of [8, 12, undefined]) {
    r = await f.api.advance('admin', r.data.id, r.revision);
    assert.equal(r.data.entries[0].applied, applied, r.data.message);
  }
  assert.equal(r.data.index, 1);
  assert.equal(r.data.entries[0].status, 'done');
  assert.equal(added(f), 14);
  assert.equal(new Set(f.writes).size, f.writes.length);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete', r.data.message);
  assert.deepEqual(
    f.writes.filter((w) => !w.startsWith('add')),
    ['create', 'attach 91', 'attach 92'],
  );
  assert.equal(f.configs.get('1').data.screens.length, 14);
});
test('a screen changed in Jira between steps stops the run without further writes', async () => {
  const { f, ids } = manyScreensFixture();
  let r = await f.start({ name: 'Prompt' }, ['1'], { 1: ids });
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.entries[0].applied, 4);
  f.screens.screens.get('310').tabs[0].fields.push('customfield_1');
  const writes = [...f.writes];
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'stopped');
  assert.match(
    r.data.message,
    /^No further change was made for this space: .*changed after review/,
  );
  assert.match(r.data.message, /earlier changes and completed spaces remain configured/);
  assert.deepEqual(f.writes, writes);
});
test('an outage between steps keeps the run ready at the same progress', async () => {
  const { f, ids } = manyScreensFixture();
  let r = await f.start({ name: 'Prompt' }, ['1'], { 1: ids });
  r = await f.api.advance('admin', r.data.id, r.revision);
  const field = f.p.field;
  let reads = 0;
  f.p.field = async () => {
    // The first read is the step's review; the second is apply's, before its claim.
    if (++reads === 2) throw new JiraUnavailable('Jira connection failed. No write was retried.');
    return field();
  };
  const writes = [...f.writes];
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'ready', r.data.message);
  assert.equal(r.data.entries[0].applied, 4);
  assert.match(r.data.entries[0].message, /Nothing was changed/);
  assert.deepEqual(f.writes, writes);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.entries[0].applied, 8, r.data.message);
});
test('a large setup removal keeps the space set up until its last screen change', async () => {
  const { f, ids } = manyScreensFixture();
  f.screens.clock.left = 22_000;
  let r = await f.start({ name: 'Prompt' }, ['1'], { 1: ids });
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete', r.data.message);
  f.screens.clock.left = 9_000;
  r = await f.start({ unlink: true }, ['1']);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'ready', r.data.message);
  assert.equal(f.configs.get('1').data.type, '5');
  assert.equal(f.configs.get('1').data.screens.length, 10);
  for (let i = 0; i < 3 && r.data.status === 'ready'; i++)
    r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'complete', r.data.message);
  assert.equal(f.writes.filter((w) => w.startsWith('remove')).length, 14);
  assert.equal(f.configs.get('1').data.type, undefined);
  assert.deepEqual(f.configs.get('1').data.previousTypes, ['5']);
});
test('slow screen writes stop the step early and leave the exact unstarted changes', async () => {
  const { f, ids } = manyScreensFixture();
  f.screens.clock.left = 22_000;
  // Each Jira screen write takes five seconds, far more than the second fitted for it.
  const sentAt = [];
  for (const name of ['addScreenField', 'removeScreenField']) {
    const write = f.s[name];
    f.s[name] = async (...args) => {
      sentAt.push(f.screens.clock.left);
      await write(...args);
      f.screens.clock.left -= 5_000;
    };
  }
  const order = ids.flatMap((_, i) => [String(300 + 2 * i), String(301 + 2 * i)]);
  const left = (r) => r.data.entries[0].remaining.map((ch) => ch.screen.id);
  let r = await f.start({ name: 'Prompt' }, ['1'], { 1: ids });
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'ready', r.data.message);
  // Writes start at 22, 17, 12 and 7 seconds left; at 2 seconds the rest wait for a new step.
  assert.deepEqual(sentAt, [22_000, 17_000, 12_000, 7_000]);
  assert.equal(r.data.entries[0].applied, 4);
  assert.deepEqual(left(r), order.slice(4));
  assert.deepEqual(f.configs.get('1').data.screens, order.slice(0, 4));
  while (r.data.status === 'ready') {
    f.screens.clock.left = 22_000;
    r = await f.api.advance('admin', r.data.id, r.revision);
  }
  assert.equal(r.data.status, 'complete', r.data.message);
  assert.equal(added(f), 14);
  assert.equal(new Set(f.writes).size, f.writes.length);
  // Removal stops the same way and keeps the space set up until its last change.
  sentAt.length = 0;
  f.screens.clock.left = 22_000;
  r = await f.start({ unlink: true }, ['1']);
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'ready', r.data.message);
  assert.equal(sentAt.length, 4);
  assert.deepEqual(left(r), order.slice(4));
  assert.equal(f.configs.get('1').data.type, '5');
  assert.deepEqual(f.configs.get('1').data.screens, order.slice(4));
  while (r.data.status === 'ready') {
    f.screens.clock.left = 22_000;
    r = await f.api.advance('admin', r.data.id, r.revision);
  }
  assert.equal(r.data.status, 'complete', r.data.message);
  assert.equal(f.writes.filter((w) => w.startsWith('remove')).length, 14);
  assert.equal(f.configs.get('1').data.type, undefined);
});

test('the reload choice keeps each space’s preference or sets it for every selected space', async () => {
  // Space 1 reloads, space 2 does not, and space 7 has never chosen.
  const seed = (f) => {
    f.configs.set('1', { revision: 1, data: { type: '3', refreshAfterSave: true } });
    f.configs.set('2', { revision: 1, data: { type: '3', refreshAfterSave: false } });
    f.configs.set('7', { revision: 1, data: { type: '3' } });
  };
  for (const [choice, expected] of [
    ['keep', { 1: true, 2: false, 7: undefined }],
    ['on', { 1: true, 2: true, 7: true }],
    ['off', { 1: false, 2: false, 7: false }],
  ]) {
    const f = fixture();
    seed(f);
    let r = await f.start({ type: '3', reloadAfterSave: choice }, ['1', '2', '7']);
    assert.equal(r.data.input.reloadAfterSave, choice);
    while (r.data.status === 'ready') r = await f.api.advance('admin', r.data.id, r.revision);
    assert.equal(r.data.status, 'complete', r.data.message);
    for (const [id, value] of Object.entries(expected)) {
      assert.equal(f.configs.get(id).data.refreshAfterSave, value, `${choice}: space ${id}`);
      assert.equal(f.configs.get(id).data.type, '3');
    }
    assert.deepEqual(f.writes, []);
  }
});

/** Makes `ids` team-managed spaces with their own work types; their schemes are never read. */
function teamSpaces(f, ids) {
  for (const id of ids)
    Object.assign(f.projects.get(id), {
      style: 'next-gen',
      issueTypes: [
        { id: `${id}0`, name: 'Prompt', subtask: false, hierarchyLevel: 0 },
        { id: `${id}1`, name: 'Task', subtask: false, hierarchyLevel: 0 },
      ],
    });
  const scheme = f.s.scheme;
  f.s.scheme = async (id) => {
    assert.ok(!ids.includes(id), 'a team-managed space has no scheme to read');
    return scheme(id);
  };
}
async function finish(f, r) {
  while (r.data.status === 'ready') r = await f.api.advance('admin', r.data.id, r.revision);
  return r;
}
test('a run holds one kind of space: mixed entries are refused before any storage write', async () => {
  const f = fixture(['1', '7']);
  teamSpaces(f, ['7']);
  const entries = [
    {
      projectId: '1',
      fingerprint: (await f.api.preview('admin', '1', { name: 'Prompt', reloadAfterSave: 'keep' }))
        .fingerprint,
    },
    {
      projectId: '7',
      fingerprint: (await f.api.preview('admin', '7', { type: '70', reloadAfterSave: 'keep' }))
        .fingerprint,
      type: '70',
    },
  ];
  for (const input of [{ name: 'Prompt', reloadAfterSave: 'keep' }, { reloadAfterSave: 'keep' }])
    await assert.rejects(
      f.api.start('admin', input, entries, 0),
      /^Error: Configure company-managed and team-managed spaces separately\.$/,
    );
  assert.equal(await f.api.status(), null);
  assert.deepEqual(f.writes, []);
});
test('a company-managed space named with its own type stops the run before any Jira write', async () => {
  // Jira lists a global type on a company-managed space's scheme, so a review of it as the
  // space's "own" type passes; the run must still never take that space as team-managed.
  const f = fixture(['1']);
  f.types.push({ id: '4', name: 'Runbook', subtask: false, hierarchyLevel: 0 });
  const input = { type: '4', reloadAfterSave: 'keep' };
  const { fingerprint } = await f.api.preview('admin', '1', input);
  const r = await f.api.start(
    'admin',
    { reloadAfterSave: 'keep' },
    [{ projectId: '1', fingerprint, type: '4' }],
    0,
  );
  await refused(f, r, /A company-managed space uses the run’s prompt work type/);
  assert.equal(f.configs.has('1'), false);
});
test('an uncertain storage write for a team-managed space says nothing in Jira changed', async () => {
  const f = fixture(['7']);
  teamSpaces(f, ['7']);
  const input = { type: '70', reloadAfterSave: 'keep' };
  const { fingerprint } = await f.api.preview('admin', '7', input);
  let r = await f.api.start(
    'admin',
    { reloadAfterSave: 'keep' },
    [{ projectId: '7', fingerprint, type: '70' }],
    0,
  );
  // The storage adapter reports a failed or lost transaction as a plain UserError.
  const cas = f.s.cas;
  f.s.cas = async () => {
    f.s.cas = cas;
    throw new UserError('Configuration changed or storage is unavailable. Check the space again.');
  };
  r = await f.api.advance('admin', r.data.id, r.revision);
  assert.equal(r.data.status, 'attention');
  assert.equal(
    r.data.message,
    'This space’s saved setup may not have been updated; nothing in Jira was changed. Configuration changed or storage is unavailable. Check the space again.',
  );
  assert.doesNotMatch(r.data.message, /partially/);
  assert.deepEqual(f.writes, []);
});
test('a team-managed-only run names no type of its own and writes only app storage', async () => {
  const f = fixture(['7', '8']);
  teamSpaces(f, ['7', '8']);
  const own = (type) => ({ type, reloadAfterSave: 'on' });
  const entries = [];
  for (const [id, type] of [
    ['7', '70'],
    ['8', '81'],
  ])
    entries.push({
      projectId: id,
      fingerprint: (await f.api.preview('admin', id, own(type))).fingerprint,
      type,
    });
  await assert.rejects(
    f.api.start('admin', { type: '5', reloadAfterSave: 'on' }, entries, 0),
    /Team-managed spaces use their own work types/,
  );
  await assert.rejects(
    f.api.start('admin', { reloadAfterSave: 'on' }, [{ ...entries[0], screenTypes: ['71'] }], 0),
    /names only its own prompt work type/,
  );
  const r = await finish(f, await f.api.start('admin', { reloadAfterSave: 'on' }, entries, 0));
  assert.equal(r.data.status, 'complete');
  assert.equal(r.data.type, undefined);
  assert.deepEqual(f.configs.get('7').data, {
    type: '70',
    previousTypes: [],
    refreshAfterSave: true,
  });
  assert.equal(f.configs.get('8').data.type, '81');
  assert.deepEqual(f.writes, []);
});
test('a team-managed space whose saved entry names another type stops the run unchanged', async () => {
  const f = fixture(['7']);
  teamSpaces(f, ['7']);
  const fingerprint = (await f.api.preview('admin', '7', { type: '70', reloadAfterSave: 'keep' }))
    .fingerprint;
  const r = await f.api.start(
    'admin',
    { reloadAfterSave: 'keep' },
    [{ projectId: '7', fingerprint, type: '71' }],
    0,
  );
  await refused(f, r, /changed after review/);
  assert.equal(f.configs.has('7'), false);
});
test('a cancel landing during the final record of a configured space keeps it done and stops the run', async () => {
  const f = fixture();
  let r = await f.start({ name: 'Prompt' }, ['1', '2']);
  const id = r.data.id;
  // The administrator's other view cancels just before the step records its confirmed outcome.
  const cas = f.w.cas;
  let cancelled = false;
  f.w.cas = async (revision, data) => {
    if (!cancelled && f.state()?.data.status === 'running' && data.status !== 'running') {
      cancelled = true;
      await f.api.cancelInterrupted('admin', id);
    }
    return cas(revision, data);
  };
  r = await f.api.advance('admin', id, r.revision);
  assert.ok(cancelled);
  assert.deepEqual(f.writes, ['create', 'attach 91']);
  assert.equal(f.configs.get('1').data.type, '5');
  assert.equal(r.data.status, 'stopped');
  assert.equal(r.data.cancelRequested, true);
  assert.equal(r.data.entries[0].status, 'done');
  assert.equal(r.data.entries[1].status, 'waiting');
  assert.equal(r.data.inspectProject, undefined);
  assert.equal(r.data.type, '5');
  assert.match(r.data.message, /Interrupted configuration cancelled/);
});
