import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeContract } from './support/forge-contract.mjs';
const { registerResolvers, registerRovo } = await import('../src/integration.ts');

const refusal =
  'Agent Prompts for Jira has no active subscription on this site. A site administrator can subscribe in Atlassian Administration.';
// License states as the Forge runtime reports them (`forge install --license <state>` in
// development), and whether each one may use the app.
const states = [
  ['production, active', { environmentType: 'PRODUCTION', license: { active: true } }, true],
  [
    'production, trial',
    {
      environmentType: 'PRODUCTION',
      license: { active: true, isEvaluation: true, trialEndDate: '2026-11-23T00:00:00Z' },
    },
    true,
  ],
  ['production, inactive', { environmentType: 'PRODUCTION', license: { active: false } }, false],
  ['production, no license', { environmentType: 'PRODUCTION' }, false],
  ['production, null license', { environmentType: 'PRODUCTION', license: null }, false],
  ['production, empty license', { environmentType: 'PRODUCTION', license: {} }, false],
  [
    'production, deprecated isActive',
    { environmentType: 'PRODUCTION', license: { isActive: true } },
    true,
  ],
  [
    'production, active wins over isActive',
    { environmentType: 'PRODUCTION', license: { active: false, isActive: true } },
    false,
  ],
  [
    'production, string active',
    { environmentType: 'PRODUCTION', license: { active: 'true' } },
    false,
  ],
  ['unknown environment, no license', {}, false],
  ['development, no license', { environmentType: 'DEVELOPMENT' }, true],
  ['staging, no license', { environmentType: 'STAGING' }, true],
  [
    'development, --license active',
    { environmentType: 'DEVELOPMENT', license: { active: true } },
    true,
  ],
  [
    'development, --license trial',
    { environmentType: 'DEVELOPMENT', license: { active: true, isEvaluation: true } },
    true,
  ],
  [
    'development, --license inactive',
    { environmentType: 'DEVELOPMENT', license: { active: false } },
    false,
  ],
];

const context = {
  accountId: 'actor',
  extension: { project: { id: '1' }, issue: { id: '10' } },
};
const sdk = (app, stored) => {
  const contract = forgeContract();
  const storage = [];
  const calls = [];
  return {
    ...contract,
    // Jira refuses every request at once (a 4xx is never retried), so a request that gets past
    // the license check fails fast for another reason.
    api: {
      asUser: () => ({
        requestJira: async (path, options) => {
          calls.push({ path, method: options?.method ?? 'GET' });
          return { ok: false, status: 403, json: async () => ({}) };
        },
      }),
      asApp: () => assert.fail('Unexpected asApp actor'),
    },
    calls,
    storage,
    kvs: {
      entity: () => ({
        get: async (key) => {
          storage.push(key);
          return structuredClone(stored);
        },
      }),
      transact: () => assert.fail('No test here writes storage'),
    },
    fieldType: () => 'exact-field',
    appContext: () => structuredClone(app),
  };
};
const setupRun = { revision: 1, data: { id: 'x', input: { type: '3' }, entries: [] } };
const removalRun = { revision: 1, data: { id: 'x', input: { unlink: true }, entries: [] } };
// Each resolver request, and whether it needs a license. Reads, setup removal and recovery stay
// available; prompt use, configuration and preferences do not.
const requests = [
  ['setup', {}, true],
  ['search', { query: '' }, true],
  ['load', {}, true],
  ['save', { ids: [], revision: 0 }, true],
  ['save', { ids: [], revision: 0, sync: true }, true],
  ['save-status', {}, false],
  ['resolve-save', { revision: 0, fingerprint: 'x', acknowledged: true }, false],
  ['settings-projects', {}, false],
  ['settings-health', { projectId: '1' }, false],
  ['settings-recover', { projectId: '1' }, false],
  ['settings-resolve', { projectId: '1', revision: 0, acknowledged: true }, false],
  ['settings-preferences', { projectId: '1', revision: 0, refreshAfterSave: true }, true],
  ['configuration-catalog', {}, false],
  ['configuration-status', {}, false],
  ['configuration-options', { projectId: '1' }, false],
  ['configuration-preview', { projectId: '1', type: '3', reloadAfterSave: 'keep' }, true],
  ['configuration-preview', { projectId: '1', unlink: true }, false],
  [
    'configuration-start',
    {
      type: '3',
      reloadAfterSave: 'keep',
      entries: [{ projectId: '1', fingerprint: 'x' }],
      revision: 0,
    },
    true,
  ],
  [
    'configuration-start',
    { unlink: true, entries: [{ projectId: '1', fingerprint: 'x' }], revision: 0 },
    false,
  ],
  ['configuration-advance', { id: 'x', revision: 1, key: 'k' }, true, setupRun],
  ['configuration-advance', { id: 'x', revision: 1, key: 'k' }, false, removalRun],
  ['configuration-stop', { id: 'x', revision: 1, key: 'k' }, false],
];

test('every resolver request is listed, so a new resolver needs a license decision', () => {
  assert.deepEqual(
    [...new Set(requests.map(([name]) => name))].sort(),
    Object.keys(registerResolvers(sdk(states[0][1]))).sort(),
  );
});

test('without a license, prompt use and configuration are refused before any Jira or storage access', async () => {
  for (const [state, app, allowed] of states)
    for (const [name, payload, needsLicense, stored] of requests) {
      const s = sdk(app, stored);
      const result = await registerResolvers(s)[name]({ context, payload });
      const label = `${name} ${JSON.stringify(payload)} (${state})`;
      if (needsLicense && !allowed) {
        assert.deepEqual(result, { ok: false, error: refusal }, label);
        assert.equal(s.calls.length, 0, `${label} reached Jira`);
        // Only continuing a run reads the run first, to tell setup from its removal.
        assert.deepEqual(
          s.storage,
          name === 'configuration-advance' ? ['configuration-batch'] : [],
          label,
        );
      } else {
        // Past the license check, the request reaches Jira or storage (this double answers none
        // of its requests, so it then fails for another reason).
        assert.notEqual(result.error, refusal, label);
        assert.ok(s.calls.length + s.storage.length > 0, `${label} stopped before any access`);
      }
    }
});

test('a license in the request context or payload never stands in for the runtime license', async () => {
  const inactive = { environmentType: 'PRODUCTION', license: { active: false } };
  const s = sdk(inactive);
  const forged = { ...context, license: { active: true }, environmentType: 'DEVELOPMENT' };
  const { load } = registerResolvers(s);
  assert.deepEqual(await load({ context: forged, payload: {} }), { ok: false, error: refusal });
  const payload = await load({ context, payload: { license: 'active' } });
  assert.equal(payload.ok, false);
  assert.notEqual(payload.error, refusal, 'an unknown field is refused first');
  assert.equal(s.calls.length, 0);
  const rovo = await registerRovo(s)(
    { projectKey: 'TEST', query: '', license: { active: true } },
    { principal: { accountId: 'actor' }, license: { active: true } },
  );
  assert.deepEqual(rovo, { ok: false, error: refusal });
  assert.equal(s.calls.length, 0);
});

test('the Rovo action refuses an unlicensed search or read before the space lookup', async () => {
  for (const [state, app, allowed] of states)
    for (const payload of [
      { projectKey: 'TEST', query: 'review' },
      { projectKey: 'TEST', query: '', promptKey: 'TEST-1' },
    ]) {
      const s = sdk(app);
      const result = await registerRovo(s)(payload, { principal: { accountId: 'actor' } });
      const label = `${JSON.stringify(payload)} (${state})`;
      if (allowed) {
        assert.notEqual(result.error, refusal, label);
        assert.equal(s.calls[0]?.path, '/rest/api/3/project/TEST', label);
      } else {
        assert.deepEqual(result, { ok: false, error: refusal }, label);
        assert.equal(s.calls.length, 0, label);
        assert.deepEqual(s.storage, [], label);
      }
    }
  // Input is still validated first, licensed or not.
  const s = sdk({ environmentType: 'PRODUCTION' });
  const result = await registerRovo(s)(
    { projectKey: 'lower', query: '' },
    {
      principal: { accountId: 'actor' },
    },
  );
  assert.equal(result.ok, false);
  assert.notEqual(result.error, refusal);
});

test('the space inventory reports whether this installation is licensed', async () => {
  for (const [state, app, allowed] of states) {
    const s = sdk(app);
    s.api = forgeContract(
      { body: { permissions: { ADMINISTER: { havePermission: true } } } },
      {
        body: {
          startAt: 0,
          isLast: true,
          values: [{ id: '1', key: 'ONE', name: 'One', style: 'classic' }],
        },
      },
    ).api;
    const result = await registerResolvers(s)['settings-projects']({ context, payload: {} });
    assert.equal(result.ok, true, state);
    assert.equal(result.value.licensed, allowed, state);
    assert.equal(result.value.projects[0].key, 'ONE', state);
  }
});
