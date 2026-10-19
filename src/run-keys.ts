// One-time keys of the configuration runs started from this page. They last only as long as the
// page: a reloaded page holds none, so its unfinished run is released like any other abandoned one.
const keys = new Map<string, string>();

export const runKeys = {
  set: (id: string, key: string) => void keys.set(id, key),
  get: (id: string | undefined) => (id ? keys.get(id) : undefined),
};
