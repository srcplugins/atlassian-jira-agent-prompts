import './support/typescript-loader.mjs';
import { readSpaces } from '../src/space-reads.ts';
import { finished } from '../src/batch-status.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchFixture } from './batch-fixture.mjs';
import { bridgeClient, hookHost, load, standIns, view } from './support/ui-harness.mjs';
/** `inventory` is what the health view passes: every space it loaded, by default all of them. */
function ui(
  f,
  selected = [...f.projects.values()],
  inventory = { projects: [...f.projects.values()], incomplete: false },
) {
  const calls = [];
  const closed = [];
  const payloads = [];
  const invoke = async (name, payload) => {
    calls.push(name);
    const p = JSON.parse(JSON.stringify(payload));
    payloads.push({ name, payload: p });
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
      if (name === 'configuration-options') {
        // `optionsFailure` fails each listed space's next read once.
        if (f.optionsFailure?.delete(p.projectId)) throw Error('Work types unavailable');
        value = await f.api.options(f.actor ?? 'admin', p.projectId);
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
      useProductContext: () => f.context ?? { accountId: f.actor ?? 'admin' },
      ...standIns(
        'Box',
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
        'HelperMessage',
        'Label',
        'Link',
        'Select',
        'Spinner',
        'Stack',
        'Text',
        'Textfield',
        'ProgressBar',
        'ProgressTracker',
        'Lozenge',
        'SectionMessage',
        'List',
        'ListItem',
      ),
    },
  });
  const v = view(hooks, () =>
    ConfigurationDialog({
      projects: selected,
      inventory,
      onClose: (changed) => closed.push(changed),
      onBusy: () => {},
    }),
  );
  return {
    ...v,
    calls,
    payloads,
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
  v.change('Select', 'configuration-reload', { value: 'on', label: 'On for all selected spaces' });
  await v.click('Next');
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
  const { StorageUnavailable } = await import('../src/service.ts');
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Next');
  await v.click('Review changes');
  // The step's review reads the space's record once; apply's own read of it, before the claim,
  // fails, so the server returns the batch ready at the same space with nothing applied.
  const get = f.s.get;
  let reads = 0;
  f.s.get = async (id) => {
    if (++reads === 2)
      throw new StorageUnavailable('App storage is unavailable. Try again shortly.');
    return get(id);
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
  await v.click('Next');
  await v.click('Review changes');
  assert.equal(v.hasButton('Apply changes'), false);
  // The review refuses the space with its reason rather than returning a plan.
  assert.match(v.text(), /Could not be reviewed: This space uses Jira’s default work type scheme/);
  assert.equal(v.hasButton('Exclude unreviewed spaces'), true);
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
  await v.click('Next');
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
  await v.click('Next');
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
  await v.click('Next');
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

test('bulk setup with reload on saves it for every reviewed space', async () => {
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-type', { value: '3' });
  v.change('Select', 'configuration-reload', { value: 'on', label: 'On for all selected spaces' });
  await v.click('Next');
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
  for (const [method, button, before] of [
    ['preview', 'Next'],
    ['start', 'Apply changes', 'Review changes'],
  ]) {
    if (before) await v.click(before);
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
    assert.match(v.text(), / 0 of 3 spaces$/m);
    assert.equal(v.nodes('ProgressBar')[0]?.props.value, 0);
    // Only applying warns against reloading, which cancels the remaining spaces.
    assert.equal(/Keep this page open/.test(v.text()), method === 'start');
    assert.ok(!v.hasButton(button) || v.disabled(button));
    release();
    await action;
    assert.equal(v.nodes('Spinner').length, 0);
    assert.equal(v.nodes('ProgressBar').length, 0);
    f.api[method] = original;
  }
  assert.equal(f.state().data.status, 'complete');
});

test('clicking outside the dialog or pressing Escape keeps it open; the footer button closes it', async () => {
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  const height = v.nodes('Modal')[0].props.height;
  assert.ok(height > 0);
  await v.click('Next');
  // Every step has the same height, so the footer buttons don't move.
  assert.equal(v.nodes('Modal')[0].props.height, height);
  v.nodes('Modal')[0].props.onClose();
  v.render();
  assert.deepEqual(v.closed, []);
  assert.equal(v.hasButton('Review changes'), true);
  await v.click('Cancel');
  assert.deepEqual(v.closed, [false]);
});

test('review and work type pages step through the chosen spaces', async () => {
  const f = batchFixture(['1', '2', '3', '4', '5', '6', '7']);
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Next');
  await v.click('Review changes');
  const spaces = () => v.text().match(/^PR\d — Project \d$/gm);
  assert.deepEqual(spaces(), [
    'PR1 — Project 1',
    'PR2 — Project 2',
    'PR3 — Project 3',
    'PR4 — Project 4',
    'PR5 — Project 5',
  ]);
  assert.match(v.text(), /Spaces 1–5 of 7/);
  assert.equal(v.disabled('Previous spaces'), true);
  await v.click('Next spaces');
  assert.deepEqual(spaces(), ['PR6 — Project 6', 'PR7 — Project 7']);
  assert.match(v.text(), /Spaces 6–7 of 7/);
  assert.equal(v.disabled('Next spaces'), true);
  await v.click('Back');
  assert.equal(v.nodes('Label').length, 6);
  await v.click('Next spaces');
  assert.deepEqual(
    v.nodes('Label').map((n) => String(n.props.children)),
    [
      'Set all selected spaces to',
      'Work types for PR6 — Project 6',
      'Work types for PR7 — Project 7',
    ],
  );
  await v.click('Previous spaces');
  assert.match(String(v.nodes('Label')[1].props.children), /PR1/);
});

test('the space pager is disabled while a review or an apply is in flight', async () => {
  const f = batchFixture(['1', '2', '3', '4', '5', '6', '7']);
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Next');
  await v.click('Next spaces');
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
    if (method === 'preview') {
      // The review keeps the Work types step on screen with its pager locked.
      assert.equal(v.disabled('Previous spaces'), true);
      assert.equal(v.disabled('Next spaces'), true);
    } else {
      // Applying replaces the steps with the progress view, so there is no pager to click.
      assert.equal(v.hasButton('Previous spaces'), false);
      assert.equal(v.hasButton('Next spaces'), false);
    }
    release();
    await action;
    f.api[method] = original;
    // The review lands on the first page of the Review step, where the pager works again.
    if (method === 'preview') assert.equal(v.disabled('Next spaces'), false);
  }
  assert.equal(f.state().data.status, 'complete');
});

test('Continue reviewed changes waits for the product context to name the viewer', async () => {
  const f = batchFixture();
  await f.start();
  // Before the context resolves, the saved run cannot be known to be the viewer's own.
  f.context = {};
  const unknown = ui(f);
  await unknown.mount();
  assert.equal(unknown.hasButton('Continue reviewed changes'), false);
  assert.equal(unknown.hasButton('Check saved progress'), true);
  f.context = undefined;
  const known = ui(f);
  await known.mount();
  assert.equal(known.hasButton('Continue reviewed changes'), true);
  assert.deepEqual(f.writes, []);
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
  await next.click('Next');
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
    if (failure === 'catalog') f.catalogFailure = true;
    // A failed or truncated inventory arrives from the health view as incomplete.
    const v =
      failure === 'inventory'
        ? ui(f, [f.projects.get('1')], { projects: [f.projects.get('1')], incomplete: true })
        : ui(f, [f.projects.get('1')]);
    await v.mount();
    if (failure === 'inventory') assert.match(v.text(), /The space inventory is incomplete/);
    else assert.doesNotMatch(v.text(), /inventory is incomplete/);
    if (failure !== 'inventory') {
      assert.match(v.text(), /Work types could not be loaded/);
      assert.equal(v.disabled('Next'), true);
      v.change('Select', 'configuration-mode', { value: 'create' });
      v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
      assert.equal(v.disabled('Next'), true);
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
  // No selected spaces and an empty inventory: the saved batch's spaces are known only by ID.
  const v = ui(f, [], { projects: [], incomplete: true });
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
  assert.equal(v.hasButton('Next'), false);
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

test('a second Apply or Next click delivered before the host re-renders is ignored', async () => {
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  const next = v.button('Next');
  next.props.onClick();
  next.props.onClick();
  await v.settle();
  assert.equal(v.calls.filter((c) => c === 'configuration-options').length, f.projects.size);
  assert.equal(v.calls.filter((c) => c === 'configuration-preview').length, 0);
  await v.click('Review changes');
  assert.equal(v.calls.filter((c) => c === 'configuration-preview').length, f.projects.size);
  const apply = v.button('Apply changes');
  apply.props.onClick();
  apply.props.onClick();
  await v.settle();
  assert.equal(v.calls.filter((c) => c === 'configuration-start').length, 1);
  assert.equal(f.state().data.status, 'complete');
  assert.doesNotMatch(v.text(), /progress changed|Reopen the configuration dialog/);
});
test('work types chosen per space put Agent Prompts on their screens, and shared screens need their own approval', async () => {
  const f = batchFixture();
  // Spaces 1 and 2 share one Task screen; space 7 keeps its own.
  f.screens.use('1', '3', '*', '200');
  f.screens.use('2', '3', '*', '200');
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Next');
  assert.match(v.text(), /Choose the work types that show the Agent Prompts field in each space/);
  // Choosing types clears the review, and the next review sends the choice.
  v.change('Select', 'screen-types-1', [{ value: '3', label: 'Task' }]);
  v.change('Select', 'screen-types-2', [{ value: '3', label: 'Task' }]);
  v.change('Select', 'screen-types-7', [{ value: '3', label: 'Task' }]);
  await v.click('Review changes');
  assert.match(v.text(), /^Agent Prompts to Screen 200$/m);
  assert.match(v.text(), /^Agent Prompts to Screen 1007$/m);
  assert.ok(v.nodes('Lozenge').some((n) => n.props.appearance === 'success'));
  assert.match(v.text(), /PR1 — Project 1\nAgent Prompts added/);
  assert.match(v.text(), /PR2 — Project 2\nAgent Prompts added/);
  assert.equal(v.disabled('Apply changes'), true);
  v.change('Checkbox', 'I approve the shared screen changes for all listed affected spaces.', {
    target: { checked: true },
  });
  assert.deepEqual(f.writes, []);
  await v.click('Apply changes');
  assert.equal(f.state().data.status, 'complete');
  assert.deepEqual(
    f.writes.filter((w) => w.startsWith('add')),
    ['add 200 customfield_1', 'add 1007 customfield_1'],
  );
  assert.deepEqual(f.screens.records.get('200').data.projects, ['1', '2']);
  for (const id of ['1', '2', '7']) assert.deepEqual(f.configs.get(id).data.screenTypes, ['3']);
});
test('removing setup reviews the screens the app added the field to and hides the work type picker', async () => {
  const f = batchFixture();
  const v = ui(f, [f.projects.get('1')]);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Next');
  v.change('Select', 'screen-types-1', [{ value: '3', label: 'Task' }]);
  await v.click('Review changes');
  await v.click('Apply changes');
  assert.ok(f.writes.includes('add 1001 customfield_1'));
  const after = ui(f, [f.projects.get('1')]);
  await after.mount();
  after.change('Select', 'configuration-mode', { value: 'unlink' });
  assert.equal(
    after.nodes('Select').some((n) => n.props.inputId === 'screen-types-1'),
    false,
  );
  await after.click('Review changes');
  assert.match(after.text(), /^Agent Prompts from Screen 1001$/m);
  await after.click('Apply changes');
  assert.ok(f.writes.includes('remove 1001 customfield_1'));
  assert.equal(f.screens.records.has('1001'), false);
});
async function configureWithTask(f) {
  const v = ui(f, [f.projects.get('1')]);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Next');
  v.change('Select', 'screen-types-1', [{ value: '3', label: 'Task' }]);
  await v.click('Review changes');
  await v.click('Apply changes');
  assert.equal(f.state().data.status, 'complete');
}
const picker = (v, id) => v.nodes('Select').find((n) => n.props.inputId === `screen-types-${id}`);
test('a space blocked by a screen still offers its work types, so another selection can unblock it', async () => {
  const f = batchFixture();
  await configureWithTask(f);
  // Task's edit screen in space 1 is moved in Jira to a screen whose impact can't be reviewed.
  f.screens.use('1', '3', 'edit', '300');
  f.screens.incomplete.add('300');
  const v = ui(f, [f.projects.get('1')]);
  await v.mount();
  v.change('Select', 'configuration-type', { value: '5' });
  await v.click('Next');
  assert.deepEqual(
    picker(v, '1').props.value.map((o) => o.value),
    ['3'],
  );
  await v.click('Review changes');
  assert.match(v.text(), /Blocked: The screen Screen 300 is used by more spaces/);
  assert.equal(v.hasButton('Apply changes'), false);
  await v.click('Back');
  v.change('Select', 'screen-types-1', []);
  await v.click('Review changes');
  assert.doesNotMatch(v.text(), /Blocked/);
  await v.click('Apply changes');
  assert.equal(f.state().data.status, 'complete', f.state().data.message);
  assert.equal(f.configs.get('1').data.screenTypes, undefined);
});
test('a space whose review failed is reviewed again by Back and Review changes', async () => {
  const f = batchFixture();
  const preview = f.api.preview;
  let failures = 1;
  f.api.preview = async (actor, projectId, input) => {
    if (projectId === '2' && failures-- > 0)
      throw Error('Jira request failed (HTTP 500). Check your access, then try again.');
    return preview(actor, projectId, input);
  };
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  const previews = () => v.payloads.filter((c) => c.name === 'configuration-preview');
  await v.click('Next');
  await v.click('Review changes');
  assert.match(v.text(), /HTTP 500/);
  assert.equal(v.hasButton('Apply changes'), false);
  await v.click('Back');
  await v.click('Review changes');
  // Only the space that failed is read again.
  assert.equal(previews().length, 4);
  assert.equal(previews()[3].payload.projectId, '2');
  assert.doesNotMatch(v.text(), /HTTP 500/);
  await v.click('Apply changes');
  assert.equal(f.state().data.status, 'complete', f.state().data.message);
});
test('a review that returns after the selection changed is dropped', async () => {
  const f = batchFixture();
  const v = ui(f, [f.projects.get('1')]);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Next');
  // A changed choice clears the review made for this step, so Review changes reviews again.
  v.change('Select', 'screen-types-1', []);
  const select = picker(v, '1');
  // The picker change arrives before the disabled tree reaches the host.
  v.button('Review changes').props.onClick();
  select.props.onChange([{ value: '3', label: 'Task' }]);
  await v.settle();
  assert.deepEqual(
    picker(v, '1').props.value.map((o) => o.value),
    ['3'],
  );
  assert.equal(v.hasButton('Apply changes'), false);
  assert.match(v.text(), /selection changed during the review/);
  await v.click('Review changes');
  await v.click('Apply changes');
  assert.deepEqual(f.configs.get('1').data.screenTypes, ['3']);
});
test('changing one space’s work types reviews only that space again', async () => {
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  const previews = () => v.payloads.filter((c) => c.name === 'configuration-preview');
  await v.click('Next');
  await v.click('Review changes');
  assert.equal(previews().length, 3);
  assert.equal(v.hasButton('Apply changes'), true);
  await v.click('Back');
  v.change('Select', 'screen-types-2', [{ value: '3', label: 'Task' }]);
  await v.click('Review changes');
  assert.equal(previews().length, 4);
  assert.deepEqual(previews()[3].payload.projectId, '2');
  assert.deepEqual(previews()[3].payload.screenTypes, ['3']);
  await v.click('Apply changes');
  assert.equal(f.state().data.status, 'complete', f.state().data.message);
  assert.deepEqual(f.configs.get('2').data.screenTypes, ['3']);
  assert.equal(f.configs.get('1').data.screenTypes, undefined);
});
test('Apply to all reviews again only the spaces whose choice changed', async () => {
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  const previews = () => v.payloads.filter((c) => c.name === 'configuration-preview');
  await v.click('Next');
  v.change('Select', 'screen-types-1', [{ value: '3', label: 'Task' }]);
  await v.click('Review changes');
  assert.equal(previews().length, 3);
  await v.click('Back');
  // Space 1 already has Task, so only spaces 2 and 7 change.
  v.change('Select', 'bulk-types', [{ value: '3', label: 'Task' }]);
  await v.click('Apply to all');
  await v.click('Review changes');
  assert.equal(previews().length, 5);
  assert.deepEqual(
    previews()
      .slice(3)
      .map((c) => c.payload.projectId)
      .sort(),
    ['2', '7'],
  );
  assert.equal(v.hasButton('Apply changes'), true);
  // Applying the same choice again changes nothing, so the review stands.
  await v.click('Back');
  await v.click('Apply to all');
  await v.click('Review changes');
  assert.equal(previews().length, 5);
  assert.equal(v.hasButton('Apply changes'), true);
});
test('each space’s work type picker is named for its purpose and space', async () => {
  const f = batchFixture();
  const v = ui(f, [f.projects.get('1')]);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Next');
  const label = v.nodes('Label').find((n) => n.props.labelFor === 'screen-types-1');
  assert.match(String(label.props.children), /^Work types for PR1 — Project 1$/);
});
/** Space 1 offers seven more work types with their own screens (14 changes); each step has
 * time for four. Returns the picker options. */
function manyTypes(f) {
  const options = [];
  for (let i = 0; i < 7; i++) {
    const type = { id: String(10 + i), name: `Type ${10 + i}`, subtask: false, hierarchyLevel: 0 };
    f.types.push(type);
    f.projects.get('1').issueTypes.push(type);
    f.screens.use('1', type.id, 'edit', String(300 + 2 * i));
    f.screens.use('1', type.id, 'view', String(301 + 2 * i));
    options.push({ value: type.id, label: type.name });
  }
  f.screens.clock.left = 9_000;
  return options;
}
async function applyMany(f) {
  const options = manyTypes(f);
  const v = ui(f, [f.projects.get('1')]);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Next');
  v.change('Select', 'screen-types-1', options);
  await v.click('Review changes');
  return v;
}
test('a space with more screen changes than one step makes keeps advancing until it is done', async () => {
  const f = batchFixture();
  const v = await applyMany(f);
  await v.click('Apply changes');
  assert.equal(f.state().data.status, 'complete', f.state().data.message);
  assert.equal(v.calls.filter((name) => name === 'configuration-advance').length, 4);
  assert.equal(f.writes.filter((w) => w.startsWith('add')).length, 14);
  assert.match(v.text(), /1 of 1 spaces configured/);
});
test('a run stopped between steps shows the screen changes already made', async () => {
  const f = batchFixture();
  const v = await applyMany(f);
  // Someone adds the field to a later screen in Jira during the first step.
  const add = f.s.addScreenField;
  f.s.addScreenField = async (...a) => {
    await add(...a);
    if (a[0] === '303') f.screens.screens.get('310').tabs[0].fields.push('customfield_1');
  };
  await v.click('Apply changes');
  assert.equal(f.state().data.status, 'stopped');
  assert.equal(v.calls.filter((name) => name === 'configuration-advance').length, 2);
  assert.match(v.text(), /4 of 14 screen changes made/);
  assert.match(v.text(), /No further change was made for this space/);
});
/** The type writes of space 1's first step use up its request, so that step makes no screen
 * change; every later step has time for four again. `during` runs right after the type writes. */
function typeOnlyFirstStep(f, during = () => {}) {
  const attach = f.s.attach;
  f.s.attach = async (...a) => {
    await attach(...a);
    f.screens.clock.left = 3_500;
    during();
  };
  const advance = f.api.advance;
  f.api.advance = async (...a) => {
    try {
      return await advance(...a);
    } finally {
      f.screens.clock.left = 9_000;
    }
  };
}
test('a step that made only the type change keeps advancing to the screen changes', async () => {
  const f = batchFixture();
  const v = await applyMany(f);
  typeOnlyFirstStep(f);
  await v.click('Apply changes');
  assert.equal(f.state().data.status, 'complete', f.state().data.message);
  // One step for the type, then 4, 4, 4 and 2 screen changes.
  assert.equal(v.calls.filter((name) => name === 'configuration-advance').length, 5);
  assert.equal(f.writes.filter((w) => w.startsWith('add')).length, 14);
  assert.match(v.text(), /1 of 1 spaces configured/);
});
test('a run stopped after a type-only step shows the space as started, not unconfigured', async () => {
  const f = batchFixture();
  const v = await applyMany(f);
  // Someone adds the field to one of the reviewed screens in Jira during that step.
  typeOnlyFirstStep(f, () => f.screens.screens.get('310').tabs[0].fields.push('customfield_1'));
  await v.click('Apply changes');
  assert.equal(f.state().data.status, 'stopped');
  assert.deepEqual(f.writes, ['create', 'attach 91']);
  const table = v.nodes('DynamicTable').find((t) => t.props.label === 'Configuration results');
  const cell = [table.props.rows[0].cells[1].content.props.children].flat().join('');
  assert.equal(cell, '0 of 14 screen changes made');
  assert.match(v.text(), /No further change was made for this space/);
});

const reloadPicker = (v) =>
  v.nodes('Select').find((n) => n.props.inputId === 'configuration-reload');
test('the reload choice offers keep, on and off, starts on keep and keeps each space’s setting', async () => {
  const f = batchFixture();
  f.configs.set('1', { revision: 1, data: { type: '3', refreshAfterSave: true } });
  f.configs.set('2', { revision: 1, data: { type: '3', refreshAfterSave: false } });
  const v = ui(f);
  await v.mount();
  assert.match(v.text('Label'), /^Reload work item after saving prompts$/m);
  assert.match(v.text('HelperMessage'), /Reloading can discard other unsaved edits/);
  assert.deepEqual(
    // Spread into this realm: the component runs in its own.
    [...reloadPicker(v).props.options].map((o) => [o.value, o.label]),
    [
      ['keep', 'Keep each space’s setting'],
      ['on', 'On for all selected spaces'],
      ['off', 'Off for all selected spaces'],
    ],
  );
  assert.equal(reloadPicker(v).props.value.label, 'Keep each space’s setting');
  v.change('Select', 'configuration-type', { value: '3' });
  await v.click('Next');
  await v.click('Review changes');
  assert.match(v.text(), /^Reload after saving\nKeep each space’s setting$/m);
  await v.click('Apply changes');
  assert.equal(f.state().data.status, 'complete', f.state().data.message);
  assert.equal(f.configs.get('1').data.refreshAfterSave, true);
  assert.equal(f.configs.get('2').data.refreshAfterSave, false);
  assert.equal(f.configs.get('7').data.refreshAfterSave, undefined);
});
test('one selected space words the keep choice for that space; on and off are reviewed', async () => {
  for (const [choice, review, expected] of [
    ['keep', 'Keep this space’s setting', true],
    ['on', 'On', true],
    ['off', 'Off', false],
  ]) {
    const f = batchFixture();
    f.configs.set('1', { revision: 1, data: { type: '3', refreshAfterSave: true } });
    const v = ui(f, [f.projects.get('1')]);
    await v.mount();
    assert.equal(reloadPicker(v).props.options[0].label, 'Keep this space’s setting');
    v.change('Select', 'configuration-type', { value: '3' });
    const option = reloadPicker(v).props.options.find((o) => o.value === choice);
    v.change('Select', 'configuration-reload', option);
    assert.equal(reloadPicker(v).props.value.value, choice);
    await v.click('Next');
    await v.click('Review changes');
    assert.ok(v.text().includes(`Reload after saving\n${review}\n`), v.text());
    await v.click('Apply changes');
    assert.equal(f.configs.get('1').data.refreshAfterSave, expected, choice);
  }
});
test('removing setup offers no reload choice', async () => {
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'unlink' });
  assert.equal(reloadPicker(v), undefined);
  assert.equal(v.nodes('HelperMessage').length, 0);
});
test('Apply to all gives each space the chosen types it has, and the review groups changes by space', async () => {
  const f = batchFixture();
  const bug = { id: '4', name: 'Bug', subtask: false, hierarchyLevel: 0 };
  f.types.push(bug);
  for (const id of ['1', '2']) f.projects.get(id).issueTypes.push(bug);
  f.configs.set('1', { revision: 1, data: { type: '3', screenTypes: ['4'] } });
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Next');
  assert.deepEqual(
    [...picker(v, '1').props.value].map((o) => o.value),
    ['4'],
  );
  assert.doesNotMatch(v.text(), /Was:/);
  const bulk = v.nodes('Select').find((n) => n.props.inputId === 'bulk-types');
  assert.deepEqual(
    [...bulk.props.options].map((o) => o.label),
    ['Task', 'Bug'],
  );
  v.change('Select', 'bulk-types', [
    { value: '3', label: 'Task' },
    { value: '4', label: 'Bug' },
  ]);
  await v.click('Apply to all');
  assert.deepEqual(
    [...picker(v, '1').props.value].map((o) => o.value),
    ['3', '4'],
  );
  assert.deepEqual(
    [...picker(v, '7').props.value].map((o) => o.value),
    ['3'],
  );
  assert.match(v.text(), /^Was: Bug$/m);
  assert.match(v.text(), /^Was: none · Bug isn’t in this space$/m);
  await v.click('Review changes');
  assert.match(
    v.text(),
    /^PR1 — Project 1\nPrompt type: Task → Prompt\nPrompt work type to Scheme 1/m,
  );
  assert.deepEqual(
    v
      .nodes('Lozenge')
      .slice(0, 2)
      .map((n) => [n.props.appearance, n.props.children.join('')]),
    [
      ['moved', 'Change'],
      ['success', 'Add'],
    ],
  );
  assert.match(v.text(), /Prompts of the old type stay where they’re already selected/);
  assert.match(v.text(), /Nothing else changes: work items, descriptions and workflows/);
  await v.click('Back');
  assert.deepEqual(
    [...picker(v, '7').props.value].map((o) => o.value),
    ['3'],
  );
  await v.click('Back');
  assert.equal(v.hasButton('Next'), true);
  assert.deepEqual(f.writes, []);
});

test('Next reads each space’s work types once; Review reviews the spaces', async () => {
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  const count = (name) => v.calls.filter((c) => c === name).length;
  await v.click('Next');
  assert.equal(count('configuration-options'), 3);
  assert.equal(count('configuration-preview'), 0);
  v.change('Select', 'bulk-types', [{ value: '3', label: 'Task' }]);
  await v.click('Apply to all');
  await v.click('Back');
  await v.click('Next');
  assert.equal(count('configuration-options'), 3);
  assert.equal(count('configuration-preview'), 0);
  assert.deepEqual(
    [...picker(v, '1').props.value].map((o) => o.value),
    ['3'],
  );
  await v.click('Review changes');
  assert.equal(count('configuration-preview'), 3);
  // The work types offered do not depend on the prompt type: another one leaves the prompt type
  // out of the pickers without reading the spaces again, and only Review reviews them.
  await v.click('Back');
  await v.click('Back');
  v.change('Select', 'configuration-mode', { value: 'existing' });
  v.change('Select', 'configuration-type', { value: '3' });
  await v.click('Next');
  assert.equal(count('configuration-options'), 3);
  assert.equal(count('configuration-preview'), 3);
  assert.ok(![...picker(v, '1').props.options].some((o) => o.value === '3'));
  await v.click('Review changes');
  assert.equal(count('configuration-preview'), 6);
});
test('editing the new type’s name does not read the spaces again', async () => {
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Promt' } });
  const count = (name) => v.calls.filter((c) => c === name).length;
  await v.click('Next');
  assert.equal(count('configuration-options'), 3);
  await v.click('Back');
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Next');
  assert.equal(count('configuration-options'), 3);
  assert.equal(count('configuration-preview'), 0);
  await v.click('Review changes');
  assert.equal(count('configuration-preview'), 3);
  assert.match(v.text(), /Prompt/);
});
test('a space whose work types could not be read keeps the dialog on the first step; Next reads only that space', async () => {
  const f = batchFixture();
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  const count = (name) => v.calls.filter((c) => c === name).length;
  const project = f.p.project;
  f.p.project = async (id) => {
    if (id === '2') throw Error('Space unavailable');
    return project(id);
  };
  await v.click('Next');
  assert.equal(count('configuration-options'), 3);
  assert.equal(v.hasButton('Review changes'), false);
  assert.match(v.text(), /Work types could not be read for PR2 — Project 2: Space unavailable/);
  f.p.project = project;
  await v.click('Next');
  assert.equal(count('configuration-options'), 4);
  assert.equal(v.hasButton('Review changes'), true);
  assert.deepEqual(f.writes, []);
});

/** Makes `ids` team-managed spaces with their own Prompt and Task work types, and returns the
 * selection the health view passes. */
function teamManaged(f, ids) {
  for (const id of ids)
    Object.assign(f.projects.get(id), {
      style: 'next-gen',
      issueTypes: [
        { id: `${id}0`, name: 'Prompt', subtask: false, hierarchyLevel: 0 },
        { id: `${id}1`, name: 'Task', subtask: false, hierarchyLevel: 0 },
      ],
    });
  return [...f.projects.values()].map((p) => ({
    id: p.id,
    key: p.key,
    name: p.name,
    teamManaged: ids.includes(p.id),
  }));
}
test('team-managed spaces are configured on one screen, then confirmed and saved', async () => {
  const f = batchFixture(['7', '8']);
  const selected = teamManaged(f, ['7', '8']);
  f.configs.set('7', { revision: 1, data: { type: '70' } });
  const v = ui(f, selected);
  await v.mount();
  assert.match(v.text('ModalTitle'), /Configure 2 team-managed spaces/);
  assert.equal(v.nodes('ProgressTracker').length, 0);
  assert.equal(
    v.nodes('Select').some((n) => n.props.inputId === 'configuration-mode'),
    false,
  );
  assert.equal(v.calls.includes('configuration-catalog'), false);
  assert.equal(v.hasButton('Next'), false);
  assert.equal(
    v.nodes('Select').find((n) => n.props.inputId === 'prompt-type-7').props.value.value,
    '70',
  );
  assert.equal(v.disabled('Review changes'), true);
  v.change('Select', 'prompt-type-8', { value: '81', label: 'Task' });
  await v.click('Review changes');
  assert.match(v.text('Heading'), /Confirm changes/);
  assert.match(v.text(), /Prompt type: Task/);
  assert.match(v.text(), /Nothing in these spaces’ Jira settings changes/);
  assert.deepEqual(
    v.payloads.find((p) => p.name === 'configuration-preview' && p.payload.projectId === '8')
      .payload,
    { projectId: '8', type: '81', reloadAfterSave: 'keep' },
  );
  assert.equal(v.hasButton('Apply changes'), false);
  await v.click('Save changes');
  const start = v.payloads.find((p) => p.name === 'configuration-start').payload;
  assert.equal('type' in start || 'name' in start, false);
  assert.deepEqual(
    start.entries.map((entry) => ({ ...entry, fingerprint: undefined })),
    [
      { projectId: '7', type: '70', fingerprint: undefined },
      { projectId: '8', type: '81', fingerprint: undefined },
    ],
  );
  assert.equal(f.state().data.status, 'complete');
  assert.deepEqual(f.configs.get('8').data, { type: '81', previousTypes: [] });
  assert.deepEqual(f.writes, []);
});
test('a team-managed space changes its saved type, or removes setup behind its own confirmation', async () => {
  const f = batchFixture(['7']);
  const selected = teamManaged(f, ['7']);
  f.configs.set('7', { revision: 1, data: { type: '70' } });
  const v = ui(f, selected);
  await v.mount();
  assert.equal(v.disabled('Review changes'), false);
  v.change('Select', 'prompt-type-7', { value: '71', label: 'Task' });
  assert.match(v.text(), /Was: Prompt\./);
  await v.click('Remove setup…');
  assert.match(v.text('Heading'), /Remove setup\?/);
  assert.match(v.text(), /Work items keep the prompts already selected on them/);
  assert.deepEqual(v.payloads.findLast((p) => p.name === 'configuration-preview').payload, {
    projectId: '7',
    unlink: true,
  });
  assert.equal(v.button('Remove setup').props.appearance, 'danger');
  // Back leaves the removal: the space's own type choice is reviewed again.
  await v.click('Back');
  assert.equal(v.hasButton('Remove setup'), false);
  await v.click('Review changes');
  assert.match(v.text('Heading'), /Confirm changes/);
  assert.match(v.text(), /Prompt type: Prompt → Task/);
  await v.click('Save changes');
  assert.deepEqual(f.configs.get('7').data, { type: '71', previousTypes: ['70'] });
  assert.deepEqual(f.writes, []);
});
test('a team-managed space’s setup is removed after its confirmation', async () => {
  const f = batchFixture(['7']);
  const selected = teamManaged(f, ['7']);
  f.configs.set('7', { revision: 1, data: { type: '70' } });
  const v = ui(f, selected);
  await v.mount();
  await v.click('Remove setup…');
  await v.click('Remove setup');
  assert.equal(f.state().data.status, 'complete');
  assert.equal(f.configs.get('7').data.type, undefined);
  assert.deepEqual(f.writes, []);
});
test('a team-managed space whose saved type was deleted can still have its setup removed', async () => {
  const f = batchFixture(['7']);
  const selected = teamManaged(f, ['7']);
  f.configs.set('7', { revision: 1, data: { type: '99' } });
  const v = ui(f, selected);
  await v.mount();
  // The deleted type is not offered as the choice, but the space is still set up.
  assert.equal(
    v.nodes('Select').find((n) => n.props.inputId === 'prompt-type-7').props.value,
    null,
  );
  assert.match(
    v.text(),
    /Was: Work type ID 99, which is no longer one of this space’s standard work types\./,
  );
  assert.equal(v.disabled('Review changes'), true);
  await v.click('Remove setup…');
  assert.match(v.text('Heading'), /Remove setup\?/);
  await v.click('Remove setup');
  assert.equal(f.state().data.status, 'complete');
  assert.deepEqual(f.configs.get('7').data, { previousTypes: ['99'] });
  assert.deepEqual(f.writes, []);
});
test('removing setup leaves out a selected team-managed space that has none', async () => {
  const f = batchFixture(['7', '8']);
  const selected = teamManaged(f, ['7', '8']);
  f.configs.set('7', { revision: 1, data: { type: '70' } });
  const v = ui(f, selected);
  await v.mount();
  await v.click('Remove setup…');
  assert.match(v.text(), /No setup to remove; this space is left out\./);
  await v.click('Remove setup');
  const start = v.payloads.find((p) => p.name === 'configuration-start').payload;
  assert.deepEqual(
    start.entries.map((e) => e.projectId),
    ['7'],
  );
  assert.match(v.text(), /Setup removed from 1 of 1 spaces\./);
  assert.equal(f.configs.has('8'), false);
  assert.deepEqual(f.configs.get('7').data, { previousTypes: ['70'] });
});
test('removing setup from company-managed spaces that have none offers nothing to apply', async () => {
  const f = batchFixture(['1', '2']);
  const v = ui(f);
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'unlink' });
  await v.click('Review changes');
  assert.match(v.text(), /None of the selected spaces has setup to remove\./);
  assert.equal(v.hasButton('Apply changes'), false);
  assert.equal(await f.api.status(), null);
});
test('a team-managed space whose work types could not be read is read again on request', async () => {
  const f = batchFixture(['7', '8']);
  const selected = teamManaged(f, ['7', '8']);
  f.optionsFailure = new Set(['8']);
  const v = ui(f, selected);
  await v.mount();
  assert.match(v.text(), /Work types could not be read for .*: Work types unavailable/);
  assert.equal(v.hasButton('Review changes'), false);
  const reads = () => v.payloads.filter((p) => p.name === 'configuration-options');
  assert.equal(reads().length, 2);
  await v.click('Read work types again');
  // Only the space that failed is read again.
  assert.deepEqual(
    reads()
      .slice(2)
      .map((p) => p.payload.projectId),
    ['8'],
  );
  assert.equal(v.hasButton('Read work types again'), false);
  v.change('Select', 'prompt-type-7', { value: '70', label: 'Prompt' });
  v.change('Select', 'prompt-type-8', { value: '80', label: 'Prompt' });
  await v.click('Review changes');
  assert.match(v.text('Heading'), /Confirm changes/);
});
test('a team-managed space with no saved setup offers no removal', async () => {
  const f = batchFixture(['7']);
  const v = ui(f, teamManaged(f, ['7']));
  await v.mount();
  assert.equal(v.hasButton('Remove setup…'), false);
  assert.equal(v.disabled('Review changes'), true);
});
/** Opens the Review step for a new type named Prompt. */
async function reviewNew(v) {
  await v.mount();
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Next');
  await v.click('Review changes');
}
test('a review that failed is not shown as blocked and can be retried on the Review step', async () => {
  const f = batchFixture();
  const preview = f.api.preview;
  const reviews = [];
  let failures = 1;
  f.api.preview = async (actor, projectId, input) => {
    reviews.push(projectId);
    if (projectId === '2' && failures-- > 0)
      throw Error(
        'The spaces using the screen Default could not all be read in time. Review this space again.',
      );
    return preview(actor, projectId, input);
  };
  const v = ui(f);
  await reviewNew(v);
  assert.match(
    v.text(),
    /^Could not be reviewed: The spaces using the screen Default could not all be read in time\. Review this space again\.$/m,
  );
  assert.doesNotMatch(v.text(), /Blocked/);
  assert.match(v.text(), /Review changes tries the spaces that could not be reviewed again/);
  assert.equal(v.hasButton('Apply changes'), false);
  // Review changes on the Review step reviews only the space that failed.
  reviews.length = 0;
  await v.click('Review changes');
  assert.deepEqual(reviews, ['2']);
  assert.doesNotMatch(v.text(), /Could not be reviewed/);
  assert.equal(v.disabled('Apply changes'), false);
  assert.deepEqual(f.writes, []);
});
test('excluding is not offered when it would leave no space to configure', async () => {
  const f = batchFixture(['1']);
  f.schemes.get('1').isDefault = true;
  const v = ui(f);
  await reviewNew(v);
  assert.match(v.text(), /Could not be reviewed: .*default work type scheme/);
  assert.equal(v.hasButton('Exclude unreviewed spaces'), false);
  assert.doesNotMatch(v.text(), /exclude/i);
  assert.equal(v.hasButton('Apply changes'), false);
  assert.match(v.text('ModalTitle'), /^Configure 1 space$/);
});
test('Check saved progress reads only and does not say it is applying changes', async () => {
  const f = batchFixture();
  f.statusFailure = true;
  const v = ui(f);
  await v.mount();
  f.statusFailure = false;
  const status = f.api.status;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  f.api.status = async (...args) => {
    await pending;
    return status(...args);
  };
  v.button('Check saved progress').props.onClick();
  v.render();
  assert.equal(v.nodes('Spinner').length, 1);
  const during = v.text();
  release();
  await v.settle();
  assert.match(during, /Checking configuration…/);
  assert.doesNotMatch(during, /Applying reviewed configuration/);
  assert.equal(v.nodes('SectionMessage').length, 0);
});
test('after a lost step response the space in flight needs inspection, not configuration', async () => {
  const f = batchFixture();
  const v = ui(f, [f.projects.get('1'), f.projects.get('2')]);
  await reviewNew(v);
  const advance = f.api.advance;
  let lost = true;
  f.api.advance = async (...args) => {
    const value = await advance(...args);
    if (lost) {
      lost = false;
      throw Error('Response lost');
    }
    return value;
  };
  await v.click('Apply changes');
  assert.match(v.text(), /Response lost/);
  // Jira and storage have the first space configured; the dialog's last record does not.
  assert.equal(f.state().data.entries[0].status, 'done');
  const table = v.nodes('DynamicTable').find((t) => t.props.label === 'Configuration results');
  const cells = table.props.rows.map((row) =>
    [row.cells[1].content.props.children].flat().join(''),
  );
  assert.deepEqual(cells, ['Outcome needs inspection', 'Not yet configured']);
});
test('dialog outcome messages are announced in a status region mounted before them', async () => {
  const f = batchFixture();
  f.dropStart = true;
  const v = ui(f);
  await v.mount();
  const text = (node) =>
    Array.isArray(node)
      ? node.map(text).join('')
      : node && typeof node === 'object'
        ? text(node.props?.children)
        : typeof node === 'string'
          ? node
          : '';
  const status = () => {
    const regions = v.nodes('Box').filter((box) => box.props.role === 'status');
    assert.equal(regions.length, 1);
    return text(regions[0]);
  };
  assert.equal(status(), '');
  v.change('Select', 'configuration-mode', { value: 'create' });
  v.change('Textfield', 'configuration-name', { target: { value: 'Prompt' } });
  await v.click('Next');
  await v.click('Review changes');
  await v.click('Apply changes');
  assert.match(status(), /Response lost/);
});
test('a team-managed space still needing a type on another page is named', async () => {
  const ids = ['1', '2', '3', '4', '5', '6'];
  const f = batchFixture(ids);
  const selected = teamManaged(f, ids);
  for (const id of ids.slice(0, 5)) f.configs.set(id, { revision: 1, data: { type: `${id}0` } });
  const v = ui(f, selected);
  await v.mount();
  assert.equal(v.disabled('Review changes'), true);
  // Spaces 1 to 5 are on the first page, all with a type; space 6 is on the second.
  assert.match(v.text(), /^A prompt work type is still needed for PR6 — Project 6\.$/m);
  await v.click('Next spaces');
  assert.doesNotMatch(v.text(), /still needed/);
  v.change('Select', 'prompt-type-6', { value: '60', label: 'Prompt' });
  await v.click('Previous spaces');
  assert.doesNotMatch(v.text(), /still needed/);
  assert.equal(v.disabled('Review changes'), false);
});
