import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConstructorContext } from '@midnight-ntwrk/compact-runtime';
import { Contract } from '../src/managed/dareu-v3/contract/index.js';

import {
  V3BootstrapContract,
  V3_DEFERRED_CIRCUITS,
} from '../scripts/admin/v3-staged-deployment.js';

const witnesses = {
  local_secret_key: ({ privateState }: { privateState: Record<string, never> }) => [
    privateState,
    new Uint8Array(32),
  ] as [Record<string, never>, Uint8Array],
};

test('V3 bootstrap installs nine operations and defers the two sale operations', () => {
  const contract = new V3BootstrapContract(witnesses as any);
  assert.equal(Object.keys(contract.provableCircuits).length, 9);
  assert.equal(Object.keys(new Contract(witnesses as any).provableCircuits).length, 11);
  for (const circuitId of V3_DEFERRED_CIRCUITS) {
    assert.equal(circuitId in contract.provableCircuits, false, circuitId);
    assert.equal(circuitId in contract.circuits, true, circuitId);
  }

  const initial = contract.initialState(
    createConstructorContext({}, '00'.repeat(32)),
    new Uint8Array(32),
    new Uint8Array(32),
    new Uint8Array(32),
    new Uint8Array(32).fill(1),
  );
  const operations = initial.currentContractState.operations().map(String);
  assert.equal(operations.length, 9);
  for (const circuitId of V3_DEFERRED_CIRCUITS) {
    assert.equal(initial.currentContractState.operation(circuitId), undefined, circuitId);
  }
});

test('every merged V3 circuit has matching proving assets', () => {
  const contract = new Contract(witnesses as any);
  const root = resolve('src/managed/dareu-v3');
  for (const circuitId of Object.keys(contract.provableCircuits)) {
    for (const asset of [`keys/${circuitId}.prover`, `keys/${circuitId}.verifier`, `zkir/${circuitId}.bzkir`]) {
      assert.ok(existsSync(resolve(root, asset)), `${circuitId}: ${asset}`);
    }
  }
});
