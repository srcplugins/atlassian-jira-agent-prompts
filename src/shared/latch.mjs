// Shared srcplugins file, synchronized across repositories.
// @ts-check
// One action at a time for UI handlers. UI Kit renders in the host and relays events over the
// bridge, so a disabled button can still deliver a second click before the new tree arrives.
// Keep one latch per component (for example `useRef(createLatch()).current`) and wrap every
// mutation or bulk read in `run`; a call made while another is pending returns undefined.
export function createLatch() {
  let busy = false;
  return {
    /**
     * @template T
     * @param {() => Promise<T>} action
     * @returns {Promise<T | undefined>}
     */
    async run(action) {
      if (busy) return undefined;
      busy = true;
      try {
        return await action();
      } finally {
        busy = false;
      }
    },
    get busy() {
      return busy;
    },
  };
}
