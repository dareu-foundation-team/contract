import { Contract, type Witnesses } from '../../src/managed/dareu-v3/contract/index.js';
import { ContractState } from '@midnight-ntwrk/onchain-runtime-v3';

// Keep the merged V3 bootstrap at nine operations; install the two secondary
// market entry points and Smart Darer payment separately through CMA maintenance
// transactions so the initial deployment stays below the proven size ceiling.
export const V3_DEFERRED_CIRCUITS = [
  'list_position',
  'fill_sale',
  'pay_smart_darer_subscription',
] as const;

export type V3DeferredCircuit = (typeof V3_DEFERRED_CIRCUITS)[number];

export class V3BootstrapContract<PS = any> extends Contract<PS> {
  constructor(witnesses: Witnesses<PS>) {
    super(witnesses);
    for (const circuitId of V3_DEFERRED_CIRCUITS) {
      delete (this.provableCircuits as Record<string, unknown>)[circuitId];
    }
  }

  // Compact's generated constructor creates an operation entry for every impure
  // circuit. ContractExecutable only fills verifier keys for provableCircuits,
  // so merely hiding deferred circuits leaves key-less operations behind and
  // the ledger rejects the deploy with Custom 110 (VerifierKeyNotSet).
  //
  // Build a bootstrap state containing only the operations deployed now. The
  // omitted operations are then added through signed CMA maintenance updates.
  initialState(...args: any[]) {
    const result = (Contract.prototype.initialState as any).apply(this, args);
    const completeState = result.currentContractState;
    const bootstrapState = new ContractState();

    bootstrapState.data = completeState.data;
    bootstrapState.balance = completeState.balance;

    for (const circuitId of Object.keys(this.provableCircuits)) {
      const operation = completeState.operation(circuitId);
      if (!operation) {
        throw new Error(`V3 bootstrap circuit '${circuitId}' has no contract operation.`);
      }
      bootstrapState.setOperation(circuitId, operation);
    }

    return {
      ...result,
      currentContractState: bootstrapState,
    };
  }
}
