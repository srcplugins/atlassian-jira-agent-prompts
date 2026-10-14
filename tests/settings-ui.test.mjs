import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeContract } from './support/forge-contract.mjs';
import { bridgeClient, hookHost, load, standIns, view } from './support/ui-harness.mjs';
const { registerResolvers } = await import('../src/integration.ts');

// Exercise real component callbacks, bridge serialization and backend handlers.
function fixture(invoke, props = {}) {
  const hooks = hookHost();
  const { Settings } = load('settings-ui.tsx', {
    react: hooks.react,
    './client': bridgeClient(invoke),
    '@forge/react': {
      useProductContext: () => ({ siteUrl: 'https://example.atlassian.net' }),
      xcss: (value) => value,
      ...standIns(
        'Box',
        'Lozenge',
        'SectionMessage',
        'Inline',
        'Button',
        'Checkbox',
        'Heading',
        'Label',
        'Link',
        'Select',
        'Spinner',
        'Stack',
        'Text',
        'Textfield',
      ),
    },
  });
  return view(hooks, () => Settings({ projectId: '1', ...props }));
}

test('failed diagnostics leave pending recovery reachable across resolver, bridge and settings UI', async () => {
  for (const pending of [true, false]) {
    const context = { accountId: 'admin', extension: { project: { id: '1' } } };
    const project = {
      id: '1',
      key: 'TEST',
      style: 'classic',
      projectTypeKey: 'software',
      issueTypes: [],
    };
    const allowed = { body: { permissions: { ADMINISTER: { havePermission: true } } } };
    const stored = {
      revision: 2,
      data: {
        type: '3',
        ...(pending ? { pending: { type: '4', scheme: '9', started: Date.now() - 121000 } } : {}),
      },
    };
    const sdk = {
      ...forgeContract(
        allowed,
        { body: project },
        { status: 500 },
        { body: { isLast: true, values: [{ issueTypeScheme: { id: '9' } }] } },
        {
          body: {
            isLast: true,
            values: [
              // An inconsistent space list (a duplicate) fails the scheme check.
              {
                id: '9',
                name: 'Shared',
                projects: { isLast: true, values: [{ id: '1' }, { id: '1' }] },
              },
            ],
          },
        },
        { body: [{ id: 'customfield_1', schema: { custom: 'exact' } }] },
        ...(pending ? [allowed, { body: project }, { status: 500 }] : []),
      ),
      kvs: {
        entity: () => ({ get: async () => structuredClone(stored) }),
        transact: () => assert.fail('Diagnostic and outcome checks must not write storage'),
      },
      fieldType: () => 'exact',
    };
    const handlers = registerResolvers(sdk);
    const replies = [];
    const invoke = async (name, payload) => {
      const result = JSON.parse(JSON.stringify(await handlers[name]({ context, payload })));
      replies.push(result);
      return result;
    };
    assert.equal(sdk.calls.length, 0, 'diagnostics run only on request');
    // The space scan's check is what the details view opens with.
    const scanned = await invoke('settings-health', { projectId: '1' });
    const ui = fixture(invoke, { initialHealth: scanned.value });
    await ui.mount();
    assert.equal(replies[0].ok, true);
    assert.equal(replies[0].value.canConfigure, false);
    assert.equal(replies[0].value.scheme, undefined);
    assert.deepEqual(replies[0].value.state, stored);
    assert.equal(ui.labels().includes('Check outcome'), pending);
    assert.equal(ui.labels().includes('Acknowledge resolution'), pending);
    // Type changes and setup removal belong to the reviewed configuration dialog, not space details.
    assert.ok(!ui.labels().some((label) => /remove setup|unlink|apply change/i.test(label)));
    if (pending) {
      await ui.click('Check outcome');
      assert.match(replies[1].value.message, /outcome remains unknown/);
      assert.equal(
        ui.nodes('Checkbox').find((n) => n.props.label.startsWith('I inspected')).props.isChecked,
        false,
      );
    }
    assert.ok(sdk.calls.every((call) => call.method === 'GET'));
    assert.equal(sdk.remaining(), 0);
  }
});

test('space details open with the scan check without another read', async () => {
  const health = {
    project: { id: '1', key: 'TEST' },
    state: { data: { type: '4' } },
    checks: [],
    types: [],
    canConfigure: false,
  };
  const calls = [];
  const ui = fixture(
    async (name) => {
      calls.push(name);
      return { ok: true, value: health };
    },
    { initialHealth: health },
  );
  await ui.mount();
  assert.deepEqual(calls, []);
  assert.ok(
    ui
      .nodes('Text')
      .some((n) => n.props.children.flat(Infinity).join('').includes('Agent Prompts')),
  );
});

test('Jira configuration is always visible with absolute new-tab links and no text inputs', async () => {
  const calls = [];
  const ui = fixture(
    async (name) => {
      calls.push(name);
    },
    {
      initialHealth: {
        project: { id: '1', key: 'TEST' },
        state: { revision: 2, data: { type: '4' } },
        types: [{ id: '4', name: 'Prompt' }],
        scheme: { name: 'Shared scheme' },
        checks: [],
      },
    },
  );
  await ui.mount();
  assert.equal(ui.nodes('Textfield').length, 0);
  const links = ui.nodes('Link');
  assert.equal(links.length, 2);
  assert.ok(links.every((n) => n.props.openNewTab));
  assert.deepEqual(
    links.map((n) => n.props.href),
    [
      'https://example.atlassian.net/plugins/servlet/project-config/TEST/issuetypes',
      'https://example.atlassian.net/plugins/servlet/project-config/TEST/screens',
    ],
  );
  assert.deepEqual(calls, []);
});

test('preferences preserve revision validation and explicit save, including failure feedback', async () => {
  for (const fails of [true, false]) {
    const health = {
      project: { id: '1', key: 'TEST' },
      state: { revision: 2, data: { type: '4' } },
      types: [],
      checks: [],
    };
    const calls = [];
    const ui = fixture(
      async (name, payload) => {
        calls.push({ name, payload: structuredClone(payload) });
        if (name === 'settings-preferences') {
          if (fails) return { ok: false, error: 'Configuration changed.' };
          health.state = { revision: 3, data: { type: '4', refreshAfterSave: true } };
        }
        return { ok: true, value: health };
      },
      { initialHealth: health },
    );
    await ui.mount();
    assert.equal(
      ui.nodes('Button').find((n) => n.props.children[0] === 'Save').props.isDisabled,
      true,
    );
    ui.change('Checkbox', (n) => n.props.label.startsWith('Reload'), { target: { checked: true } });
    assert.equal(calls.length, 0);
    await ui.click('Save');
    assert.deepEqual(calls[0], {
      name: 'settings-preferences',
      payload: { projectId: '1', revision: 2, refreshAfterSave: true },
    });
    assert.equal(calls.length, fails ? 1 : 2);
    assert.ok(ui.nodes('Box').some((n) => n.props.role === 'status'));
  }
});

test('a saved preference stays reported as saved when the follow-up check fails', async () => {
  const health = {
    project: { id: '1', key: 'TEST' },
    state: { revision: 2, data: { type: '4' } },
    types: [],
    checks: [],
  };
  const calls = [];
  const stale = [];
  const ui = fixture(
    async (name) => {
      calls.push(name);
      if (name === 'settings-preferences') return { ok: true, value: { saved: true } };
      return { ok: false, error: 'Could not reach the app.' };
    },
    { initialHealth: health, onStale: (message) => stale.push(message) },
  );
  await ui.mount();
  ui.change('Checkbox', (n) => n.props.label.startsWith('Reload'), { target: { checked: true } });
  await ui.click('Save');
  assert.deepEqual(calls, ['settings-preferences', 'settings-health']);
  assert.match(ui.text(), /Preferences saved\. The space could not be checked again/);
  assert.doesNotMatch(ui.text(), /Could not reach the app/);
  // The stale revision is gone, so no second Save can be sent against it.
  assert.equal(ui.button('Save'), undefined);
  assert.equal(stale.length, 1);
});

test('the settings status region exists before any outcome is announced', async () => {
  const v = fixture(() => new Promise(() => {}), {
    initialHealth: {
      project: { id: '1', key: 'TEST' },
      state: { revision: 0, data: {} },
      checks: [],
      types: [],
      canConfigure: true,
    },
  });
  const regions = v.nodes('Box').filter((box) => box.props.role === 'status');
  assert.equal(regions.length, 1);
});
