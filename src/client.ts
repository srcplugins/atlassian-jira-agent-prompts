import { invoke } from '@forge/bridge';
export async function call<T>(name: string, payload = {}): Promise<T> {
  const result = await invoke<{ ok: boolean; value?: T; error?: string }>(name, payload);
  if (!result || !('ok' in result) || typeof result.ok !== 'boolean')
    throw new Error('Unexpected server response.');
  // Only a text error is the server's public message; anything else is not one.
  if (!result.ok)
    throw new Error(
      typeof result.error === 'string' && result.error
        ? result.error
        : 'Unexpected server response.',
    );
  if (result.value === undefined)
    throw new Error('Could not reach the app. Reopen this view and check again.');
  return result.value;
}
