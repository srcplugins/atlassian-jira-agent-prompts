import './support/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
const { fieldKey, storageEntity, fieldType, sectionLocalId } = await import('../src/names.ts');

const manifest = parse(readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8'));

test('the field key and storage entity the code uses are the ones manifest.yml declares', () => {
  const fields = manifest.modules['jira:customField'];
  const entities = manifest.app.storage.entities;
  assert.equal(fields.length, 1);
  assert.equal(entities.length, 1);
  assert.equal(fieldKey, fields[0].key);
  assert.equal(storageEntity, entities[0].name);
  // Jira names a Forge field's type after the app, the environment and the module key.
  assert.equal(
    fieldType('app-1', 'env-2'),
    `ari:cloud:ecosystem::extension/app-1/env-2/static/${fields[0].key}`,
  );
});

test('a managed description section is identified by the work item ID', () => {
  assert.equal(sectionLocalId('10'), 'npl-10');
});
