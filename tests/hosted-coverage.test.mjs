import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

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

test('the public registry carries no site, account or private path', () => {
  const text = JSON.stringify(registry);
  assert.doesNotMatch(text, /[a-z0-9-]+\.atlassian\.net/);
  assert.doesNotMatch(text, /[0-9]{6}:[0-9a-f-]{36}|@[a-z0-9-]+\.[a-z]{2,}/i);
  assert.doesNotMatch(text, /\b(?:docs|platforms)\//);
});
