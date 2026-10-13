import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FixtureRun } from '@srcplugins/atlassian-forge-test-framework/core';
import { runRovoJourney } from './hosted/support/agent-prompts-rovo.mjs';

function fixture() {
  const baseline = { id: '10', fields: { summary: 'Unrelated work item', description: null } };
  const issues = [structuredClone(baseline)];
  const calls = [];
  const captures = [];
  let source;
  const run = FixtureRun.create({
    app: 'native-prompt-links', // The journal identity of Agent Prompts' owned fixtures.
    site: 'https://owned.atlassian.net',
    projectId: '1',
    runId: '550e8400-e29b-41d4-a716-446655440000',
    save() {},
    adapters: {
      issue: {
        async create(expected) {
          calls.push('create');
          const entry = run.state.resources.at(-1);
          assert.equal(entry.status, 'creating');
          assert.deepEqual(entry.expected, expected);
          const id = String(20 + run.state.resources.length - 1);
          const issue = {
            id,
            key: `OWNED-${id}`,
            fields: {
              project: { id: '1' },
              issuetype: { id: expected.typeId ?? '3' },
              summary: expected.summary,
              description: structuredClone(expected.description),
            },
          };
          source ??= issue;
          issues.push(issue);
          return { id };
        },
        read: async (id) => issues.find((issue) => issue.id === id) ?? null,
        verify: async (entry) => {
          const issue = issues.find((x) => x.id === entry.id);
          assert.deepEqual(issue.fields.description, entry.expected.description);
        },
        remove: async (entry) => {
          calls.push('delete');
          issues.splice(
            issues.findIndex((issue) => issue.id === entry.id),
            1,
          );
        },
      },
    },
  });
  const owned = {
    project: { id: '1' },
    run,
    propertyIssue(summary, instructions, type) {
      assert.equal(type, '39', 'Use the current mapping, not a historical type name');
      return run.create('issue', {
        summary,
        typeId: type,
        description: {
          version: 1,
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: instructions }] }],
        },
      });
    },
    api: async (path) =>
      structuredClone(issues.find((issue) => path.startsWith(`/issue/${issue.id}?`))),
    cleanup: () => run.cleanup(),
  };
  const input = {
    owned,
    setup: async () => ({ project: { id: '1' }, type: '39' }),
    discover: async (key) => ({ prompts: [{ id: source.id, key }] }),
    search: async (args) => {
      assert.deepEqual(Object.keys(args).sort(), ['index', 'key']);
      calls.push(`search-${args.index}`);
      return `${source.key} — ${source.fields.summary}`;
    },
    read: async (args) => {
      assert.deepEqual(Object.keys(args).sort(), ['index', 'key']);
      calls.push(`read-${args.index}`);
      return `${source.key}: ${source.fields.description.content[0].content[0].text}`;
    },
    inventory: async () => structuredClone(issues),
    capture: async (stage, data) => captures.push({ stage, data }),
  };
  return { input, owned, issues, baseline, calls, captures };
}

test('Rovo runner journals one ordinary source in the current type and cleans after two searches/reads', async () => {
  const f = fixture();
  await runRovoJourney(f.input);
  assert.deepEqual(f.calls, ['create', 'search-1', 'read-1', 'search-2', 'read-2', 'delete']);
  assert.equal(f.owned.run.state.status, 'clean');
  assert.equal(f.owned.run.state.testStatus, 'passed');
  assert.equal(f.owned.run.state.resources[0].expected.description.content[0].type, 'paragraph');
  assert.deepEqual(f.issues, [f.baseline]);
  assert.equal(f.captures.length, 4);
});

test('missing consent/setup, missing space setup and wrong space fail before fixture creation', async () => {
  for (const setup of [
    async () => {
      throw Error('Consent required');
    },
    async () => ({ project: { id: '1' } }),
    async () => ({ project: { id: '2' }, type: '39' }),
  ]) {
    const f = fixture();
    await assert.rejects(runRovoJourney({ ...f.input, setup }));
    assert.deepEqual(f.calls, []);
    assert.equal(f.owned.run.state.testStatus, 'failed');
    assert.equal(f.owned.run.state.status, 'clean');
  }
});

// Each case must fail acceptance and still remove exactly the journaled fixture.
test('search absence, unverified search, failed/incomplete reads and Jira drift cannot pass', async () => {
  for (const [name, change, calls, error = Error] of [
    [
      'source absent from Jira search',
      () => ({ discover: async () => ({ prompts: [] }) }),
      ['create', 'delete'],
      /searchable in Jira/,
    ],
    [
      'search without the withheld source name',
      () => ({ search: async ({ key }) => key }),
      ['create', 'delete'],
    ],
    [
      'agent read unavailable',
      () => ({
        read: async () => {
          throw Error('Agent action unavailable');
        },
      }),
      ['create', 'search-1', 'delete'],
    ],
    [
      'agent read without the source instructions',
      () => ({ read: async ({ key }) => `${key}: a summary without the source instructions` }),
      ['create', 'search-1', 'delete'],
    ],
    [
      'unexpected Jira change during read-only Rovo',
      (f) => ({
        read: async (args) => {
          const response = await f.input.read(args);
          f.issues[0].fields.summary = 'Unexpected change';
          return response;
        },
      }),
      ['create', 'search-1', 'read-1', 'delete'],
    ],
  ]) {
    const f = fixture();
    await assert.rejects(runRovoJourney({ ...f.input, ...change(f) }), error, name);
    assert.deepEqual(f.calls, calls, name);
    assert.equal(f.owned.run.state.testStatus, 'failed', name);
    assert.equal(f.owned.run.state.status, 'clean', name);
  }
});

test('changed fixture content blocks guarded deletion instead of being silently adopted', async () => {
  const f = fixture();
  const read = async (args) => {
    const response = await f.input.read(args);
    f.issues[1].fields.description.content[0].content[0].text = 'Owner edited this fixture';
    return response;
  };
  await assert.rejects(runRovoJourney({ ...f.input, read }), /cleanup incomplete/);
  assert.equal(f.owned.run.state.status, 'cleanup-required');
  assert.equal(f.calls.includes('delete'), false);
  assert.equal(f.issues.length, 2);
});

test('successful chats remain failed acceptance when final inventory restoration cannot be verified', async () => {
  const f = fixture();
  await assert.rejects(
    runRovoJourney({
      ...f.input,
      verifyCleanup: async () => {
        throw Error('Inventory still differs');
      },
    }),
    /Inventory still differs/,
  );
  assert.equal(f.owned.run.state.status, 'clean');
  assert.equal(f.owned.run.state.testStatus, 'failed');
});
