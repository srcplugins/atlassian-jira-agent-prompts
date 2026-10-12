import test from 'node:test';
import assert from 'node:assert/strict';
import { hookHost, load, turns } from './support/ui-harness.mjs';
function fixture() {
  const requests = [];
  const hooks = hookHost();
  const { usePromptSearch } = load('prompt-search.ts', {
    react: hooks.react,
    './client': {
      call: (name, payload) =>
        new Promise((resolve, reject) => requests.push({ name, payload, resolve, reject })),
    },
  });
  let hook;
  const render = () => {
    hook = hooks.render(() => usePromptSearch('picker'));
  };
  render();
  hooks.effects.forEach((fn) => fn());
  return {
    requests,
    render,
    get hook() {
      return hook;
    },
    async settle() {
      await turns();
      render();
    },
  };
}
const row = (id) => ({ id, key: `TEST-${id}`, name: `Prompt ${id}` });
test('search ignores stale responses and paginates without duplicates or resetting the query', async () => {
  const f = fixture();
  f.hook.change('old', true);
  f.render();
  f.hook.change('new', true);
  f.render();
  f.requests[1].resolve({ prompts: [row('2')], nextCursor: 'next', incomplete: true });
  await f.settle();
  f.requests[0].resolve({ prompts: [row('1')], incomplete: false });
  await f.settle();
  assert.deepEqual(
    Array.from(f.hook.items, (p) => p.id),
    ['2'],
  );
  const next = f.hook.more();
  assert.equal(f.requests[2].payload.cursor, 'next');
  assert.equal(f.requests[2].payload.query, 'new');
  f.requests[2].resolve({ prompts: [row('2'), row('3')], incomplete: false });
  await next;
  f.render();
  assert.deepEqual(
    Array.from(f.hook.items, (p) => p.id),
    ['2', '3'],
  );
  assert.equal(f.hook.nextCursor, undefined);
});
test('a failed page preserves loaded results and the cursor for explicit retry', async () => {
  const f = fixture();
  f.hook.reset({ prompts: [row('1')], nextCursor: 'next', incomplete: true });
  f.render();
  const next = f.hook.more();
  f.requests[0].reject(Error('Denied'));
  await next;
  f.render();
  assert.equal(f.hook.error, 'Denied');
  assert.equal(f.hook.nextCursor, 'next');
  assert.equal(f.hook.items.length, 1);
});
test('a failed initial discovery keeps its explicit error until an independent search succeeds', async () => {
  const f = fixture();
  f.hook.reset({ prompts: [row('1')], incomplete: true, searchError: 'Suggestions unavailable.' });
  f.render();
  assert.equal(f.hook.error, 'Suggestions unavailable.');
  assert.equal(f.hook.items.length, 1);
  assert.equal(f.hook.nextCursor, undefined);
  f.hook.refresh();
  f.requests[0].resolve({ prompts: [row('2')], incomplete: false });
  await f.settle();
  assert.equal(f.hook.error, '');
  assert.deepEqual(
    Array.from(f.hook.items, (p) => p.id),
    ['2'],
  );
});
test('typing is debounced and clearing invalidates an in-flight search', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.hook.change('a');
  f.hook.change('ab');
  f.hook.change('abc');
  assert.equal(f.requests.length, 0);
  t.mock.timers.tick(300);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].payload.query, 'abc');
  f.hook.change('', true);
  f.requests[0].resolve({ prompts: [row('8')], incomplete: false });
  f.requests[1].resolve({ prompts: [row('9')], incomplete: false });
  await f.settle();
  assert.equal(f.hook.query, '');
  assert.deepEqual(
    Array.from(f.hook.items, (p) => p.id),
    ['9'],
  );
});
