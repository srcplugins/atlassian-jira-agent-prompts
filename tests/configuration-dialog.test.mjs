import './typescript-loader.mjs';
import { readSpaces } from '../src/space-reads.ts';
import { finished } from '../src/batch-status.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchFixture } from './batch-fixture.mjs';
import { bridgeClient, hookHost, load, standIns, view } from './support/ui-harness.mjs';
function ui(f, selected = [...f.projects.values()]) {
  const calls = [];
  const closed = [];
  const invoke = async (name, payload) => {
    calls.push(name);
    const p = JSON.parse(JSON.stringify(payload));
    let value;
    try {
      if (name === 'settings-health') {
        if (f.healthFailure) throw Error('Diagnostic unavailable');
        value = { state: { data: {} }, checks: [{ ok: true, label: 'Type', detail: 'Available' }] };
      }
      if (name === 'configuration-catalog') {
        if (f.catalogFailure) throw Error('Catalog unavailable');
        value = await f.api.catalog();
      }
      if (name === 'configuration-status') {
        if (f.statusFailure) throw Error('Progress unavailable');
        value = await f.api.status();
      }
      if (name === 'configuration-preview')
        value = await f.api.preview(f.actor ?? 'admin', p.projectId, p);
      if (name === 'configuration-start')
        value = await f.api.start(f.actor ?? 'admin', p, p.entries, p.revision);
      if (name === 'configuration-advance')
        value = await f.api.advance(f.actor ?? 'admin', p.id, p.revision);
      if (name === 'configuration-stop')
        value = await f.api.stop(f.actor ?? 'admin', p.id, p.revision, p.acknowledged);
      if (f.dropStart && name === 'configuration-start') {
        f.dropStart = false;
        throw Error('Response lost');
      }
      return JSON.parse(JSON.stringify({ ok: true, value }));
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };
  const hooks = hookHost();
  const { ConfigurationDialog } = load('configuration-dialog.tsx', {
    react: hooks.react,
    './space-reads': { readSpaces },
    './batch-status': { finished },
    './client': bridgeClient(invoke),
    '@forge/react': {
      useProductContext: () => ({ accountId: f.actor ?? 'admin' }),
      ...standIns(
        'Modal',
        'ModalBody',
        'ModalFooter',
        'ModalHeader',
        'ModalTitle',
        'DynamicTable',
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
        'ProgressBar',
        'List',
        'ListItem',
      ),
    },
  });
  const v = view(hooks, () =>
    ConfigurationDialog({
      projects: selected,
      onClose: (changed) => closed.push(changed),
      onBusy: () => {},
    }),
  );
  return {
    ...v,
    calls,
    closed,
    hasButton: (label) => v.button(label) !== undefined,
    disabled: (label) => v.button(label)?.props.isDisabled,
  };
}
test('configuration dialog checks all existing spaces, creates nothing until confirmation, and finishes each saved setup', async () => {
  const f = batchFixture();
  const v = ui(f);
  assert.deepEqual(v.calls, []);
  assert.equal(v.hasButton('Check saved progress'), false);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  v.change('Checkbox', 'Reload work item after saving prompts', { target: { checked: true } });
  await v.click('Review changes');
  assert.deepEqual(f.writes, []);
  assert.equal(v.disabled('Apply changes'), false);
  // A new project after review is intentionally absent from the exact scope.
  f.projects.set('8', {
    id: '8',
    key: 'LATER',
    name: 'Later',
    style: 'classic',
    projectTypeKey: 'software',
    issueTypes: [],
  });
  await v.click('Apply changes');
  assert.equal(f.state().data.status, 'complete');
  assert.equal(f.state().data.entries.length, 3);
  assert.equal(f.configs.has('8'), false);
  for (const id of ['1', '2', '7']) assert.equal(f.configs.get(id).data.refreshAfterSave, true);
  assert.match(v.text(), /3 of 3 spaces configured/);
  assert.equal(v.hasButton('Check ONE — One'), false);
  assert.equal(f.writes.filter((x) => x === 'create').length, 1);
});
test('a step that applied nothing stops the automatic advance and offers Continue reviewed changes', async () => {
  const { JiraUnavailable } = await import('../src/service.ts');
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Review changes');
  // Every second type read fails: advance's fresh review passes, apply's own review does not,
  // so the server returns the batch ready at the same project with nothing applied.
  const types = f.s.types;
  let reads = 0;
  f.s.types = async () => {
    if (++reads % 2 === 0)
      throw new JiraUnavailable('Jira connection failed. No write was retried.');
    return types();
  };
  await v.click('Apply changes');
  assert.equal(v.calls.filter((name) => name === 'configuration-advance').length, 1);
  assert.equal(f.state().data.status, 'ready');
  assert.equal(f.state().data.index, 0);
  assert.deepEqual(f.writes, []);
  assert.match(v.text(), /Nothing was changed/);
  assert.equal(v.hasButton('Continue reviewed changes'), true);
});
test('configuration dialog exposes per-space blockers and disables confirmation without side effects', async () => {
  const f = batchFixture();
  f.schemes.get('2').isDefault = true;
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Review changes');
  assert.equal(v.hasButton('Apply changes'), false);
  assert.match(v.text(), /Blocked:.*default/);
  assert.deepEqual(f.writes, []);
});
test('configuration dialog can reopen durable progress even when initial confirmation response was lost', async () => {
  const f = batchFixture();
  const r = await f.start();
  await f.api.advance('admin', r.data.id, r.revision);
  const v = ui(f);
  await v.mount();
  assert.match(v.text(), /Configured/);
  assert.equal(v.hasButton('End this run'), false);
  await v.click('Continue reviewed changes');
  assert.equal(f.state().data.status, 'complete');
  assert.equal(f.writes.filter((x) => x === 'create').length, 1);
});

test('confirmation response loss exposes read-only recovery without a duplicate create', async () => {
  const f = batchFixture();
  f.dropStart = true;
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Review changes');
  await v.click('Apply changes');
  assert.equal(v.hasButton('Check saved progress'), true);
  assert.deepEqual(f.writes, []);
  await v.click('Check saved progress');
  await v.click('Continue reviewed changes');
  assert.equal(f.state().data.status, 'complete');
  assert.equal(f.writes.filter((x) => x === 'create').length, 1);
});

test('a completed prior run does not prevent opening a fresh review', async () => {
  const f = batchFixture();
  let r = await f.start();
  while (r.data.status === 'ready') r = await f.api.advance('admin', r.data.id, r.revision);
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-type', { value: '5' });
  await v.click('Review changes');
  assert.equal(v.hasButton('Apply changes'), true);
  assert.equal(v.hasButton('Done'), false);
});

test('shared review lists unselected affected spaces and requires acknowledgment before applying', async () => {
  const f = batchFixture();
  const scheme = { id: '91', name: 'Shared', projectIds: ['1', '2', '7'], isDefault: false };
  for (const id of scheme.projectIds) f.schemes.set(id, scheme);
  const v = ui(f, [f.projects.get('1'), f.projects.get('2')]);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Review changes');
  assert.equal(v.disabled('Apply changes'), true);
  assert.match(v.text(), /3 spaces.*2 selected.*1 additional/);
  assert.match(v.text(), /PR7/);
  assert.match(v.text(), /Type available only/);
  v.change('Checkbox', 'I approve the shared scheme changes for all listed affected spaces.', {
    target: { checked: true },
  });
  assert.equal(v.disabled('Apply changes'), false);
  await v.click('Apply changes');
  assert.equal(f.state().data.status, 'complete');
  assert.deepEqual(f.writes, ['create', 'attach 91']);
  assert.equal(f.configs.has('7'), false);
});

test('bulk setup saves the selected reload preference for every reviewed space', async () => {
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-type', { value: '3' });
  v.change('Checkbox', 'Reload work item after saving prompts', { target: { checked: true } });
  await v.click('Review changes');
  await v.click('Apply changes');
  for (const id of ['1', '2', '7']) assert.equal(f.configs.get(id).data.refreshAfterSave, true);
  await v.click('Done');
  assert.deepEqual(v.closed, [true]);
});

test('bulk setup removal is reviewed, preserves Jira and reports only selected spaces', async () => {
  const f = batchFixture();
  for (const id of ['1', '2', '7'])
    f.configs.set(id, { revision: 1, data: { type: '3', refreshAfterSave: true } });
  const before = structuredClone([...f.projects]);
  const v = ui(f, [f.projects.get('1'), f.projects.get('2')]);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'unlink' });
  await v.click('Review changes');
  assert.equal(f.configs.get('1').data.type, '3');
  await v.click('Apply changes');
  assert.equal(f.state().data.status, 'complete');
  assert.match(v.text(), /Setup removed from 2 of 2 spaces/);
  assert.deepEqual(f.configs.get('1').data, { previousTypes: ['3'] });
  assert.deepEqual(f.configs.get('2').data, { previousTypes: ['3'] });
  assert.equal(f.configs.get('7').data.type, '3');
  assert.deepEqual([...f.projects], before);
  assert.deepEqual(f.writes, []);
});

test('cancelling a reviewed dialog reports no mutation and leaves configuration untouched', async () => {
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'unlink' });
  await v.click('Review changes');
  await v.click('Cancel');
  assert.deepEqual(v.closed, [false]);
  assert.equal(f.configs.size, 0);
  assert.deepEqual(f.writes, []);
});

test('the spinner remains visible during review and apply, then clears', async () => {
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  for (const [method, button] of [
    ['preview', 'Review changes'],
    ['start', 'Apply changes'],
  ]) {
    const original = f.api[method];
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    f.api[method] = async (...args) => {
      await pending;
      return original(...args);
    };
    const action = v.click(button);
    v.render();
    assert.equal(v.nodes('Spinner').length, 1);
    assert.ok(!v.hasButton(button) || v.disabled(button));
    release();
    await action;
    assert.equal(v.nodes('Spinner').length, 0);
    f.api[method] = original;
  }
  assert.equal(f.state().data.status, 'complete');
});

test('another administrator can release an abandoned configuration without continuing its writes', async () => {
  const f = batchFixture();
  const r = await f.start();
  await f.api.advance('admin', r.data.id, r.revision);
  f.actor = 'replacement-admin';
  const before = structuredClone(f.configs.get('1'));
  const v = ui(f);
  await v.mount();
  assert.equal(v.hasButton('Continue reviewed changes'), false);
  assert.equal(v.disabled('Release abandoned configuration'), true);
  v.change(
    'Checkbox',
    'I confirmed this configuration is abandoned and inspected its affected Jira changes.',
    { target: { checked: true } },
  );
  await v.click('Release abandoned configuration');
  assert.equal(f.state().data.status, 'stopped');
  assert.deepEqual(f.configs.get('1'), before);
  assert.deepEqual(f.writes, ['create', 'attach 91']);
  await v.click('Done');
  assert.deepEqual(v.closed, [true]);
  const next = ui(f, [f.projects.get('2')]);
  await next.mount();
  next.change('Select', 'configuration-type', { value: '5' });
  await next.click('Review changes');
  await next.click('Apply changes');
  assert.equal(f.state().data.status, 'complete');
  assert.equal(f.state().data.actor, 'replacement-admin');
  assert.deepEqual(f.writes, ['create', 'attach 91', 'attach 92']);
});

test('foreign-admin release retains uncertain space claims and enforces the wait and fresh acknowledgement', async () => {
  const f = batchFixture();
  f.s.attach = async () => {
    throw Error('Association outcome unknown');
  };
  const r = await f.start();
  await f.api.advance('admin', r.data.id, r.revision);
  const pending = structuredClone(f.configs.get('1'));
  f.actor = 'replacement-admin';
  const v = ui(f);
  await v.mount();
  const acknowledgement =
    'I confirmed this configuration is abandoned and inspected its affected Jira changes.';
  v.change('Checkbox', acknowledgement, { target: { checked: true } });
  await v.click('Release abandoned configuration');
  assert.match(v.text(), /Wait two minutes/);
  assert.equal(f.state().data.status, 'attention');
  f.state().data.started = Date.now() - 120001;
  await v.click('Check saved progress');
  assert.equal(v.disabled('Release abandoned configuration'), true);
  v.change('Checkbox', acknowledgement, { target: { checked: true } });
  await v.click('Release abandoned configuration');
  assert.equal(f.state().data.status, 'stopped');
  assert.equal(f.state().data.inspectProject, '1');
  assert.equal(f.state().data.cancelRequested, true);
  assert.match(v.text(), /Outcome needs inspection/);
  assert.deepEqual(f.configs.get('1'), pending);
  assert.deepEqual(f.writes, ['create']);
});

test('own runs retain automatic cancellation without an abandoned-run control', async () => {
  const f = batchFixture();
  await f.start();
  const v = ui(f);
  await v.mount();
  assert.equal(v.hasButton('Release abandoned configuration'), false);
  assert.equal(v.hasButton('Continue reviewed changes'), true);
});

test('setup removal remains reviewable when type discovery, inventory or the catalog request fails', async () => {
  for (const failure of ['types', 'inventory', 'catalog']) {
    const f = batchFixture();
    f.configs.set('1', { revision: 1, data: { type: '3', refreshAfterSave: true } });
    if (failure === 'types')
      f.s.types = async () => {
        throw Error('Types unavailable');
      };
    if (failure === 'inventory')
      f.w.projects = async () => {
        throw Error('Inventory unavailable');
      };
    if (failure === 'catalog') f.catalogFailure = true;
    const v = ui(f, [f.projects.get('1')]);
    await v.mount();
    if (failure !== 'inventory') {
      assert.match(v.text(), /Work types could not be loaded/);
      assert.equal(v.disabled('Review changes'), true);
      v.change('Select', 'configuration-mode', { value: 'create' });
      v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
      assert.equal(v.disabled('Review changes'), true);
    }
    v.change('Select', 'configuration-mode', { value: 'unlink' });
    await v.click('Review changes');
    assert.equal(f.configs.get('1').data.type, '3');
    await v.click('Apply changes');
    assert.deepEqual(f.configs.get('1').data, { previousTypes: ['3'] });
    assert.equal(f.state().data.entries.length, 1);
    assert.deepEqual(f.writes, []);
  }
});

test('saved progress remains observable and recoverable when catalog discovery fails', async () => {
  const f = batchFixture();
  await f.start();
  f.actor = 'replacement-admin';
  f.catalogFailure = true;
  const v = ui(f);
  await v.mount();
  assert.match(v.text(), /0 of 2 spaces configured/);
  assert.equal(v.hasButton('Check saved progress'), true);
  assert.equal(v.hasButton('Release abandoned configuration'), true);
  assert.equal(v.hasButton('Continue reviewed changes'), false);
  await v.click('Check saved progress');
  assert.deepEqual(f.writes, []);
});

test('saved progress names a space outside the loaded inventory by its ID, never as a bare number', async () => {
  const f = batchFixture();
  const started = await f.start();
  f.catalogFailure = true;
  // No selected spaces and no catalog: the saved batch's spaces are known only by ID.
  const v = ui(f, []);
  await v.mount();
  for (const { projectId } of started.data.entries)
    assert.match(v.text(), new RegExp(`Space ID ${projectId}\\b`));
  assert.doesNotMatch(v.text(), /^\d+$/m);
});
test('failed initial progress read blocks new mutations until an explicit successful status check', async () => {
  const f = batchFixture();
  await f.start();
  f.actor = 'replacement-admin';
  f.statusFailure = true;
  const v = ui(f);
  await v.mount();
  assert.equal(v.hasButton('Review changes'), false);
  assert.equal(v.hasButton('Apply changes'), false);
  assert.equal(v.hasButton('Check saved progress'), true);
  f.statusFailure = false;
  await v.click('Check saved progress');
  v.change(
    'Checkbox',
    'I confirmed this configuration is abandoned and inspected its affected Jira changes.',
    { target: { checked: true } },
  );
  await v.click('Release abandoned configuration');
  await v.click('Done');
  assert.deepEqual(v.closed, [true]);
  assert.deepEqual(f.writes, []);
});

test('a second Apply or Review click delivered before the host re-renders is ignored', async () => {
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  const review = v.button('Review changes');
  review.props.onClick();
  review.props.onClick();
  await v.settle();
  assert.equal(v.calls.filter((c) => c === 'configuration-preview').length, f.projects.size);
  const apply = v.button('Apply changes');
  apply.props.onClick();
  apply.props.onClick();
  await v.settle();
  assert.equal(v.calls.filter((c) => c === 'configuration-start').length, 1);
  assert.equal(f.state().data.status, 'complete');
  assert.doesNotMatch(v.text(), /progress changed|Reopen the configuration dialog/);
});
