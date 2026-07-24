import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { u8aToHex } from '@polkadot/util';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { NoOpTransactionHistoryStorage, TransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk-abstractions';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import * as Rx from 'rxjs';
import WebSocket from 'ws';

import { Contract, type Witnesses } from '../../src/managed/dareu/contract/index.js';
import { type SupportedNetwork, type NetworkConfig, resolveNetworkConfig } from './network.js';

type WalletSyncedState = Awaited<ReturnType<WalletFacade['waitForSyncedState']>>;

export type WalletContext = {
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
  /** Persist the current synced wallet state to disk for incremental resync next run. */
  saveState: () => Promise<void>;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file lives in scripts/shared/, so the contract root is two levels up.
export const contractRoot = path.resolve(__dirname, '..', '..');
export const zkConfigPath = path.resolve(contractRoot, 'src', 'managed', 'dareu');

// On-disk cache of synced wallet state so repeated deploy/keeper runs sync
// incrementally instead of replaying ~1M events from scratch each time.
const walletCacheDir = path.join(contractRoot, '.wallet-cache');
const WALLET_CACHE_VERSION = 1;

type WalletStateCache = {
  version: number;
  network: SupportedNetwork;
  address: string;
  shielded: string;
  unshielded: string;
  dust: string;
};

function storageNamespace(name: 'MIDNIGHT_WALLET_CACHE_NAMESPACE' | 'MIDNIGHT_PRIVATE_STATE_NAMESPACE'): string | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    throw new Error(`${name} may contain only lowercase letters, numbers, "_", and "-".`);
  }
  return value;
}

function walletCachePath(network: SupportedNetwork): string {
  const namespace = storageNamespace('MIDNIGHT_WALLET_CACHE_NAMESPACE');
  return path.join(walletCacheDir, `${network}${namespace ? `-${namespace}` : ''}.json`);
}

function walletCacheEnabled(): boolean {
  return (process.env.MIDNIGHT_WALLET_CACHE?.trim() ?? '1') !== '0';
}

/** Load a valid, matching cache for this network+address, or undefined. */
function loadWalletStateCache(network: SupportedNetwork, address: string): WalletStateCache | undefined {
  if (!walletCacheEnabled()) return undefined;
  const file = walletCachePath(network);
  try {
    if (!fs.existsSync(file)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as WalletStateCache;
    if (parsed.version !== WALLET_CACHE_VERSION || parsed.network !== network || parsed.address !== address) {
      return undefined;
    }
    if (!parsed.shielded || !parsed.unshielded || !parsed.dust) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
export const stateRoot = path.resolve(contractRoot, '.midnight-state');

function timeoutMs(name: string, fallback: number) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return fallback;

  const value = Number(rawValue);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function bigintEnv(name: string, fallback: bigint) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return fallback;

  try {
    const value = BigInt(rawValue);
    return value >= 0n ? value : fallback;
  } catch {
    return fallback;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function syncAllowedGap() {
  return bigintEnv('MIDNIGHT_WALLET_SYNC_ALLOWED_GAP', 50n);
}

/**
 * Unwrap an error's message, walking `.cause` chains (including Effect-style
 * causes) up to depth 4. Shared so every admin script formats failures the same
 * way instead of each keeping its own copy.
 */
export function errorMessage(error: unknown, depth = 0): string {
  if (depth > 4) return '';

  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeMessage = cause ? errorMessage(cause, depth + 1) : '';
    return causeMessage ? `${error.message}: ${causeMessage}` : error.message;
  }

  if (typeof error === 'object' && error !== null) {
    const maybeMessage = (error as { message?: unknown }).message;
    const maybeCause = (error as { cause?: unknown }).cause;
    const message = typeof maybeMessage === 'string' ? maybeMessage : JSON.stringify(error);
    const causeMessage = maybeCause ? errorMessage(maybeCause, depth + 1) : '';
    return causeMessage ? `${message}: ${causeMessage}` : message;
  }

  return String(error);
}

function progressValue(progress: unknown, key: string) {
  const value = (progress as Record<string, unknown> | undefined)?.[key];
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value === undefined ? '?' : String(value);
}

function indexedProgress(progress: unknown) {
  return [
    `connected=${progressValue(progress, 'isConnected')}`,
    `applied=${progressValue(progress, 'appliedIndex')}`,
    `walletHigh=${progressValue(progress, 'highestRelevantWalletIndex')}`,
    `chainHigh=${progressValue(progress, 'highestIndex')}`,
  ].join(' ');
}

function unshieldedProgress(progress: unknown) {
  return [
    `connected=${progressValue(progress, 'isConnected')}`,
    `applied=${progressValue(progress, 'appliedId')}`,
    `high=${progressValue(progress, 'highestTransactionId')}`,
  ].join(' ');
}

function formatSyncProgress(state: WalletSyncedState) {
  return [
    'Wallet sync progress:',
    `shielded(${indexedProgress(state.shielded.state.progress)})`,
    `dust(${indexedProgress(state.dust.state.progress)})`,
    `unshielded(${unshieldedProgress(state.unshielded.progress)})`,
  ].join(' ');
}

export function isWalletStateSyncedWithin(
  state: WalletSyncedState,
  allowedGap = syncAllowedGap(),
) {
  return (
    state.shielded.state.progress.isCompleteWithin(allowedGap) &&
    state.dust.state.progress.isCompleteWithin(allowedGap) &&
    state.unshielded.progress.isCompleteWithin(allowedGap)
  );
}

export function configureNetwork(network: SupportedNetwork): NetworkConfig {
  setNetworkId(network);
  return resolveNetworkConfig(network);
}

// The contract uses no per-session private state (the secret key is captured by the
// closure below, not stored in private state), so the private-state type is an empty
// record — matching the `initialPrivateState: {}` used by deploy.ts / chain.ts.
type DareuPrivateState = Record<string, never>;

export function createCompiledDareuContract(localSecretKey: Uint8Array) {
  const witnesses: Witnesses<DareuPrivateState> = {
    local_secret_key: ({ privateState }) => [privateState, localSecretKey],
  };

  // Effect-style Pipeable: apply both data-last transforms in one variadic pipe.
  // Chaining `.pipe(a).pipe(b)` fails because the intermediate value isn't pipeable.
  return CompiledContract.make('dareu', Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );
}

export function ensureCompiledContract() {
  const contractIndex = path.join(zkConfigPath, 'contract', 'index.js');
  const keyDir = path.join(zkConfigPath, 'keys');
  const zkirDir = path.join(zkConfigPath, 'zkir');

  if (!fs.existsSync(contractIndex) || !fs.existsSync(keyDir) || !fs.existsSync(zkirDir)) {
    throw new Error('DareU contract is not compiled. Run: npm run build:contract');
  }
}

const SEED_HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * Accept either a hex HD-wallet seed (the existing convention) or a BIP39
 * mnemonic / seed phrase (助记词). For a mnemonic we use the standard BIP39
 * **PBKDF2 seed** (`mnemonicToSeed`, 64 bytes, empty passphrase) — this is what
 * Lace Midnight derives addresses from (verified against a known mn_addr). NOTE:
 * it is NOT the 32-byte entropy; using the entropy derives a different (wrong)
 * address. A raw hex value is still fed to HDWallet.fromSeed unchanged.
 *
 * A value is treated as a mnemonic when it contains whitespace (multiple words);
 * otherwise it is treated as raw hex. `MIDNIGHT_WALLET_MNEMONIC` (if set) forces
 * the mnemonic path and takes precedence over a hex `MIDNIGHT_WALLET_SEED`.
 */
export function resolveWalletSeedHex(rawSeedOrMnemonic: string): string {
  // Strip surrounding whitespace and any quote characters — including the curly/
  // smart quotes (“ ” ‘ ’) that copy-paste often introduces — from both ends.
  const dequote = (s: string) => s.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '');
  const explicitMnemonic = dequote(process.env.MIDNIGHT_WALLET_MNEMONIC ?? '');
  const candidate = explicitMnemonic || dequote(rawSeedOrMnemonic);
  const looksLikeMnemonic = /\s/.test(candidate);

  if (looksLikeMnemonic) {
    const mnemonic = candidate.replace(/\s+/g, ' ').toLowerCase();
    if (!validateMnemonic(mnemonic, englishWordlist)) {
      throw new Error(
        'Wallet mnemonic is invalid (BIP39 checksum failed). Check the words and their order — ' +
          'a Midnight/Lace recovery phrase is normally 24 English words.',
      );
    }
    return Buffer.from(mnemonicToSeedSync(mnemonic)).toString('hex');
  }

  const hex = candidate.replace(/^0x/i, '');
  if (!SEED_HEX_RE.test(hex) || hex.length % 2 !== 0) {
    throw new Error(
      'MIDNIGHT_WALLET_SEED must be a hex seed or a BIP39 mnemonic. For a recovery phrase, ' +
        'put the words (space-separated) in MIDNIGHT_WALLET_MNEMONIC or MIDNIGHT_WALLET_SEED.',
    );
  }
  return hex;
}

/**
 * The wallet secret to hand to `createWallet`: a hex seed in MIDNIGHT_WALLET_SEED,
 * or a BIP39 phrase in MIDNIGHT_WALLET_MNEMONIC (which takes precedence). Throws a
 * single clear error if neither is set, so callers don't need to require both.
 */
export function requiredWalletSeedOrMnemonic(): string {
  const mnemonic = process.env.MIDNIGHT_WALLET_MNEMONIC?.trim();
  const seed = process.env.MIDNIGHT_WALLET_SEED?.trim();
  const value = mnemonic || seed;
  if (!value) {
    throw new Error(
      'Set MIDNIGHT_WALLET_MNEMONIC (a BIP39 recovery phrase / 助记词) or MIDNIGHT_WALLET_SEED ' +
        '(a hex HD seed) in contract/.env.local.',
    );
  }
  return value;
}

export function deriveKeys(seedOrMnemonic: string) {
  const seedHex = resolveWalletSeedHex(seedOrMnemonic);
  const hdWallet = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));

  if (hdWallet.type !== 'seedOk') {
    throw new Error('MIDNIGHT_WALLET_SEED is not a valid HD wallet seed.');
  }

  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  hdWallet.hdWallet.clear();

  if (result.type !== 'keysDerived') {
    throw new Error(`Could not derive Midnight wallet keys for roles: ${result.roles.join(', ')}`);
  }

  return result.keys;
}

export async function createWallet(seedHex: string, network: SupportedNetwork, config: NetworkConfig): Promise<WalletContext> {
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
  // NOTE: ledger-v8 8.1.0 parses & replays the v9 `DustGenerationDtimeUpdate` events
  // natively, so the old replay-filter workaround (removed) is no longer needed. If
  // DUST replay errors ever return, recover the patch from git history.

  const keys = deriveKeys(seedHex);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], network);
  const relayURL = new URL(config.nodeWS);

  // We don't surface tx history in the admin CLI, so a no-op store satisfies the
  // wallets' required txHistoryStorage without the schema InMemory now demands.
  const txHistoryStorage = new NoOpTransactionHistoryStorage<TransactionHistoryStorage.TransactionHistoryEntryWithHash>();
  const costParameters = {
    additionalFeeOverhead: 300_000_000_000_000n,
    feeBlocksMargin: 5,
  };
  const indexerClientConnection = {
    indexerHttpUrl: config.indexer,
    indexerWsUrl: config.indexerWS,
  };

  // wallet-sdk 4.x: each wallet factory takes only its own config slice (no more
  // shared provingServerUrl/relayURL on the per-wallet configs). The proving/
  // submission endpoints live on the WalletFacade configuration below.
  const shieldedClass = ShieldedWallet({ networkId: network, indexerClientConnection, txHistoryStorage });
  const unshieldedClass = UnshieldedWallet({ networkId: network, indexerClientConnection, txHistoryStorage });
  const dustClass = DustWallet({ networkId: network, indexerClientConnection, txHistoryStorage, costParameters });

  // Resume from a cached synced state when available (incremental sync); otherwise
  // start fresh. Any restore failure (stale/incompatible cache) falls back to fresh.
  const address = String(unshieldedKeystore.getBech32Address());
  const cache = loadWalletStateCache(network, address);
  const buildFresh = () => ({
    shielded: shieldedClass.startWithSecretKeys(shieldedSecretKeys),
    unshielded: unshieldedClass.startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: dustClass.startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  let wallets: ReturnType<typeof buildFresh>;
  if (cache) {
    try {
      wallets = {
        shielded: shieldedClass.restore(cache.shielded),
        unshielded: unshieldedClass.restore(cache.unshielded),
        dust: dustClass.restore(cache.dust),
      };
      console.log('Restored wallet state from cache; syncing incrementally from the cached point.');
    } catch (error) {
      console.warn(
        `Wallet cache restore failed (${error instanceof Error ? error.message : String(error)}); doing a full sync.`,
      );
      wallets = buildFresh();
    }
  } else {
    wallets = buildFresh();
  }
  const { shielded: shieldedWallet, unshielded: unshieldedWallet, dust: dustWallet } = wallets;

  const wallet = await WalletFacade.init({
    configuration: {
      networkId: network,
      indexerClientConnection,
      provingServerUrl: new URL(config.proofServer),
      relayURL,
      txHistoryStorage,
      costParameters,
    },
    shielded: () => shieldedWallet,
    unshielded: () => unshieldedWallet,
    dust: () => dustWallet,
  });

  console.log('Starting Midnight wallet services...');
  await withTimeout(
    Promise.all([
      wallet.shielded.start(shieldedSecretKeys),
      wallet.unshielded.start(),
      wallet.dust.start(dustSecretKey),
      wallet.pendingTransactionsService.start(),
    ]).then(() => undefined),
    timeoutMs('MIDNIGHT_WALLET_START_TIMEOUT_MS', 300_000),
    'Timed out while starting Midnight wallet services. Check Preprod RPC/Indexer connectivity and try again.',
  );
  console.log('Midnight wallet services started (shielded + unshielded + DUST).');

  // Persist the synced state to disk (atomic write) so the next run resumes
  // incrementally. Best-effort: a serialize/write failure never aborts the run.
  // A `saving` guard prevents the periodic checkpoint and an explicit save from
  // overlapping.
  let saving = false;
  const writeCache = async (): Promise<boolean> => {
    if (!walletCacheEnabled() || saving) return false;
    saving = true;
    try {
      const data: WalletStateCache = {
        version: WALLET_CACHE_VERSION,
        network,
        address,
        shielded: await wallet.shielded.serializeState(),
        unshielded: await wallet.unshielded.serializeState(),
        dust: await wallet.dust.serializeState(),
      };
      fs.mkdirSync(walletCacheDir, { recursive: true });
      const file = walletCachePath(network);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
      return true;
    } catch (error) {
      console.warn(`Could not cache wallet state: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      saving = false;
    }
  };

  const saveState = async () => {
    if (await writeCache()) console.log(`Wallet sync state cached: ${walletCachePath(network)}`);
  };

  // Progress-driven checkpoint DURING the (long, first-time) sync: every time the
  // applied index advances by MIDNIGHT_WALLET_CHECKPOINT_EVERY events (default
  // 200k) we persist, so an interruption — dropped websocket, timeout, Ctrl-C —
  // resumes from the last checkpoint instead of restarting from zero.
  const checkpointEvery = Number(process.env.MIDNIGHT_WALLET_CHECKPOINT_EVERY ?? 200_000);
  if (walletCacheEnabled() && Number.isFinite(checkpointEvery) && checkpointEvery > 0) {
    let lastCheckpointAt = 0;
    let pending = false;
    wallet
      .state()
      .pipe(Rx.auditTime(2_000))
      .subscribe((state) => {
        const applied = dustAppliedIndex(state);
        if (pending || applied - lastCheckpointAt < checkpointEvery) return;
        pending = true;
        lastCheckpointAt = applied;
        void writeCache().then((ok) => {
          pending = false;
          if (ok) console.log(`Sync checkpoint saved at applied=${applied}; a failed run resumes from here.`);
        });
      });
  }

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, saveState };
}

/** Read the dust wallet's applied sync index from a facade state, as a number. */
function dustAppliedIndex(state: Awaited<ReturnType<typeof currentWalletState>>): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (state as any)?.dust?.state?.progress?.appliedIndex;
  return typeof raw === 'bigint' ? Number(raw) : Number(raw ?? 0);
}

export async function currentWalletState(wallet: WalletFacade) {
  return Rx.firstValueFrom(wallet.state());
}

export async function submitTransactionOnce(tx: { serialize(): Uint8Array }, config: NetworkConfig) {
  const api = await ApiPromise.create({
    provider: new WsProvider(config.nodeWS),
    throwOnConnect: false,
    noInitWarn: true,
  });

  try {
    const serializedTx = u8aToHex(tx.serialize());
    const txHash = await (api.tx as any).midnight.sendMnTransaction(serializedTx).send();
    return String(txHash);
  } finally {
    await api.disconnect();
  }
}

export async function waitForUnshieldedSyncedState(wallet: WalletFacade) {
  const allowedGap = syncAllowedGap();
  const progressSubscription = wallet.unshielded.state.pipe(Rx.auditTime(5_000)).subscribe({
    next: (state) => console.log(`Unshielded wallet sync progress: ${unshieldedProgress(state.progress)}`),
  });

  console.log(`Waiting for unshielded wallet sync (allowed gap: ${allowedGap.toString()})...`);

  try {
    const state = await withTimeout(
      wallet.unshielded.waitForSyncedState(allowedGap),
      timeoutMs('MIDNIGHT_WALLET_SYNC_TIMEOUT_MS', 300_000),
      'Timed out while waiting for unshielded wallet sync. Check the Indexer websocket and wallet seed.',
    );
    console.log('Unshielded wallet synced.');
    return state;
  } finally {
    progressSubscription.unsubscribe();
  }
}

export async function waitForDustSyncedState(wallet: WalletFacade) {
  const allowedGap = syncAllowedGap();
  const progressSubscription = wallet.dust.state.pipe(Rx.auditTime(5_000)).subscribe({
    next: (state) => console.log(`DUST wallet sync progress: ${indexedProgress(state.state.progress)}`),
  });

  console.log(`Waiting for DUST wallet sync (allowed gap: ${allowedGap.toString()})...`);

  try {
    const state = await withTimeout(
      wallet.dust.waitForSyncedState(allowedGap),
      timeoutMs('MIDNIGHT_WALLET_SYNC_TIMEOUT_MS', 300_000),
      'Timed out while waiting for DUST wallet sync. Check the Indexer websocket and wallet seed.',
    );
    console.log('DUST wallet synced.');
    return state;
  } finally {
    progressSubscription.unsubscribe();
  }
}

/**
 * Register any unregistered tNight UTXOs for DUST generation, then BLOCK until the
 * DUST wallet is synced (`isCompleteWithin(syncAllowedGap())`) AND has a positive
 * balance. This is the sync barrier that prevents building a DUST spend proof
 * against a stale/pruned Merkle root — skipping it produces node error
 * `1010 Custom error: 170 = InvalidDustSpendProof` on submission. Extracted from
 * deploy-v2.ts (where it already worked) so every script that submits a
 * DUST-funded contract transaction (deploy-v2, deploy-registry, register-asset,
 * market-v2, …) shares one implementation instead of each needing its own copy —
 * see contract/docs/README.md for the incident this fixed.
 *
 * Every caller MUST run this (or `waitForDustSyncedState`, which only waits for
 * sync without registering new UTXOs / requiring balance > 0) AFTER funding checks
 * and BEFORE submitting any transaction that spends DUST — i.e. before
 * `walletCtx.saveState()` and before `deployContract`/`callTx.*`.
 */
export async function ensureDust(walletCtx: WalletContext, config: NetworkConfig) {
  await waitForUnshieldedSyncedState(walletCtx.wallet);

  let state = await currentWalletState(walletCtx.wallet);
  const nightUtxos = state.unshielded.availableCoins.filter((coin: any) => !coin.meta?.registeredForDustGeneration);

  if (nightUtxos.length > 0) {
    console.log(`Registering ${nightUtxos.length} available tNight UTXO(s) for DUST generation...`);
    const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
      nightUtxos,
      walletCtx.unshieldedKeystore.getPublicKey(),
      (payload) => walletCtx.unshieldedKeystore.signData(payload),
    );
    const finalizedRegistrationTx = await walletCtx.wallet.finalizeRecipe(recipe);
    try {
      const txHash = await submitTransactionOnce(finalizedRegistrationTx, config);
      console.log(`DUST registration transaction submitted: ${txHash}`);
    } catch (error) {
      await walletCtx.wallet.revert(finalizedRegistrationTx);
      throw new Error(`DUST registration transaction submission failed: ${errorMessage(error)}`);
    }
  } else {
    console.log('No unregistered tNight UTXOs found. Checking existing DUST generation state...');
  }

  console.log('Waiting for DUST generation...');
  state = await RxFirstDust(walletCtx);
  const dust = state.dust.balance(new Date());
  console.log(`DUST balance: ${dust.toString()}`);

  return dust;
}

async function RxFirstDust(walletCtx: WalletContext) {
  const timeoutMs_ = Number(process.env.MIDNIGHT_DUST_GENERATION_TIMEOUT_MS ?? 60 * 60 * 1000);

  return Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(
      Rx.auditTime(5000),
      Rx.filter((state) => state.dust.state.progress.isCompleteWithin(syncAllowedGap())),
      Rx.filter((state) => state.dust.balance(new Date()) > 0n),
      Rx.timeout({
        first: timeoutMs_,
        with: () =>
          Rx.throwError(
            () =>
              new Error(
                `Timed out while waiting for DUST generation after ${timeoutMs_}ms. ` +
                  'If dust is still 0, keep the wallet funded and rerun deploy later.',
              ),
          ),
      }),
    ),
  );
}

export async function waitForSyncedState(wallet: WalletFacade) {
  const allowedGap = syncAllowedGap();
  const progressSubscription = wallet.state().pipe(Rx.auditTime(5_000)).subscribe({
    next: (state) => console.log(formatSyncProgress(state)),
  });

  console.log(`Waiting for Midnight wallet sync (allowed gap: ${allowedGap.toString()})...`);

  try {
    const [shielded, unshielded, dust, pending] = await withTimeout(
      Promise.all([
        wallet.shielded.waitForSyncedState(allowedGap),
        wallet.unshielded.waitForSyncedState(allowedGap),
        wallet.dust.waitForSyncedState(allowedGap),
        Rx.firstValueFrom(wallet.pendingTransactionsService.state()),
      ]),
      timeoutMs('MIDNIGHT_WALLET_SYNC_TIMEOUT_MS', 300_000),
      'Timed out while waiting for Midnight wallet sync. Check the Indexer websocket, Preprod connectivity, and wallet seed.',
    );

    const state: Awaited<ReturnType<WalletFacade['waitForSyncedState']>> = {
      shielded,
      unshielded,
      dust,
      pending,
      get isSynced() {
        return isWalletStateSyncedWithin(this, 0n);
      },
    };

    console.log('Midnight wallet synced.');
    return state;
  } finally {
    progressSubscription.unsubscribe();
  }
}

export type CreateProvidersOptions = {
  /** Compiled-contract asset dir (defaults to the v1 `managed/dareu`). Threading it
   *  here (instead of overwriting `providers.zkConfigProvider` after the fact, as
   *  deploy-v2/market-v2 historically did) also points the proofProvider at the
   *  right prover keys, since it is constructed from this same zkConfigProvider. */
  zkConfigPath?: string;
  /** Circuit assets that this workflow will use. The upstream HTTP proof provider
   *  deliberately treats ZK-provider read failures as "no key material", which can
   *  turn a missing/wrong asset directory into an opaque proof-server `bad input`.
   *  Loading these circuits here makes that configuration error fail locally. */
  expectedCircuitIds?: readonly string[];
  /** Which token kinds balanceTx may spend. v1 circuits only ever need
   *  ['unshielded','dust']; v2 circuits that take a ShieldedCoinInfo argument
   *  (propose/dispute bond, place_bet) need 'shielded' balancing too — pass 'all'. */
  tokenKindsToBalance?: 'all' | Array<'unshielded' | 'dust' | 'shielded'>;
};

export async function preflightZkConfigAssets(
  directory: string,
  expectedCircuitIds: readonly string[],
) {
  const zkConfigProvider = new NodeZkConfigProvider<string>(directory);

  for (const circuitId of new Set(expectedCircuitIds)) {
    try {
      await zkConfigProvider.get(circuitId);
    } catch (error) {
      throw new Error(
        `ZK asset preflight failed for circuit "${circuitId}" in ${directory}. ` +
          'Expected readable keys/<circuit>.prover, keys/<circuit>.verifier, and ' +
          `zkir/<circuit>.bzkir files. Recompile the matching contract before retrying: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  return zkConfigProvider;
}

export async function createProviders(
  walletCtx: WalletContext,
  config: NetworkConfig,
  privateStoragePassword: string,
  opts?: CreateProvidersOptions,
) {
  const resolvedZkConfigPath = opts?.zkConfigPath ?? zkConfigPath;
  const zkConfigProvider = await preflightZkConfigAssets(
    resolvedZkConfigPath,
    opts?.expectedCircuitIds ?? [],
  );

  const state = await currentWalletState(walletCtx.wallet);
  const accountId = String(walletCtx.unshieldedKeystore.getBech32Address());
  const tokenKindsToBalance = opts?.tokenKindsToBalance ?? (['unshielded', 'dust'] as Array<'unshielded' | 'dust' | 'shielded'>);

  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        {
          shieldedSecretKeys: walletCtx.shieldedSecretKeys,
          dustSecretKey: walletCtx.dustSecretKey,
        },
        {
          ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000),
          tokenKindsToBalance,
        },
      );
      const signedRecipe = await walletCtx.wallet.signRecipe(recipe, (payload) =>
        walletCtx.unshieldedKeystore.signData(payload),
      );

      return walletCtx.wallet.finalizeRecipe(signedRecipe);
    },
  };

  const privateStateNamespace = storageNamespace('MIDNIGHT_PRIVATE_STATE_NAMESPACE');

  return {
    privateStateProvider: levelPrivateStateProvider({
      accountId,
      // LevelDB takes an exclusive process lock. Dedicated Keeper instances must
      // never open the same directory even though their accountIds differ.
      midnightDbName: path.join(stateRoot, `level-db${privateStateNamespace ? `-${privateStateNamespace}` : ''}`),
      privateStateStoreName: 'dareu-private-states',
      signingKeyStoreName: 'dareu-signing-keys',
      privateStoragePasswordProvider: () => privateStoragePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(config.indexer, config.indexerWS, WebSocket as any),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(config.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: {
      submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
    },
  };
}
