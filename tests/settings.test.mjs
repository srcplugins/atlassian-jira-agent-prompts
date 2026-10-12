import './typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createSettings, NotApplied } = await import('../src/settings.ts');
const { UserError, JiraRejected, JiraUnavailable } = await import('../src/service.ts');
const c = { accountId: 'admin', projectId: '1' };
function fixture() {
  let stored = { revision: 1, data: { type: '3' } };
  const types = [
    { id: '3', name: 'Instructions', subtask: false, hierarchyLevel: 0 },
    { id: '4', name: 'Playbook', subtask: false, hierarchyLevel: 0 },
  ];
  const project = {
    id: '1',
    key: 'TEST',
    style: 'classic',
    projectTypeKey: 'software',
    issueTypes: structuredClone(types),
  };
  const scheme = { id: '9', name: 'TEST scheme', projectIds: ['1'], isDefault: false };
  const writes = [];
  const p = {
    allowed: async (_project, permission) => assert.equal(permission, 'ADMINISTER'),
    project: async () => structuredClone(project),
    field: async () => 'customfield_1',
    search: async () => ({
      prompts: [{ id: '20', key: 'TEST-20', name: 'Visible prompt' }],
      incomplete: false,
    }),
    issue: async () => ({ id: '10', fields: { project: { id: '1' } } }),
  };
  const s = {
    get: async () => structuredClone(stored),
    cas: async (_project, revision, data) => {
      if ((stored?.revision ?? 0) !== revision) throw new UserError('Setup changed');
      stored = { revision: revision + 1, data: structuredClone(data) };
      writes.push('config');
    },
    types: async () => structuredClone(types),
    scheme: async () => structuredClone(scheme),
    create: async (name) => {
      writes.push('create');
      types.push({ id: '5', name, subtask: false, hierarchyLevel: 0 });
      return '5';
    },
    attach: async (_scheme, type) => {
      writes.push('attach');
      project.issueTypes.push(types.find((t) => t.id === type));
    },
    impact: async () => ({ keys: ['TEST-10'], incomplete: true }),
    createFields: async () => ['summary', 'description'],
  };
  return {
    p,
    s,
    types,
    project,
    scheme,
    writes,
    settings: createSettings(p, s),
    state: () => structuredClone(stored),
    set: (value) => {
      stored = value;
    },
  };
}
test('health observes renames by stable ID and makes no writes', async () => {
  const f = fixture();
  f.types[0].name = 'Renamed';
  const health = await f.settings.health(c);
  assert.match(health.checks[0].detail, /Renamed/);
  assert.ok(health.checks.every((check) => check.ok));
  assert.deepEqual(f.writes, []);
});
test('type replacement previews bounded visible impact and retains old IDs without Jira writes', async () => {
  const f = fixture();
  const plan = await f.settings.preview(c, { type: '4' });
  assert.deepEqual(plan.promptKeys, ['TEST-20']);
  assert.deepEqual(plan.linkedKeys, ['TEST-10']);
  assert.equal(plan.linksIncomplete, true);
  await f.settings.apply(c, { type: '4', fingerprint: plan.fingerprint });
  assert.deepEqual(f.state().data, { type: '4', previousTypes: ['3'] });
  assert.deepEqual(f.writes, ['config']);
});
test('concurrent mapping applies admit one claimant and stale preview is rejected', async () => {
  const f = fixture();
  const plan = await f.settings.preview(c, { type: '4' });
  const results = await Promise.allSettled(
    [1, 2].map(() => f.settings.apply(c, { type: '4', fingerprint: plan.fingerprint })),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  await assert.rejects(
    f.settings.apply(c, { type: '4', fingerprint: plan.fingerprint }),
    /changed/,
  );
});
test('creation claims before external writes, then attaches and confirms mapping', async () => {
  const f = fixture();
  const plan = await f.settings.preview(c, { name: 'Runbook' });
  await f.settings.apply(c, { name: 'Runbook', fingerprint: plan.fingerprint });
  assert.deepEqual(f.writes, ['config', 'create', 'config', 'attach', 'config']);
  assert.deepEqual(f.state().data, { type: '5', previousTypes: ['3'] });
});
test('exclusive scheme repair retains existing type identity', async () => {
  const f = fixture();
  f.project.issueTypes = [];
  const plan = await f.settings.preview(c, { type: '3' });
  await f.settings.apply(c, { type: '3', fingerprint: plan.fingerprint });
  assert.equal(f.state().data.type, '3');
  assert.ok(!f.writes.includes('create'));
});
test('default, stale scheme and duplicate name prevent provisioning', async () => {
  for (const mode of ['default', 'duplicate', 'stale']) {
    const f = fixture();
    if (mode === 'stale') {
      const plan = await f.settings.preview(c, { name: 'New' });
      f.scheme.projectIds.push('2');
      await assert.rejects(f.settings.apply(c, { name: 'New', fingerprint: plan.fingerprint }));
    } else {
      if (mode === 'default') f.scheme.isDefault = true;
      await assert.rejects(
        f.settings.preview(c, { name: mode === 'duplicate' ? 'instructions' : 'New' }),
      );
    }
    assert.deepEqual(f.writes, []);
  }
});
test('uncertain create remains locked; outcome check is read-only and does not repeat POST', async () => {
  const f = fixture();
  f.s.create = async () => {
    f.writes.push('create');
    throw Error('lost response');
  };
  const plan = await f.settings.preview(c, { name: 'New' });
  await assert.rejects(
    f.settings.apply(c, { name: 'New', fingerprint: plan.fingerprint }),
    /uncertain/,
  );
  await assert.rejects(f.settings.preview(c, { name: 'New' }), /outcome/);
  assert.match((await f.settings.recover(c)).message, /unknown/);
  await assert.rejects(f.settings.resolve(c, f.state().revision), /two minutes/);
  assert.deepEqual(f.writes, ['config', 'create']);
  const state = f.state();
  state.data.pending.started -= 121000;
  f.set(state);
  await f.settings.resolve(c, state.revision);
  assert.equal(f.state().data.type, '3');
  assert.equal(f.state().data.pending, undefined);
});
test('deleted type can be replaced without claiming old tickets absent', async () => {
  const f = fixture();
  f.types.shift();
  const plan = await f.settings.preview(c, { type: '4' });
  assert.equal(plan.promptIncomplete, true);
  await f.settings.apply(c, { type: '4', fingerprint: plan.fingerprint });
  assert.deepEqual(f.state().data.previousTypes, ['3']);
});
test('scheme change after claiming setup stops before global type creation and releases the claim', async () => {
  const f = fixture();
  const before = structuredClone(f.state().data);
  const plan = await f.settings.preview(c, { name: 'Runbook' });
  const cas = f.s.cas;
  f.s.cas = async (...args) => {
    await cas(...args);
    f.scheme.projectIds.push('2');
  };
  await assert.rejects(
    f.settings.apply(c, { name: 'Runbook', fingerprint: plan.fingerprint }),
    (error) => {
      assert.ok(error instanceof NotApplied);
      assert.equal(error.retryable, false);
      assert.match(error.message, /before any further Jira write.*Nothing was changed/);
      return true;
    },
  );
  // Claim then release; no type was created and no scheme changed.
  assert.deepEqual(f.writes, ['config', 'config']);
  assert.deepEqual(f.state().data, before);
});

test('scheme change during attachment prevents recording successful setup', async () => {
  const f = fixture();
  f.project.issueTypes = [];
  const plan = await f.settings.preview(c, { type: '3' });
  const attach = f.s.attach;
  f.s.attach = async (...args) => {
    await attach(...args);
    f.scheme.projectIds.push('2');
  };
  await assert.rejects(
    f.settings.apply(c, { type: '3', fingerprint: plan.fingerprint }),
    /uncertain/,
  );
  assert.ok(f.state().data.pending);
  assert.deepEqual(f.writes, ['config', 'attach']);
});

test('creation checks names against ineligible type categories too', async () => {
  for (const extra of [{ subtask: true }, { scope: { type: 'PROJECT' } }, { hierarchyLevel: 1 }]) {
    const f = fixture();
    f.types.push({ id: '8', name: 'Runbook', subtask: false, hierarchyLevel: 0, ...extra });
    await assert.rejects(f.settings.preview(c, { name: 'runbook' }), /already exists/);
    assert.deepEqual(f.writes, []);
  }
});

test('another administrator must review their own setup change', async () => {
  const f = fixture();
  const plan = await f.settings.preview(c, { type: '4' });
  await assert.rejects(
    f.settings.apply(
      { ...c, accountId: 'other-admin' },
      { type: '4', fingerprint: plan.fingerprint },
    ),
    /Review/,
  );
  assert.deepEqual(f.writes, []);
});

test('all setup endpoints enforce administrator permission and the requested project before writes', async () => {
  for (const action of [
    'health',
    'preview',
    'apply',
    'recover',
    'resolve',
    'unlink',
    'preferences',
  ]) {
    const denied = fixture();
    denied.p.allowed = async () => {
      throw new UserError('denied');
    };
    await assert.rejects(denied.settings[action](c, { type: '4', fingerprint: 'bad' }), /denied/);
    assert.deepEqual(denied.writes, []);
    const other = fixture();
    other.project.id = '2';
    await assert.rejects(
      other.settings[action](c, { type: '4', fingerprint: 'bad' }),
      /Project context does not match/,
    );
    assert.deepEqual(other.writes, []);
  }
});

test('provisioning faults preserve old mapping and never retry Jira writes', async () => {
  for (const failure of [
    'claim',
    'create-response',
    'type-record',
    'attach-response',
    'readback',
    'commit',
  ]) {
    const f = fixture();
    const plan = await f.settings.preview(c, { name: 'Runbook' });
    const cas = f.s.cas;
    let claims = 0;
    f.s.cas = async (...args) => {
      claims++;
      if (
        (failure === 'claim' && claims === 1) ||
        (failure === 'type-record' && claims === 2) ||
        (failure === 'commit' && claims === 3)
      )
        throw new UserError('storage unavailable');
      await cas(...args);
    };
    const create = f.s.create;
    f.s.create = async (...args) => {
      const id = await create(...args);
      if (failure === 'create-response') throw Error('lost response');
      return id;
    };
    const attach = f.s.attach;
    f.s.attach = async (...args) => {
      await attach(...args);
      if (failure === 'attach-response') throw Error('lost response');
      if (failure === 'readback')
        f.p.project = async () => {
          throw Error('unavailable');
        };
    };
    await assert.rejects(f.settings.apply(c, { name: 'Runbook', fingerprint: plan.fingerprint }));
    assert.equal(f.state().data.type, '3', failure);
    assert.equal(!!f.state().data.pending, failure !== 'claim', failure);
    assert.ok(f.writes.filter((w) => w === 'create').length <= 1, failure);
    assert.ok(f.writes.filter((w) => w === 'attach').length <= 1, failure);
    if (failure === 'claim') assert.deepEqual(f.writes, []);
    if (['create-response', 'type-record'].includes(failure))
      assert.ok(!f.writes.includes('attach'));
  }
});

test('concurrent creation and replay create and attach at most once', async () => {
  const f = fixture();
  const plan = await f.settings.preview(c, { name: 'Runbook' });
  const input = { name: 'Runbook', fingerprint: plan.fingerprint };
  const results = await Promise.allSettled([
    f.settings.apply(c, input),
    f.settings.apply(c, input),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  await assert.rejects(f.settings.apply(c, input));
  assert.equal(f.writes.filter((w) => w === 'create').length, 1);
  assert.equal(f.writes.filter((w) => w === 'attach').length, 1);
});

test('an already-associated type on shared/default schemes changes only the app mapping', async () => {
  for (const mode of ['shared', 'default']) {
    const f = fixture();
    if (mode === 'shared') f.scheme.projectIds.push('2');
    else f.scheme.isDefault = true;
    const plan = await f.settings.preview(c, { type: '4' });
    assert.equal(plan.attach, false);
    assert.deepEqual(f.writes, []);
    await f.settings.apply(c, { type: '4', fingerprint: plan.fingerprint });
    assert.deepEqual(f.writes, ['config']);
    assert.deepEqual(f.state().data, { type: '4', previousTypes: ['3'] });
  }
});

test('loss of the final storage response is observed without repeating provisioning', async () => {
  const f = fixture();
  const plan = await f.settings.preview(c, { name: 'Runbook' });
  const cas = f.s.cas;
  f.s.cas = async (...args) => {
    await cas(...args);
    if (f.state().data.type === '5') throw Error('lost response');
  };
  await assert.rejects(
    f.settings.apply(c, { name: 'Runbook', fingerprint: plan.fingerprint }),
    /uncertain/,
  );
  const writes = [...f.writes];
  assert.match((await f.settings.recover(c)).message, /No unresolved/);
  assert.equal((await f.settings.health(c)).state.data.type, '5');
  assert.deepEqual(f.writes, writes);
});

test('ineligible configured types need replacement and cannot be selected for repair', async () => {
  for (const extra of [
    { subtask: true },
    { scope: { type: 'PROJECT' } },
    { hierarchyLevel: 1 },
    { hierarchyLevel: 2 },
    { hierarchyLevel: undefined },
  ]) {
    const f = fixture();
    Object.assign(f.types[0], extra);
    const health = await f.settings.health(c);
    assert.equal(health.checks[0].ok, false);
    assert.match(health.checks[0].detail, /replacement/);
    assert.ok(!health.types.some((type) => type.id === '3'));
    await assert.rejects(f.settings.preview(c, { type: '3' }), /standard global/);
    assert.deepEqual(f.writes, []);
  }
});

test('pending setup remains inspectable and manually resolvable when diagnostics fail', async () => {
  for (const failure of ['types', 'scheme', 'both']) {
    const f = fixture();
    f.set({
      revision: 2,
      data: {
        type: '3',
        pending: { type: '4', scheme: '9', started: Date.now() - 121000 },
      },
    });
    if (failure !== 'scheme')
      f.s.types = async () => {
        throw new UserError('Ticket type lookup failed.');
      };
    let schemeReads = 0;
    f.s.scheme = async () => {
      schemeReads++;
      if (failure !== 'types')
        throw new UserError(
          'Scheme project list is incomplete; no automatic changes are available.',
        );
      return structuredClone(f.scheme);
    };
    const health = await f.settings.health(c);
    assert.deepEqual(health.state, f.state());
    assert.equal(health.project.id, c.projectId);
    assert.equal(health.canConfigure, false);
    assert.ok(
      health.checks.some((check) => !check.ok && /could not be checked/.test(check.detail)),
    );
    if (failure !== 'types') assert.equal(health.scheme, undefined);
    if (failure !== 'scheme') {
      assert.deepEqual(health.types, []);
      assert.doesNotMatch(health.checks[0].detail, /deleted|replacement/);
    }
    const outcome = await f.settings.recover(c);
    assert.equal(schemeReads, 1, 'outcome inspection must not depend on scheme completeness');
    assert.match(
      outcome.message,
      failure === 'scheme' ? /exists and is attached/ : /outcome remains unknown/,
    );
    assert.deepEqual(f.writes, [], 'health and outcome inspection remain read-only');
    await f.settings.resolve(c, health.state.revision);
    assert.equal(f.state().data.pending, undefined);
    assert.equal(f.state().data.type, '3');
    assert.deepEqual(f.writes, ['config']);
  }
});

test('unknown creation recovery does not depend on type or scheme diagnostics', async () => {
  const f = fixture();
  f.set({
    revision: 2,
    data: {
      type: '3',
      pending: { name: 'Runbook', scheme: '9', started: Date.now() - 121000 },
    },
  });
  for (const method of ['types', 'scheme'])
    f.s[method] = async () => {
      assert.fail(`${method} is unrelated to an unknown creation outcome`);
    };
  assert.match((await f.settings.recover(c)).message, /Creation outcome is unknown/);
  assert.deepEqual(f.writes, []);
});

test('recovery does not recommend selecting a pending type that became ineligible', async () => {
  const f = fixture();
  f.set({
    revision: 2,
    data: {
      type: '3',
      pending: { type: '4', scheme: '9', started: Date.now() - 121000 },
    },
  });
  f.types[1].hierarchyLevel = 1;
  const health = await f.settings.health(c);
  assert.ok(!health.types.some((type) => type.id === '4'));
  const outcome = await f.settings.recover(c);
  assert.match(outcome.message, /no longer an eligible base-level global type/);
  assert.match(outcome.message, /choose an eligible replacement/);
  assert.doesNotMatch(outcome.message, /select this type/);
  assert.deepEqual(f.writes, []);
});

test('failed diagnostics still block previews and provisioning without making writes', async () => {
  for (const method of ['types', 'scheme']) {
    const f = fixture();
    const plan = await f.settings.preview(c, { name: 'Runbook' });
    f.s[method] = async () => {
      throw new UserError('Diagnostic unavailable');
    };
    assert.equal((await f.settings.health(c)).canConfigure, false);
    await assert.rejects(f.settings.preview(c, { name: 'Runbook' }), /Diagnostic unavailable/);
    await assert.rejects(
      f.settings.apply(c, { name: 'Runbook', fingerprint: plan.fingerprint }),
      /Diagnostic unavailable/,
    );
    assert.deepEqual(f.writes, []);
  }
});

test('reload preference is administrator-only, revision-checked and preserved by type changes', async () => {
  const f = fixture();
  await f.settings.preferences(c, { revision: 1, refreshAfterSave: true });
  assert.deepEqual(f.state().data, { type: '3', refreshAfterSave: true });
  await assert.rejects(
    f.settings.preferences(c, { revision: 1, refreshAfterSave: false }),
    /Configuration changed/,
  );
  for (const value of ['true', undefined, 1])
    await assert.rejects(
      f.settings.preferences(c, { revision: 2, refreshAfterSave: value }),
      /Invalid/,
    );
  await f.settings.apply(c, { ...(await f.settings.preview(c, { type: '4' })), type: '4' });
  assert.equal(f.state().data.refreshAfterSave, true);
  f.p.allowed = async () => {
    throw new UserError('Denied');
  };
  await assert.rejects(
    f.settings.preferences(c, { revision: f.state().revision, refreshAfterSave: false }),
    /Denied/,
  );
  assert.equal(f.state().data.refreshAfterSave, true);
});
test('reload preference does not interfere with unfinished setup', async () => {
  const f = fixture();
  f.set({ revision: 5, data: { type: '3', pending: { type: '4', scheme: '9', started: 0 } } });
  await assert.rejects(
    f.settings.preferences(c, { revision: 5, refreshAfterSave: true }),
    /unfinished/,
  );
  assert.deepEqual(f.writes, []);
});

test('direct shared scheme apply requires acknowledgment bound to unchanged reviewed membership', async () => {
  const f = fixture();
  f.scheme.projectIds.push('2');
  const plan = await f.settings.preview(c, { name: 'Shared prompt' });
  await assert.rejects(
    f.settings.apply(c, { name: 'Shared prompt', fingerprint: plan.fingerprint }),
    /Confirm the shared/,
  );
  assert.deepEqual(f.writes, []);
  await f.settings.apply(c, {
    name: 'Shared prompt',
    fingerprint: plan.fingerprint,
    allowShared: true,
  });
  assert.equal(f.state().data.type, '5');
  assert.equal(f.writes.filter((w) => w === 'attach').length, 1);
});

test('unlink clears active mapping and preferences, preserves Jira and lets retained types be reused', async () => {
  const f = fixture();
  f.set({ revision: 8, data: { type: '3', previousTypes: ['4'], refreshAfterSave: true } });
  const stale = await f.settings.preview(c, { type: '4' });
  const before = structuredClone({ types: f.types, project: f.project, scheme: f.scheme });
  await f.settings.unlink(c, 8);
  assert.deepEqual(f.state(), { revision: 9, data: { previousTypes: ['4', '3'] } });
  assert.deepEqual(f.writes, ['config']);
  assert.deepEqual({ types: f.types, project: f.project, scheme: f.scheme }, before);
  await assert.rejects(
    f.settings.apply(c, { type: '4', fingerprint: stale.fingerprint }),
    /changed/,
  );
  const review = await f.settings.preview(c, { type: '3' });
  await f.settings.apply(c, { type: '3', fingerprint: review.fingerprint });
  assert.deepEqual(f.state().data, { type: '3', previousTypes: ['4'] });
});

test('unlink rejects pending, invalid and stale requests and admits only one concurrent change', async () => {
  for (const revision of [0, -1, '1', NaN]) {
    const f = fixture();
    await assert.rejects(f.settings.unlink(c, revision), /changed/);
    assert.deepEqual(f.writes, []);
  }
  const f = fixture();
  f.set({ revision: 1, data: { type: '3', pending: { scheme: '9', started: 0 } } });
  await assert.rejects(f.settings.unlink(c, 1), /unfinished/);
  assert.deepEqual(f.writes, []);
  f.set({ revision: 1, data: { type: '3' } });
  const outcomes = await Promise.allSettled([f.settings.unlink(c, 1), f.settings.unlink(c, 1)]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.deepEqual(f.writes, ['config']);
});

test('a documented rejection of type creation releases the claim and changes nothing', async () => {
  for (const status of [400, 401, 403, 409, 429]) {
    const f = fixture();
    const before = f.state();
    f.s.create = async () => {
      f.writes.push('create');
      throw new JiraRejected(status, `Jira rejected creating the type (HTTP ${status}).`);
    };
    const plan = await f.settings.preview(c, { name: 'Runbook' });
    await assert.rejects(
      f.settings.apply(c, { name: 'Runbook', fingerprint: plan.fingerprint }),
      (error) => {
        assert.ok(error instanceof NotApplied, String(status));
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.deepEqual(f.writes, ['config', 'create', 'config']);
    assert.deepEqual(f.state().data, before.data);
    // Nothing is pending, so a new review is possible immediately.
    await f.settings.preview(c, { type: '4' });
  }
});

test('an uncertain type creation keeps the claim without a type and never repeats creation', async () => {
  for (const failure of [
    () => {
      throw new JiraUnavailable('Jira connection failed. No write was retried.');
    },
    () => {
      throw Object.assign(new UserError('Jira request failed (HTTP 500).'), { status: 500 });
    },
    () => {
      throw new UserError('Invalid Jira identifier.');
    },
  ]) {
    const f = fixture();
    f.s.create = async () => {
      f.writes.push('create');
      failure();
    };
    const plan = await f.settings.preview(c, { name: 'Runbook' });
    await assert.rejects(
      f.settings.apply(c, { name: 'Runbook', fingerprint: plan.fingerprint }),
      (error) => !(error instanceof NotApplied) && /uncertain/.test(error.message),
    );
    assert.deepEqual(f.writes, ['config', 'create']);
    assert.equal(f.state().data.pending.type, undefined);
  }
});

test('after a successful creation, scheme drift or a rejected attach stays uncertain', async () => {
  for (const after of ['drift', 'rejected']) {
    const f = fixture();
    const plan = await f.settings.preview(c, { name: 'Runbook' });
    const scheme = f.s.scheme;
    let reads = 0;
    f.s.scheme = async (...args) => {
      // Reads: apply's review, the check before creation, then the recheck before attachment.
      if (after === 'drift' && ++reads === 3) f.scheme.projectIds.push('2');
      return scheme(...args);
    };
    if (after === 'rejected')
      f.s.attach = async () => {
        f.writes.push('attach');
        throw new JiraRejected(400, 'Jira rejected adding the type.');
      };
    await assert.rejects(
      f.settings.apply(c, { name: 'Runbook', fingerprint: plan.fingerprint }),
      (error) => !(error instanceof NotApplied) && /uncertain/.test(error.message),
    );
    assert.equal(f.state().data.pending.type, '5');
    assert.equal(f.writes.filter((w) => w === 'create').length, 1);
  }
});

test('for an existing type, drift before attach or a rejected attach changes nothing; a failed attach stays uncertain', async () => {
  for (const [mode, expectNotApplied] of [
    ['drift', true],
    ['404', true],
    ['500', false],
  ]) {
    const f = fixture();
    f.types.push({ id: '6', name: 'Runbook', subtask: false, hierarchyLevel: 0 });
    const before = f.state();
    const plan = await f.settings.preview(c, { type: '6' });
    assert.equal(plan.attach, true);
    if (mode === 'drift') {
      const cas = f.s.cas;
      f.s.cas = async (...args) => {
        await cas(...args);
        f.scheme.projectIds.push('2');
        f.s.cas = cas;
      };
    } else
      f.s.attach = async () => {
        f.writes.push('attach');
        throw mode === '404'
          ? new JiraRejected(404, 'Jira rejected adding the type.')
          : new UserError('Jira request failed (HTTP 500).');
      };
    await assert.rejects(
      f.settings.apply(c, { type: '6', fingerprint: plan.fingerprint }),
      (error) => (expectNotApplied ? error instanceof NotApplied : /uncertain/.test(error.message)),
    );
    if (expectNotApplied) assert.deepEqual(f.state().data, before.data);
    else assert.ok(f.state().data.pending);
  }
});

test('a failed claim release after a rejection stays uncertain and keeps the claim', async () => {
  const f = fixture();
  const plan = await f.settings.preview(c, { name: 'Runbook' });
  f.s.create = async () => {
    throw new JiraRejected(409, 'Jira rejected creating the type (HTTP 409).');
  };
  const cas = f.s.cas;
  let calls = 0;
  f.s.cas = async (...args) => {
    if (++calls === 2) throw new UserError('Storage unavailable');
    return cas(...args);
  };
  await assert.rejects(
    f.settings.apply(c, { name: 'Runbook', fingerprint: plan.fingerprint }),
    (error) => !(error instanceof NotApplied) && /uncertain/.test(error.message),
  );
  assert.ok(f.state().data.pending);
});

test('a read failure before the claim is a retryable not-applied outcome with no writes', async () => {
  const f = fixture();
  const plan = await f.settings.preview(c, { name: 'Runbook' });
  f.s.types = async () => {
    throw new JiraUnavailable('Jira connection failed. No write was retried.');
  };
  await assert.rejects(
    f.settings.apply(c, { name: 'Runbook', fingerprint: plan.fingerprint }),
    (error) => error instanceof NotApplied && error.retryable,
  );
  assert.deepEqual(f.writes, []);
  // A validation failure is not retryable.
  const g = fixture();
  await assert.rejects(
    g.settings.apply(c, { name: 'Runbook', fingerprint: 'stale' }),
    (error) => error instanceof NotApplied && !error.retryable,
  );
});

test('twenty previous types are retained and a twenty-first replacement is blocked', async () => {
  const f = fixture();
  const previous = Array.from({ length: 19 }, (_, i) => String(100 + i));
  f.set({ revision: 1, data: { type: '3', previousTypes: previous } });
  // 19 retained + the current type = 20: allowed.
  assert.equal((await f.settings.preview(c, { type: '4' })).previousTypes.length, 20);
  f.set({ revision: 1, data: { type: '3', previousTypes: [...previous, '200'] } });
  await assert.rejects(f.settings.preview(c, { type: '4' }), /Twenty previous type mappings/);
  assert.deepEqual(f.writes, []);
});
