import assert from 'node:assert/strict';

// These gates run before opening a fixture journal or making any connected write.
export function lifecycleOptions(args, env, isolationSite, primarySite) {
  const [mode, runId, ...extra] = args;
  assert.equal(env.NATIVE_LIFECYCLE_TESTS, '1', 'Explicit NATIVE_LIFECYCLE_TESTS=1 required');
  const isolation = env.NATIVE_TENANT_ISOLATION === '1';
  if (isolation) {
    assert.ok(['isolation-prepare', 'isolation-probe', 'cleanup'].includes(mode));
    assert.ok([isolationSite, primarySite].filter(Boolean).includes(env.JIRA_SITE));
    assert.equal(env.NATIVE_LIFECYCLE_PROJECT, 'secondary');
    assert.equal(env.PLUGIN_TEST_ENVIRONMENT, 'development');
  } else {
    assert.equal(env.JIRA_SITE, isolationSite, 'Lifecycle requires the isolation site');
    assert.ok(!mode?.startsWith('isolation-'));
  }
  assert.equal(env.PLUGIN_TEST_SITE, env.JIRA_SITE, 'Browser/API site mismatch');
  const development = [
    'reinstall-prepare',
    'reinstall-verify',
    'upgrade-prepare',
    'upgrade-verify',
    'isolation-prepare',
    'isolation-probe',
  ].includes(mode);
  assert.ok(['production', 'development'].includes(env.PLUGIN_TEST_ENVIRONMENT));
  if (mode !== 'cleanup')
    assert.equal(env.PLUGIN_TEST_ENVIRONMENT, development ? 'development' : 'production');
  assert.equal(extra.length, 0, 'Unexpected lifecycle arguments');
  assert.ok(
    (['production', 'reinstall-prepare', 'upgrade-prepare', 'isolation-prepare'].includes(mode) &&
      runId === undefined) ||
      (['cleanup', 'reinstall-verify', 'upgrade-verify', 'isolation-probe'].includes(mode) &&
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(runId)),
    'Use production; reinstall/upgrade prepare or verify <run-uuid>; isolation-prepare; isolation-probe <peer-run-uuid>; or cleanup <run-uuid>',
  );
  return mode === 'isolation-probe'
    ? { mode, runId: undefined, peerRunId: runId }
    : { mode, runId };
}

export function verifyLifecycleActors(expected, observed) {
  const roles = ['owner', 'nc-admin', 'nc-user'];
  assert.equal(new Set(roles.map((role) => expected[role])).size, 3, 'Distinct actors required');
  for (const role of roles) {
    assert.ok(typeof expected[role] === 'string' && expected[role].length > 0);
    assert.equal(observed[role].accountId, expected[role], `Wrong ${role} session`);
    assert.equal(observed[role].permissions.ADMINISTER, role !== 'nc-user');
    for (const permission of ['BROWSE_PROJECTS', 'CREATE_ISSUES', 'EDIT_ISSUES'])
      assert.equal(observed[role].permissions[permission], true, `${role}: ${permission}`);
  }
}

export function verifyConfigurationPlan(plan, projectId, typeId) {
  assert.equal(plan.project.id, projectId, 'Configuration target changed');
  assert.equal(plan.type, typeId, 'Prompt type changed');
  assert.equal(plan.attach, false, 'Lifecycle may not change Jira schemes');
}
