// App-owned UI test harness. It runs the real component code with a
// tiny hook host and string stand-ins for library components. It does not establish Forge
// rendering, layout or accessibility, and effects run once on mount without cleanup.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compiled = new Map();
function compile(file) {
  if (!compiled.has(file))
    compiled.set(
      file,
      ts.transpileModule(readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8'), {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.React,
          esModuleInterop: true,
        },
      }).outputText,
    );
  return compiled.get(file);
}

/**
 * Evaluate a `src/` module in a fresh context. Only the listed imports resolve; anything else
 * fails closed. Host Error keeps `instanceof Error` true across modules, and timers resolve at call
 * time so node:test mock timers apply. `globals` adds browser stand-ins such as `document`.
 */
// App modules every component may use without a per-test stand-in.
const builtIns = { './shared/latch.mjs': await import('../../src/shared/latch.mjs') };

export function load(file, dependencies = {}, globals = {}) {
  dependencies = { ...builtIns, ...dependencies };
  const exports = {};
  runInNewContext(compile(file), {
    ...globals,
    exports,
    Error,
    Date,
    setTimeout: (handler, ms, ...rest) => setTimeout(handler, ms, ...rest),
    clearTimeout: (id) => clearTimeout(id),
    require: (name) => {
      if (!Object.hasOwn(dependencies, name))
        throw Error(`Unexpected dependency of ${file}: ${name}`);
      return dependencies[name];
    },
  });
  return exports;
}

/** The real `src/client.ts` wired to a fake `@forge/bridge` invoke. */
export const bridgeClient = (invoke) => load('client.ts', { '@forge/bridge': { invoke } });

/** Library components rendered as their names, e.g. `standIns('Button', 'Text')`. */
export const standIns = (...names) => Object.fromEntries(names.map((name) => [name, name]));

/** A module whose default export is a stand-in, e.g. `@atlaskit/button/new`. */
export const defaultExport = (value) => ({ __esModule: true, default: value });

export async function turns(count = 10) {
  for (let i = 0; i < count; i++) await new Promise(setImmediate);
}

/**
 * Hook host keyed by call order: state (including functional updates), refs, identity callbacks
 * and effects that are queued once on first render. Call `render` to evaluate with a fresh order.
 * `rerun(n)` runs the latest render's nth effect again, as React does when its dependencies change.
 */
export function hookHost() {
  const slots = [];
  const effects = [];
  const latest = [];
  let index = 0;
  let effect = 0;
  const react = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = initial;
      return [
        slots[slot],
        (value) => {
          slots[slot] = typeof value === 'function' ? value(slots[slot]) : value;
        },
      ];
    },
    useRef(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot];
    },
    useEffect(fn) {
      const slot = index++;
      latest[effect++] = fn;
      if (!(slot in slots)) {
        slots[slot] = true;
        effects.push(fn);
      }
    },
    useCallback: (fn) => fn,
  };
  return {
    react: { __esModule: true, default: react, ...react },
    effects,
    rerun: (n) => latest[n](),
    render(fn) {
      index = 0;
      effect = 0;
      return fn();
    },
  };
}

/** Text content of an element, including nested arrays of children. */
const label = (node) => node.props.children.flat(Infinity).join('');

/**
 * Render a component through `hooks` and expose the queries the UI tests share. `nodes` also walks
 * DynamicTable head and row cells. Click handlers start background work, so `click` and `mount`
 * let it settle before re-rendering.
 */
export function view(hooks, component) {
  let tree;
  const render = () => {
    tree = hooks.render(component);
  };
  const nodes = (type) => {
    const types = [type].flat();
    const found = [];
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== 'object') return;
      if (types.includes(value.type)) found.push(value);
      visit(value.props?.children);
      for (const cell of value.props?.head?.cells ?? []) visit(cell.content);
      for (const row of value.props?.rows ?? []) for (const cell of row.cells) visit(cell.content);
    };
    visit(tree);
    return found;
  };
  // UI Kit's LoadingButton is a button that can also show that its action is running.
  const buttons = () => nodes(['Button', 'LoadingButton']);
  const button = (text) => buttons().find((node) => label(node) === text);
  async function settle() {
    await turns();
    render();
  }
  render();
  return {
    render,
    nodes,
    button,
    settle,
    labels: () => buttons().map(label),
    text: (type = 'Text') => nodes(type).map(label).join('\n'),
    async mount() {
      for (const effect of hooks.effects.splice(0)) effect();
      await settle();
    },
    async click(text) {
      const node = button(text);
      assert.ok(node, `Missing button: ${text}`);
      assert.ok(!node.props.isDisabled && !node.props.isLoading, `Disabled button: ${text}`);
      node.props.onClick();
      await settle();
    },
    change(type, match, event) {
      const matches =
        typeof match === 'function'
          ? match
          : (node) => [node.props.inputId, node.props.id, node.props.label].includes(match);
      const node = nodes(type).find(matches);
      assert.ok(node, `Missing ${type}: ${match}`);
      node.props.onChange(event);
      render();
    },
  };
}
