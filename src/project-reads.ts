// Bound independent read-only requests; configuration writes keep their durable serial protocol.
export async function readProjects<T>(
  ids: readonly string[],
  read: (id: string) => Promise<T>,
  update: (results: { id: string; value?: T; error?: string }[]) => void,
) {
  const results: { id: string; value?: T; error?: string }[] = [];
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const index = next++;
      const id = ids[index]!;
      try {
        results[index] = { id, value: await read(id) };
      } catch (e) {
        results[index] = {
          id,
          error: e instanceof Error ? e.message : 'Project could not be checked.',
        };
      }
      update(results.filter(Boolean));
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
  return results;
}
