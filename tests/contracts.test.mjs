import './typescript-loader.mjs';
import test from 'node:test';
import { assertRovoReadContract } from './support/contracts.mjs';
const { registerRovo, registerDescriptionRovo } = await import('../src/integration.ts');

// Storage and field lookup are never reached when identity, target or the first read fails.
const withPorts = (create) => (sdk) =>
  create({ ...sdk, kvs: { entity: () => ({ get: async () => undefined }) }, fieldType: () => 'f' });

test('prompt search Rovo action meets the shared identity, validation and redaction contract', () =>
  assertRovoReadContract(withPorts(registerRovo), { projectKey: 'TEST' }));

test('description diagnostic Rovo action meets the shared contract', () =>
  assertRovoReadContract(withPorts(registerDescriptionRovo), { issueKey: 'TEST-1' }));
