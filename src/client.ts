import { invoke } from '@forge/bridge';
export async function call<T>(name: string, payload = {}): Promise<T> {
  const result = await invoke<{ ok: boolean; value?: T; error?: string }>(name, payload);
  if (!result || !('ok' in result)) throw new Error('Unexpected server response.');
  if (!result.ok || result.value === undefined)
    throw new Error(result?.error ?? 'Could not reach the app. Reopen this view and check again.');
  return result.value;
}
