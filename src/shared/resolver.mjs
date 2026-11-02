// Shared srcplugins file, synchronized across repositories.
// @ts-check
import { logOperational } from './logging.mjs';
// Public-error classification belongs to the app; unexpected details never cross the bridge.

/**
 * Whether Forge refused an asUser request because the user hasn't granted the app access. Forge
 * shows its access prompt only when this error leaves the function uncaught, so every catch around
 * a host request rethrows it. The request never reached the host: nothing was read or changed.
 * @param {unknown} error
 */
export const needsConsent = (error) =>
  error instanceof Error && error.name === 'NEEDS_AUTHENTICATION_ERR';

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
    if (needsConsent(error)) throw error;
    const publicError = isPublic(error) && error instanceof Error;
    if (!publicError) logOperational('resolver_failed', { category: 'unexpected' });
    return { ok: false, error: publicError ? error.message : fallback };
  }
}
