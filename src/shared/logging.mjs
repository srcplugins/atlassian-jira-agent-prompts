// Shared srcplugins file, synchronized across repositories.
// @ts-check
// Only fixed diagnostic categories cross this boundary. Never pass the caught error.
/** @param {unknown} event @param {unknown} fields */
export function logOperational(event, fields) {
  if (
    event !== 'resolver_failed' ||
    !fields ||
    typeof fields !== 'object' ||
    Object.getPrototypeOf(fields) !== Object.prototype ||
    Reflect.ownKeys(fields).length !== 1 ||
    !('category' in fields)
  )
    return false;
  const descriptor = Object.getOwnPropertyDescriptor(fields, 'category');
  if (!descriptor || !('value' in descriptor) || descriptor.value !== 'unexpected') return false;
  // Construct the output; never serialize the caller's object (including toJSON/getters).
  try {
    console.error(JSON.stringify({ event: 'resolver_failed', category: 'unexpected' }));
    return true;
  } catch {
    // Diagnostics must never change mutation/recovery behavior.
    return false;
  }
}
