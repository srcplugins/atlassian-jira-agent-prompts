import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { suites } from '../forge-test.mjs';

// The hosted journey registry: every journey names its fixture, its independent assertion and its
// cleanup, points at lower-level tests that exist, and matches an actual hosted test or runner.
const registry = JSON.parse(readFileSync('tests/hosted/coverage.json', 'utf8'));
const journeys = [...registry.features, ...registry.manualJourneys, ...registry.scriptedJourneys];

test('every hosted journey declares its fixture, independent assertion and cleanup', () => {
  assert.equal(registry.schemaVersion, 1);
  const ids = journeys.map((journey) => journey.id);
  assert.equal(new Set(ids).size, ids.length, 'Journey IDs must be unique');
  for (const journey of journeys) {
    assert.ok(journey.fixture?.trim() && journey.assertion?.trim(), journey.id);
    assert.ok(journey.lowerLevelTests?.length, journey.id);
    for (const path of journey.lowerLevelTests)
      assert.ok(existsSync(path), `${journey.id}: ${path}`);
  }
  for (const feature of registry.features) {
    assert.ok(
      ['journal-verified', 'persistent-read-only', 'opt-in-restores', 'retained-baseline'].includes(
        feature.cleanup,
      ),
      feature.id,
    );
    assert.match(feature.suite, /^tests\/hosted\/[a-z0-9.-]+\.spec\.mjs$/);
    assert.ok(
      readFileSync(feature.suite, 'utf8').includes(feature.testTitle ?? feature.id),
      `Missing test ${feature.id}`,
    );
  }
  for (const journey of registry.scriptedJourneys)
    assert.ok(existsSync(journey.script), `${journey.id}: ${journey.script}`);
});

test('every hosted runner is registered, and the ones the suites run are marked unattended', () => {
  // Fixture runners (prepare-*) are registered too, so each states its checks and opt-in.
  const scripts = readdirSync('tests/hosted')
    .filter((name) => /^(verify|prepare)-[a-z-]+\.mjs$/.test(name))
    .map((name) => `tests/hosted/${name}`);
  const registered = new Set(registry.scriptedJourneys.map((journey) => journey.script));
  for (const script of scripts) assert.ok(registered.has(script), `${script} is not registered`);
  // The runners the full and release suites run must say so in the registry.
  const inSuites = new Set(
    [...suites.full, ...suites.release]
      .map((step) => step.command.find((part) => /^tests\/hosted\/verify-/.test(part)))
      .filter(Boolean),
  );
  assert.ok(inSuites.size >= 3, 'the suite definition names its runners');
  for (const journey of registry.scriptedJourneys)
    assert.equal(
      journey.unattended,
      inSuites.has(journey.script),
      `${journey.id}: unattended must match whether forge-test.mjs runs ${journey.script}`,
    );
});

test('every suite step can be settled after a failure: a guarded cleanup or clean fixture runs', () => {
  const cleanups = JSON.parse(readFileSync('tests/hosted/cleanup.json', 'utf8'));
  for (const step of Object.values(suites).flat()) {
    if (step.prerequisite) continue;
    if (step.cleanup === 'fixtures') continue;
    // A runner's cleanup is the same command the manual cleanup workflow input runs.
    const target = Object.values(cleanups).find(
      (entry) => JSON.stringify(entry.command) === JSON.stringify(step.cleanup),
    );
    assert.ok(target, `${step.name}: its cleanup must be listed in tests/hosted/cleanup.json`);
    assert.deepEqual(step.command.slice(0, 2), step.cleanup.slice(0, 2), step.name);
    for (const [name, value] of Object.entries(target.env ?? {}))
      assert.equal(step.env[name], value, `${step.name}: ${name}`);
  }
});

test('each setup mode key selects only its own step', () => {
  const names = suites.full.map((step) => step.name.toLowerCase());
  const keys = names.map((name) => name.match(/^setup ([a-z-]+):/)?.[1]).filter(Boolean);
  assert.equal(keys.length, 9);
  for (const key of keys) assert.equal(names.filter((name) => name.includes(key)).length, 1, key);
});

test('the public registry carries no site, account or private path', () => {
  const text = JSON.stringify(registry);
  assert.doesNotMatch(text, /[a-z0-9-]+\.atlassian\.net/);
  assert.doesNotMatch(text, /[0-9]{6}:[0-9a-f-]{36}|@[a-z0-9-]+\.[a-z]{2,}/i);
  assert.doesNotMatch(text, /\b(?:docs|platforms)\//);
});

test('the team-managed fixture runner does nothing without its explicit opt-in', () => {
  const env = { ...process.env };
  delete env.NATIVE_TEAM_MANAGED_PREPARE;
  const run = spawnSync(process.execPath, ['tests/hosted/prepare-team-managed.mjs'], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Explicit fixture preparation required/);
});

test('the licensing runner, which needs reinstalls, does nothing without its explicit opt-in', () => {
  const env = { ...process.env };
  delete env.NATIVE_LICENSING_TESTS;
  const run = spawnSync(process.execPath, ['tests/hosted/verify-licensing.mjs', 'inactive'], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Explicit licensing run required/);
});
