// Product-specific guards for deleting a synthetic global type during acceptance.
export function verifyTypeMappings(baseline, current, { type, schemes, defaultScheme, attached }) {
  if (
    !Array.isArray(schemes) ||
    !schemes.length ||
    ![type, ...schemes, defaultScheme].every((value) => /^[1-9]\d*$/.test(value)) ||
    ![baseline, current].every(
      (values) =>
        Array.isArray(values) &&
        values.every((value) => typeof value === 'string' && /^[1-9]\d*:[1-9]\d*$/.test(value)),
    )
  )
    throw Error('Complete numeric type-scheme identities required');
  // Schemes created after the baseline by unrelated work are ignored unless they hold the type.
  const known = new Set(baseline.map((value) => value.split(':')[0]));
  const unrelated = current.filter(
    (value) => !value.endsWith(`:${type}`) && known.has(value.split(':')[0]),
  );
  if (JSON.stringify(unrelated) !== JSON.stringify(baseline))
    throw Error('Unrelated type-scheme mappings changed; inspect before cleanup');
  const associations = current.filter((value) => value.endsWith(`:${type}`));
  if (new Set(current).size !== current.length || new Set(baseline).size !== baseline.length)
    throw Error('Duplicate scheme mappings; complete unique inventory required');
  if (associations.some((value) => ![...schemes, defaultScheme].includes(value.split(':')[0])))
    throw Error('Synthetic type acquired an unexpected scheme association');
  if (attached && schemes.some((scheme) => !associations.includes(`${scheme}:${type}`)))
    throw Error('Synthetic type is not attached to its dedicated scheme');
  return { defaultSchemeAdded: associations.includes(`${defaultScheme}:${type}`) };
}
