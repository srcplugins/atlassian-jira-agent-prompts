import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lifecycleOptions,
  verifyLifecycleActors,
  verifyConfigurationPlan,
} from './hosted/support/native-lifecycle.mjs';
const site = 'second-example.atlassian.net';
const env = {
  NATIVE_LIFECYCLE_TESTS: '1',
  JIRA_SITE: site,
  PLUGIN_TEST_SITE: site,
  PLUGIN_TEST_ENVIRONMENT: 'production',
};
test('lifecycle refuses wrong tenant, environment, missing opt-in and ambiguous cleanup', () => {
  assert.deepEqual(lifecycleOptions(['production'], env, site), {
    mode: 'production',
    runId: undefined,
  });
  for (const key of Object.keys(env))
    assert.throws(() => lifecycleOptions(['production'], { ...env, [key]: 'wrong' }, site));
  for (const args of [
    [],
    ['production', 'extra'],
    ['cleanup'],
    ['cleanup', '../other'],
    ['reinstall'],
    ['cleanup', '11111111-1111-1111-1111-111111111111', 'extra'],
  ])
    assert.throws(() => lifecycleOptions(args, env, site));
  assert.equal(
    lifecycleOptions(['cleanup', '11111111-1111-1111-1111-111111111111'], env, site).mode,
    'cleanup',
  );
});
test('lifecycle requires exact distinct actors and independent ordinary-user denial', () => {
  const expected = { owner: 'owner-id', 'nc-admin': 'admin-id', 'nc-user': 'user-id' };
  const observed = Object.fromEntries(
    Object.entries(expected).map(([role, accountId]) => [
      role,
      {
        accountId,
        permissions: {
          ADMINISTER: role !== 'nc-user',
          BROWSE_PROJECTS: true,
          CREATE_ISSUES: true,
          EDIT_ISSUES: true,
        },
      },
    ]),
  );
  verifyLifecycleActors(expected, observed);
  for (const role of Object.keys(expected)) {
    const bad = structuredClone(observed);
    bad[role].accountId = 'someone-else';
    assert.throws(() => verifyLifecycleActors(expected, bad));
  }
  const bad = structuredClone(observed);
  bad['nc-user'].permissions.ADMINISTER = true;
  assert.throws(() => verifyLifecycleActors(expected, bad));
  assert.throws(() => verifyLifecycleActors({ ...expected, 'nc-user': expected.owner }, observed));
});
test('configuration refuses scheme modifications and cross-project plans', () => {
  const plan = { project: { id: '12' }, type: '34', attach: false };
  verifyConfigurationPlan(plan, '12', '34');
  for (const bad of [
    { ...plan, attach: true },
    { ...plan, project: { id: '99' } },
    { ...plan, type: '56' },
  ])
    assert.throws(() => verifyConfigurationPlan(bad, '12', '34'));
});
test('reinstall phases are restricted to development and exact recovery journals', () => {
  const dev = { ...env, PLUGIN_TEST_ENVIRONMENT: 'development' };
  const id = '11111111-1111-1111-1111-111111111111';
  for (const args of [
    ['reinstall-prepare'],
    ['reinstall-verify', id],
    ['upgrade-prepare'],
    ['upgrade-verify', id],
  ]) {
    assert.equal(lifecycleOptions(args, dev, site).mode, args[0]);
    assert.throws(() => lifecycleOptions(args, env, site));
  }
  assert.throws(() => lifecycleOptions(['production'], dev, site));
  assert.throws(() => lifecycleOptions(['reinstall-verify'], dev, site));
  assert.throws(() => lifecycleOptions(['reinstall-prepare', id], dev, site));
  assert.equal(lifecycleOptions(['cleanup', id], dev, site).runId, id);
});
test('tenant isolation requires both owned hosts, secondary fixtures and a separate peer journal', () => {
  const primary = 'primary.example';
  const id = '11111111-1111-1111-1111-111111111111';
  const isolation = {
    ...env,
    NATIVE_TENANT_ISOLATION: '1',
    NATIVE_LIFECYCLE_PROJECT: 'secondary',
    PLUGIN_TEST_ENVIRONMENT: 'development',
  };
  for (const host of [site, primary]) {
    const selected = { ...isolation, JIRA_SITE: host, PLUGIN_TEST_SITE: host };
    assert.equal(
      lifecycleOptions(['isolation-prepare'], selected, site, primary).mode,
      'isolation-prepare',
    );
    assert.deepEqual(lifecycleOptions(['isolation-probe', id], selected, site, primary), {
      mode: 'isolation-probe',
      runId: undefined,
      peerRunId: id,
    });
    for (const change of [
      { NATIVE_TENANT_ISOLATION: undefined },
      { NATIVE_LIFECYCLE_PROJECT: undefined },
      { PLUGIN_TEST_ENVIRONMENT: 'production' },
      { PLUGIN_TEST_SITE: 'foreign.example' },
      { JIRA_SITE: 'foreign.example' },
    ])
      assert.throws(() =>
        lifecycleOptions(['isolation-prepare'], { ...selected, ...change }, site, primary),
      );
    assert.throws(() => lifecycleOptions(['reinstall-prepare'], selected, site, primary));
  }
});
