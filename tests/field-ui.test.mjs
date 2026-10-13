import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultExport, hookHost, load, view } from './support/ui-harness.mjs';
function fixture({
  committed = false,
  disappear = false,
  success = false,
  refreshAfterSave = false,
  reloadFails = false,
  loadFails = false,
  searchError,
  loadWarning,
  firstLoadFails,
  failLoads = [],
  saveStatus = { pending: false },
} = {}) {
  const calls = [];
  let loads = 0;
  const search = {
    items: [],
    query: '',
    busy: false,
    error: '',
    reset(page) {
      // Like the real hook, a reset returns to the initial suggestions.
      search.query = '';
      search.items = page.prompts;
      search.error = page.searchError ?? '';
    },
    change(value) {
      calls.push({ name: 'search', value });
      search.query = value;
    },
    refresh() {
      calls.push({ name: 'retrySearch' });
    },
    more() {},
  };
  const call = async (name, payload) => {
    calls.push({ name, payload });
    if (name === 'save') {
      if (success) return { ids: payload.ids, revision: 3, fingerprint: 'v3' };
      throw Error('TEST-2: This prompt is not ready to link.');
    }
    if (name === 'save-status') return saveStatus;
    assert.equal(name, 'load');
    loads++;
    if ((loadFails && loads === 2) || failLoads.includes(loads)) throw Error('Load failed');
    if (firstLoadFails && loads === 1) throw Error(firstLoadFails);
    return {
      ids: committed && loads > 1 ? ['1', '2'] : ['1'],
      prompts:
        disappear && loads > 1
          ? []
          : [
              { id: '1', key: 'TEST-1', name: 'Saved' },
              { id: '2', key: 'TEST-2', name: 'Draft' },
            ],
      revision: loads,
      fingerprint: `v${loads}`,
      incomplete: false,
      ...(searchError ? { incomplete: true, searchError } : {}),
      ...(loadWarning ? { loadWarning } : {}),
      cleanupOnly: false,
      refreshAfterSave,
    };
  };
  const hooks = hookHost();
  const { Field } = load('field.tsx', {
    react: hooks.react,
    '@atlaskit/button/new': defaultExport('Button'),
    '@atlaskit/select': defaultExport('Select'),
    '@atlaskit/spinner': defaultExport('Spinner'),
    './prompt-search': { usePromptSearch: () => search },
    './save-recovery-ui': { SaveRecovery: 'SaveRecovery' },
    '@forge/bridge': {
      router: {
        reload: async () => {
          calls.push({ name: 'reload' });
          if (reloadFails) throw Error('Reload failed');
        },
      },
    },
    './client': { call },
  });
  const v = view(hooks, Field);
  return {
    ...v,
    calls,
    results(items) {
      search.items = items;
      v.render();
    },
    select(ids) {
      v.nodes('Select')[0].props.onChange(ids.map((value) => ({ value })));
      v.render();
    },
    async recover() {
      await v.nodes('SaveRecovery')[0].props.onRecovered();
      v.render();
    },
    text: () => v.text('p'),
    selected: () => Array.from(v.nodes('Select')[0].props.value, (value) => value?.value),
  };
}
test('failed save recovery preserves draft and existing saved selection; only explicit discard resets selection', async () => {
  const f = fixture();
  await f.mount();
  f.select(['1', '2']);
  assert.match(f.text(), /Unsaved changes/);
  await f.click('Save');
  assert.deepEqual(f.selected(), ['1', '2']);
  assert.match(f.text(), /not ready to link/);
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['load', 'save', 'load'],
  );
  await f.click('Discard changes');
  assert.deepEqual(f.selected(), ['1']);
  assert.equal(f.calls.length, 3);
});
test('an empty space and an unmatched search each show one accurate message', async () => {
  const f = fixture();
  await f.mount();
  f.results([]);
  assert.match(f.text(), /No prompts in this space yet\./);
  assert.doesNotMatch(f.text(), /No matching prompts|Newest prompts/);
  f.nodes('Select')[0].props.onInputChange('review', { action: 'input-change' });
  f.results([]);
  assert.match(f.text(), /No matching prompts/);
  assert.doesNotMatch(f.text(), /No prompts in this space yet|Newest prompts/);
});
test('failed discovery shows retry while preserving selected prompts and explicit removal', async () => {
  const f = fixture({ success: true, searchError: 'Could not load prompt suggestions.' });
  await f.mount();
  assert.match(f.text(), /Could not load prompt suggestions/);
  assert.doesNotMatch(f.text(), /No matching prompts|Newest prompts/);
  assert.deepEqual(f.selected(), ['1']);
  assert.equal(f.nodes('Select')[0].props.isDisabled, false);
  await f.click('Retry search');
  assert.equal(f.calls.filter((call) => call.name === 'retrySearch').length, 1);
  f.select([]);
  await f.click('Save');
  assert.deepEqual(Array.from(f.calls.find((call) => call.name === 'save').payload.ids), []);
  assert.match(f.text(), /Saved\./);
});
test('an unavailable reload preference shows manual reload guidance without blocking removal', async () => {
  const f = fixture({
    success: true,
    loadWarning:
      'The work item reload preference could not be checked. Reload the work item manually after saving.',
  });
  await f.mount();
  assert.match(f.text(), /Reload the work item manually after saving/);
  assert.equal(f.nodes('Select')[0].props.isDisabled, false);
  f.select([]);
  await f.click('Save');
  assert.match(f.text(), /Saved\./);
  assert.match(f.text(), /Reload the work item manually after saving/);
  assert.equal(f.calls.filter((call) => call.name === 'reload').length, 0);
});
test('lost save response reconciles committed selection without repeating the write or reloading', async () => {
  // Even with the reload preference on, a save known only by reading it back is not reloaded.
  const f = fixture({ committed: true, refreshAfterSave: true });
  await f.mount();
  f.select(['1', '2']);
  await f.click('Save');
  assert.deepEqual(f.selected(), ['1', '2']);
  assert.match(f.text(), /Saved\. Reload the work item to see the updated description\./);
  assert.ok(f.nodes('Button').find((b) => b.props.children.join('') === 'Save').props.isDisabled);
  assert.ok(!f.nodes('Button').find((b) => b.props.children.join('') === 'Sync').props.isDisabled);
  assert.equal(f.calls.filter((c) => c.name === 'save').length, 1);
  assert.equal(f.calls.filter((c) => c.name === 'reload').length, 0);
});
test('recovery keeps unavailable draft choices visible instead of passing undefined options', async () => {
  const f = fixture({ disappear: true });
  await f.mount();
  f.select(['1', '2']);
  await f.click('Save');
  assert.deepEqual(f.selected(), ['1', '2']);
  assert.ok(
    f.nodes('Select')[0].props.value.every((v) => v.label.startsWith('Unavailable prompt')),
  );
});

test('Sync sends saved IDs without changing selection; unsaved choices disable it', async () => {
  const f = fixture();
  await f.mount();
  await f.click('Sync');
  assert.deepEqual(Array.from(f.calls[1].payload.ids), ['1']);
  assert.deepEqual(f.selected(), ['1']);
  assert.match(f.text(), /not ready to link/);
  assert.doesNotMatch(f.text(), /Synced/);
  f.select(['1', '2']);
  assert.ok(f.nodes('Button').find((b) => b.props.children.join('') === 'Sync').props.isDisabled);
});

test('a failed Sync shows a newer selection saved elsewhere instead of a stale draft', async () => {
  const f = fixture({ committed: true });
  await f.mount();
  await f.click('Sync');
  assert.deepEqual(f.selected(), ['1', '2']);
  assert.doesNotMatch(f.text(), /Unsaved changes/);
  assert.equal(f.button('Save').props.isDisabled, true);
});

test('a recovery check without a draft shows the selection saved now', async () => {
  const f = fixture({ committed: true, loadFails: true });
  await f.mount();
  await f.click('Sync');
  assert.equal(f.nodes('SaveRecovery').length, 1);
  await f.recover();
  assert.deepEqual(f.selected(), ['1', '2']);
  assert.doesNotMatch(f.text(), /Unsaved changes/);
});

test('recovery after a later failed save starts from a fresh check, not an earlier status', async () => {
  const pending = { pending: true, administrator: true, unchanged: true, revision: 1 };
  const f = fixture({ firstLoadFails: 'Unresolved save.', saveStatus: pending, failLoads: [3] });
  await f.mount();
  assert.deepEqual(f.nodes('SaveRecovery')[0].props.initialStatus, pending);
  await f.recover();
  f.select(['1', '2']);
  await f.click('Save');
  assert.match(f.text(), /Could not verify/);
  assert.equal(f.nodes('SaveRecovery')[0].props.initialStatus, undefined);
});

test('the open menu says why it is empty: failed discovery, no match or no prompts yet', async () => {
  const failed = fixture({ searchError: 'Could not load prompt suggestions.' });
  await failed.mount();
  failed.results([]);
  assert.equal(
    failed.nodes('Select')[0].props.noOptionsMessage(),
    'Could not load prompt suggestions.',
  );
  const f = fixture();
  await f.mount();
  f.results([]);
  assert.equal(f.nodes('Select')[0].props.noOptionsMessage(), 'No prompts in this space yet.');
  f.nodes('Select')[0].props.onInputChange('review', { action: 'input-change' });
  assert.equal(f.nodes('Select')[0].props.noOptionsMessage(), 'No matching prompts');
});

test('compact field reloads only after confirmed saves when enabled; reload failure stays saved', async () => {
  for (const refreshAfterSave of [false, true]) {
    for (const reloadFails of [false, true]) {
      const f = fixture({ success: true, refreshAfterSave, reloadFails });
      await f.mount();
      f.select(['1', '2']);
      await f.click('Save');
      assert.equal(f.calls.filter((c) => c.name === 'reload').length, refreshAfterSave ? 1 : 0);
      assert.match(f.text(), /Saved\./);
      assert.equal(f.nodes('Select')[0].props.isDisabled, false);
    }
  }
});
test('unverified write blocks further saves and exposes explicit saved-state recovery', async () => {
  const f = fixture({ loadFails: true, refreshAfterSave: true });
  await f.mount();
  f.select(['1', '2']);
  await f.click('Save');
  assert.match(f.text(), /Could not verify/);
  assert.equal(f.nodes('Select')[0].props.isDisabled, true);
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['load', 'save', 'load'],
  );
  assert.equal(f.nodes('Button').length, 0);
  assert.equal(f.nodes('SaveRecovery').length, 1);
  await f.recover();
  assert.deepEqual(f.selected(), ['1', '2']);
  assert.match(f.text(), /Unsaved changes/);
  assert.equal(f.nodes('Select')[0].props.isDisabled, false);
  assert.equal(f.nodes('SaveRecovery').length, 0);
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['load', 'save', 'load', 'load'],
  );
});

test('draft selections retain labels across search result replacement and save by ID', async () => {
  const f = fixture({ success: true });
  await f.mount();
  f.results([{ id: '3', key: 'TEST-3', name: 'Older result' }]);
  f.select(['1', '3']);
  f.results([{ id: '4', key: 'TEST-4', name: 'Next page' }]);
  assert.deepEqual(f.selected(), ['1', '3']);
  assert.ok(f.nodes('Select')[0].props.value.some((v) => v.label === 'TEST-3 — Older result'));
  await f.click('Save');
  assert.deepEqual(Array.from(f.calls.find((c) => c.name === 'save').payload.ids), ['1', '3']);
});

test('the dropdown owns remote search; blur, menu close and selection events preserve its query', async () => {
  const f = fixture();
  await f.mount();
  assert.equal(f.nodes('Textfield').length, 0);
  const picker = f.nodes('Select')[0].props;
  assert.equal(picker.isSearchable, true);
  assert.equal(picker.filterOption, null);
  picker.onInputChange('review code', { action: 'input-change' });
  for (const action of ['input-blur', 'menu-close', 'set-value'])
    picker.onInputChange('', { action });
  assert.deepEqual(
    f.calls.filter((c) => c.name === 'search'),
    [{ name: 'search', value: 'review code' }],
  );
  f.results([]);
  assert.equal(f.nodes('Select')[0].props.inputValue, 'review code');
  assert.deepEqual(f.selected(), ['1']);
  f.nodes('Select')[0].props.onInputChange('x'.repeat(201), { action: 'input-change' });
  assert.equal(f.calls.at(-1).value.length, 200);
});

test('the status regions exist before any outcome and announce search and save results', async () => {
  const f = fixture({ success: true });
  await f.mount();
  // Two live regions from the first render: search outcomes first, save outcomes last.
  const regions = () => f.nodes('p').filter((p) => p.props.role === 'status');
  const said = (region) => [region.props.children].flat().join('');
  assert.equal(regions().length, 2);
  assert.deepEqual(regions().map(said), ['', '']);
  f.select(['1', '2']);
  await f.click('Save');
  assert.deepEqual(regions().map(said), ['', 'Saved.']);
  const failed = fixture({ searchError: 'Could not load prompt suggestions.' });
  await failed.mount();
  const announced = failed.nodes('p').filter((p) => p.props.role === 'status');
  assert.equal(said(announced[0]), 'Could not load prompt suggestions.');
});

test('a load failure without an unresolved save offers Try again instead of saved-state recovery', async () => {
  const f = fixture({ firstLoadFails: 'Add the Agent Prompts field to this work item’s screen.' });
  await f.mount();
  assert.equal(f.nodes('SaveRecovery').length, 0);
  assert.match(f.text(), /Add the Agent Prompts field/);
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['load', 'save-status'],
  );
  await f.click('Try again');
  assert.ok(f.nodes('Select').length);
  assert.equal(f.button('Try again'), undefined);
});

test('a load failure caused by an unresolved save opens recovery with its status', async () => {
  const pending = { pending: true, administrator: false, unchanged: false, revision: 3 };
  const f = fixture({
    firstLoadFails: 'The previous save could not be verified.',
    saveStatus: pending,
  });
  await f.mount();
  const recovery = f.nodes('SaveRecovery');
  assert.equal(recovery.length, 1);
  assert.deepEqual(recovery[0].props.initialStatus, pending);
  assert.equal(f.button('Try again'), undefined);
});

test('the picker stops at five prompts and says how to add another', async () => {
  const f = fixture();
  await f.mount();
  f.select(['1', '2', '3', '4', '5']);
  const select = f.nodes('Select')[0];
  assert.equal(select.props.isOptionDisabled({ value: '6' }), true);
  assert.equal(select.props.isOptionDisabled({ value: '3' }), false);
  assert.match(f.text(), /5\/5 selected.*Remove a prompt to add another/);
  f.select(['1', '2', '3', '4']);
  assert.equal(f.nodes('Select')[0].props.isOptionDisabled({ value: '6' }), false);
});

test('a failed save keeps a typed query and refreshes its results', async () => {
  const f = fixture();
  await f.mount();
  f.nodes('Select')[0].props.onInputChange('draft', { action: 'input-change' });
  f.render();
  f.select(['1', '2']);
  await f.click('Save');
  assert.equal(f.nodes('Select')[0].props.inputValue, 'draft');
  assert.ok(f.calls.some((c) => c.name === 'retrySearch'));
  assert.match(f.text(), /not ready to link/);
});

test('the spinner says prompts are saving during a save', async () => {
  const f = fixture({ success: true });
  await f.mount();
  f.select(['1', '2']);
  const saving = f.click('Save');
  f.render();
  assert.equal(f.nodes('Spinner')[0]?.props.label, 'Saving prompts');
  await saving;
  assert.equal(f.nodes('Spinner').length, 0);
});
