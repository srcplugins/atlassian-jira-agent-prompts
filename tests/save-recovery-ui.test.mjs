import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultExport, hookHost, load, view } from './support/ui-harness.mjs';

function fixture(replies) {
  const calls = [];
  let recovered = 0;
  const call = async (name, payload) => {
    calls.push({ name, payload });
    assert.ok(replies.length, 'Unexpected resolver call');
    const value = replies.shift();
    if (value instanceof Error) throw value;
    return value;
  };
  const hooks = hookHost();
  const { SaveRecovery } = load('save-recovery-ui.tsx', {
    react: hooks.react,
    '@atlaskit/button/new': defaultExport('Button'),
    './client': { call },
  });
  const v = view(hooks, () =>
    SaveRecovery({
      onRecovered: async () => {
        recovered++;
      },
    }),
  );
  return {
    ...v,
    calls,
    recovered: () => recovered,
    // The focus effect, run as React runs it after `busy` changes.
    refocus: () => hooks.rerun(0),
    acknowledge() {
      const n = v.nodes('input')[0];
      assert.ok(n && !n.props.disabled);
      n.props.onChange({ target: { checked: true } });
      v.render();
    },
  };
}
const pending = {
  pending: true,
  revision: 7,
  fingerprint: 'reviewed-target',
  administrator: true,
  unchanged: true,
  waitSeconds: 0,
};
test('checking a reconciled save immediately reloads the field without a write', async () => {
  const f = fixture([{ pending: false }]);
  await f.click('Check saved state');
  assert.equal(f.recovered(), 1);
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['save-status'],
  );
});
test('ordinary users and changed outcomes never receive the release control', async () => {
  for (const status of [
    { ...pending, administrator: false },
    { ...pending, unchanged: false },
  ]) {
    const f = fixture([status]);
    await f.click('Check saved state');
    assert.equal(f.button('Release unchanged save'), undefined);
    assert.equal(f.nodes('input').length, 0);
  }
});
test('administrator release requires elapsed guard and explicit acknowledgment of current state', async () => {
  const f = fixture([{ ...pending, waitSeconds: 30 }, pending, { resolved: true }]);
  await f.click('Check saved state');
  assert.equal(f.button('Release unchanged save').props.isDisabled, true);
  assert.equal(f.nodes('input')[0].props.disabled, true);
  await f.click('Check saved state');
  assert.equal(f.button('Release unchanged save').props.isDisabled, true);
  f.acknowledge();
  await f.click('Release unchanged save');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[2])), {
    name: 'resolve-save',
    payload: { revision: 7, fingerprint: 'reviewed-target', acknowledged: true },
  });
  assert.equal(f.recovered(), 1);
  assert.equal(f.button('Release unchanged save'), undefined);
});
test('lost recovery response requires a fresh check and never repeats release automatically', async () => {
  const f = fixture([pending, Error('Lost response'), { pending: false }]);
  await f.click('Check saved state');
  f.acknowledge();
  await f.click('Release unchanged save');
  assert.equal(f.button('Release unchanged save'), undefined);
  assert.equal(f.recovered(), 0);
  // The pressed button is gone, so keyboard focus moves to the check that comes next.
  let focused = 0;
  f.button('Check saved state').props.ref.current = { focus: () => focused++ };
  f.refocus();
  assert.equal(focused, 1);
  await f.click('Check saved state');
  assert.equal(f.recovered(), 1);
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['save-status', 'resolve-save', 'save-status'],
  );
});

const normalized = { ...pending, unchanged: false, adoptable: true, keys: ['TEST-20'] };
test('accepting a normalized save needs an administrator, the elapsed guard and acknowledgement', async () => {
  for (const status of [
    { ...normalized, administrator: false },
    { ...normalized, adoptable: false },
  ]) {
    const f = fixture([status]);
    await f.click('Check saved state');
    assert.equal(f.button('Accept saved work item'), undefined);
    assert.equal(f.button('Release unchanged save'), undefined);
  }
  const waiting = fixture([{ ...normalized, waitSeconds: 30 }]);
  await waiting.click('Check saved state');
  assert.equal(waiting.button('Accept saved work item').props.isDisabled, true);
  assert.match(waiting.text('p'), /Wait 30 seconds/);
  const f = fixture([normalized, { accepted: true }]);
  await f.click('Check saved state');
  assert.match(f.text('p'), /TEST-20/);
  assert.equal(f.button('Accept saved work item').props.isDisabled, true);
  f.acknowledge();
  await f.click('Accept saved work item');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1))), {
    name: 'accept-save',
    payload: { revision: 7, fingerprint: 'reviewed-target', acknowledged: true },
  });
  assert.equal(f.recovered(), 1);
  assert.equal(f.button('Accept saved work item'), undefined);
  assert.match(f.text('p'), /Saved work item accepted/);
});

const removed = { ...pending, unchanged: false, sectionRemoved: true };
test('with the section deleted, an administrator can release a save whose outcome is unknown', async () => {
  for (const status of [
    { ...removed, administrator: false },
    { ...removed, sectionRemoved: false },
  ]) {
    const f = fixture([status]);
    await f.click('Check saved state');
    assert.equal(f.button('Release save'), undefined);
    assert.equal(f.nodes('input').length, 0);
  }
  const edited = fixture([{ ...removed, sectionRemoved: false }]);
  await edited.click('Check saved state');
  assert.match(edited.text('p'), /delete the Agent Prompts section/);
  const f = fixture([{ ...removed, waitSeconds: 30 }, removed, { resolved: true }]);
  await f.click('Check saved state');
  assert.equal(f.button('Release save').props.isDisabled, true);
  await f.click('Check saved state');
  assert.match(f.text('p'), /no longer in the description/);
  assert.equal(f.button('Release save').props.isDisabled, true);
  f.acknowledge();
  await f.click('Release save');
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[2])), {
    name: 'resolve-save',
    payload: { revision: 7, fingerprint: 'reviewed-target', acknowledged: true },
  });
  assert.equal(f.recovered(), 1);
  assert.equal(f.button('Release save'), undefined);
});

test('Check saved state starts with focus and keeps it while it checks', async () => {
  const f = fixture([pending]);
  assert.equal(f.button('Check saved state').props.autoFocus, true);
  const checking = f.click('Check saved state');
  f.render();
  assert.equal(f.button('Check saved state').props.isLoading, true);
  assert.equal(f.button('Check saved state').props.isDisabled, false);
  await checking;
  assert.equal(f.button('Check saved state').props.isLoading, false);
  // Checking is not a finish, so it never moves focus.
  f.button('Check saved state').props.ref.current = { focus: () => assert.fail('moved focus') };
  f.refocus();
});

test('recovery outcomes are announced in a status region present from the start', async () => {
  const f = fixture([Error('Saved state changed. Check saved state again.')]);
  const status = () => f.nodes('p').find((p) => p.props.role === 'status');
  assert.ok(status());
  await f.click('Check saved state');
  assert.match([status().props.children].flat().join(''), /Saved state changed/);
});
