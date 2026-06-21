import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import WebSocket from 'ws';

import { resolveNetwork, resolveNetworkConfig } from '../shared/network.js';

type UnshieldedUtxo = {
  owner: string;
  tokenType: string;
  value: string;
  outputIndex: number;
  intentHash: string;
  ctime: string;
  registeredForDustGeneration: boolean;
};

type UnshieldedTransactionUpdate = {
  type: 'UnshieldedTransaction';
  transaction: {
    id: number;
    type: string;
    transactionResult?: {
      status: 'SUCCESS' | 'FAILURE' | 'PARTIAL_SUCCESS';
    };
  };
  createdUtxos: UnshieldedUtxo[];
  spentUtxos: UnshieldedUtxo[];
};

type UnshieldedProgressUpdate = {
  type: 'UnshieldedTransactionsProgress';
  highestTransactionId: number;
};

type UnshieldedUpdate = UnshieldedTransactionUpdate | UnshieldedProgressUpdate;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file lives in scripts/admin/, so the contract root is two levels up.
const contractRoot = path.resolve(__dirname, '..', '..');
const envFiles = ['.env', '.env.local'];
const unshieldedTokenType = unshieldedToken().raw;

const query = `
  subscription UnshieldedTransactions($address: UnshieldedAddress!, $transactionId: Int) {
    unshieldedTransactions(address: $address, transactionId: $transactionId) {
      ... on UnshieldedTransaction {
        type: __typename
        transaction {
          type: __typename
          id
          ... on RegularTransaction {
            transactionResult {
              status
            }
          }
        }
        createdUtxos {
          owner
          tokenType
          value
          outputIndex
          intentHash
          ctime
          registeredForDustGeneration
        }
        spentUtxos {
          owner
          tokenType
          value
          outputIndex
          intentHash
          ctime
          registeredForDustGeneration
        }
      }
      ... on UnshieldedTransactionsProgress {
        type: __typename
        highestTransactionId
      }
    }
  }
`;

function loadEnvFiles() {
  for (const filename of envFiles) {
    const envPath = path.join(contractRoot, filename);
    if (!fs.existsSync(envPath)) continue;

    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;

      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1).trim();
      const value = rawValue.replace(/^['"]|['"]$/g, '');

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function usage() {
  return [
    'Usage:',
    '  npm --workspace @dareu/contract run balance:preprod -- <mn_addr_preprod...>',
    '  npm --workspace @dareu/contract run balance:preview -- <mn_addr_preview...>',
  ].join('\n');
}

function parseArgs() {
  const network = resolveNetwork(process.argv[2]);
  const address = process.argv[3]?.trim();

  if (!address) {
    throw new Error(usage());
  }

  const expectedPrefix = `mn_addr_${network}`;
  if (!address.startsWith(expectedPrefix)) {
    throw new Error(`Expected an unshielded ${network} address starting with "${expectedPrefix}".`);
  }

  const indexerWs = resolveNetworkConfig(network).indexerWS;
  return { network, address, indexerWs };
}

function utxoKey(utxo: UnshieldedUtxo) {
  return `${utxo.intentHash}#${utxo.outputIndex}`;
}

function formatNight(raw: bigint) {
  const whole = raw / 1_000_000n;
  const fraction = (raw % 1_000_000n).toString().padStart(6, '0');
  return `${whole.toLocaleString()}.${fraction}`;
}

function summarizeBalances(utxos: Iterable<UnshieldedUtxo>) {
  const balances = new Map<string, bigint>();

  for (const utxo of utxos) {
    balances.set(utxo.tokenType, (balances.get(utxo.tokenType) ?? 0n) + BigInt(utxo.value));
  }

  return balances;
}

function printBalances(address: string, available: Map<string, UnshieldedUtxo>, appliedId: number, highestTransactionId: number) {
  const balances = summarizeBalances(available.values());
  const nativeUtxos = [...available.values()].filter((utxo) => utxo.tokenType === unshieldedTokenType);
  const registeredNativeUtxos = nativeUtxos.filter((utxo) => utxo.registeredForDustGeneration);

  console.log(`Address: ${address}`);
  console.log(`Synced unshielded transactions: ${appliedId}/${highestTransactionId}`);
  console.log(`Available UTXOs: ${available.size}`);
  console.log(`tNIGHT UTXOs registered for DUST generation: ${registeredNativeUtxos.length}/${nativeUtxos.length}`);

  if (balances.size === 0) {
    console.log('Unshielded balances: 0');
    return;
  }

  console.log('Unshielded balances:');
  for (const [tokenType, value] of balances.entries()) {
    if (tokenType === unshieldedTokenType) {
      console.log(`  tNIGHT: ${formatNight(value)} (${value.toString()} raw)`);
    } else {
      console.log(`  ${tokenType}: ${value.toString()} raw`);
    }
  }
}

function queryBalance(indexerWs: string, address: string) {
  return new Promise<void>((resolve, reject) => {
    const available = new Map<string, UnshieldedUtxo>();
    const ws = new WebSocket(indexerWs, 'graphql-transport-ws');
    let appliedId = 0;
    let highestTransactionId = Number.POSITIVE_INFINITY;
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      ws.close();
      reject(error);
    };

    const done = () => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      printBalances(address, available, appliedId, highestTransactionId);
      ws.close();
      resolve();
    };

    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail(new Error('Timed out while waiting for the Midnight indexer response.'));
      }, 60_000);
    };

    const applyUpdate = (update: UnshieldedUpdate) => {
      if (update.type === 'UnshieldedTransactionsProgress') {
        highestTransactionId = update.highestTransactionId;
        if (appliedId >= highestTransactionId) done();
        return;
      }

      const status = update.transaction.transactionResult?.status ?? 'SUCCESS';
      appliedId = Math.max(appliedId, update.transaction.id);

      if (status === 'FAILURE') {
        for (const utxo of update.spentUtxos) {
          available.set(utxoKey(utxo), utxo);
        }
      } else {
        for (const utxo of update.spentUtxos) {
          available.delete(utxoKey(utxo));
        }
        for (const utxo of update.createdUtxos) {
          available.set(utxoKey(utxo), utxo);
        }
      }

      if (appliedId >= highestTransactionId) done();
    };

    armIdleTimer();

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'connection_init' }));
    });

    ws.on('message', (data) => {
      armIdleTimer();

      const message = JSON.parse(String(data));
      if (message.type === 'connection_ack') {
        ws.send(JSON.stringify({
          id: 'balance',
          type: 'subscribe',
          payload: {
            query,
            variables: { address, transactionId: 0 },
          },
        }));
        return;
      }

      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (message.type === 'next') {
        const update = message.payload?.data?.unshieldedTransactions as UnshieldedUpdate | undefined;
        if (update) applyUpdate(update);
        return;
      }

      if (message.type === 'error') {
        fail(new Error(JSON.stringify(message.payload)));
        return;
      }

      if (message.type === 'complete' && !settled) {
        done();
      }
    });

    ws.on('error', (error) => fail(error));
    ws.on('close', () => {
      if (!settled) fail(new Error('Indexer websocket closed before the balance query completed.'));
    });
  });
}

async function main() {
  loadEnvFiles();
  const { network, address, indexerWs } = parseArgs();

  console.log(`Querying Midnight ${network} unshielded balance.`);
  console.log(`Indexer WS: ${indexerWs}`);
  await queryBalance(indexerWs, address);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
