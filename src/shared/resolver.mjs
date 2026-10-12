// Shared srcplugins file, synchronized across repositories.
// @ts-check
import { logOperational } from './logging.mjs';
// Public-error classification belongs to the app; unexpected details never cross the bridge.
/**
 * @template T
 * @param {() => T} operation
 * @param {(error: unknown) => boolean} isPublic
 * @param {string} [fallback]
 * @returns {Promise<{ok: true, value: Awaited<T>} | {ok: false, error: string}>}
 */
export async function resolveSafely(
  operation,
  isPublic,
  fallback = 'Request could not be completed. Refresh and check your Jira access.',
) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    const publicError = isPublic(error) && error instanceof Error;
    if (!publicError) logOperational('resolver_failed', { category: 'unexpected' });
    return { ok: false, error: publicError ? error.message : fallback };
  }
}
