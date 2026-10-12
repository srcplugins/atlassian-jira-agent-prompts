// Shared srcplugins file, synchronized across repositories.
// Minimal SDK substitute for adapter/handler contracts, not a Jira emulator.
// Routes are recorded as encoded strings; real Forge route safety needs platform checks.
// A response may declare `expect: { method, path }` (string for an exact match, RegExp otherwise)
// so a misordered queue fails instead of feeding a body to the wrong request. Call
// `assertDrained()` at the end of a test to prove every queued response was consumed.
const matches = (expected, actual) =>
  expected === undefined ||
  (expected instanceof RegExp ? expected.test(actual) : expected === actual);

export function forgeContract(...responses) {
  const calls = [];
  const definitions = Object.create(null);
  const api = {
    asUser: () => ({
      requestJira: async (path, options) => {
        calls.push({ actor: 'asUser', path, ...structuredClone(options) });
        const method = options?.method ?? 'GET';
        if (!responses.length) throw Error(`Unexpected SDK request: ${method} ${path}`);
        const { expect } = responses[0];
        if (expect && (!matches(expect.method, method) || !matches(expect.path, path)))
          throw Error(`Unexpected SDK request: ${method} ${path}`);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return {
          ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
          status: next.status ?? 200,
          json: async () => {
            if (next.invalidJson) throw Error('private-response-body');
            return structuredClone(next.body);
          },
        };
      },
    }),
    asApp: () => {
      throw Error('Unexpected asApp actor');
    },
  };
  const route = (strings, ...values) =>
    strings.reduce(
      (out, part, i) =>
        out + part + (i < values.length ? encodeURIComponent(String(values[i])) : ''),
      '',
    );
  class Resolver {
    define(name, callback) {
      if (definitions[name]) throw Error('Duplicate resolver');
      definitions[name] = callback;
    }
    getDefinitions() {
      return definitions;
    }
  }
  const assertDrained = () => {
    if (responses.length) throw Error(`${responses.length} queued SDK response(s) were not used`);
  };
  return { api, route, Resolver, calls, remaining: () => responses.length, assertDrained };
}
