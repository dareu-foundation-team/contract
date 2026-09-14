import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { u8aToHex } from '@polkadot/util';
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { CustomDustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { V1Builder as DustV1Builder } from '@midnight-ntwrk/wallet-sdk-dust-wallet/v1';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { CustomShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { V1Builder as ShieldedV1Builder } from '@midnight-ntwrk/wallet-sdk-shielded/v1';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { NoOpTransactionHistoryStorage, TransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { Effect } from 'effect';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import * as Rx from 'rxjs';
import WebSocket from 'ws';

import { type SupportedNetwork, type NetworkConfig, resolveNetworkConfig } from './network.js';

type WalletSyncedState = Awaited<ReturnType<WalletFacade['waitForSyncedState']>>;

/**
 * Headless admin/Keeper processes never expose transaction history. The wallet
 * SDK's default shielded/DUST history services nevertheless issue one Indexer
 * metadata query per relevant historical transaction, with unbounded
 * concurrency. During a long replay that request burst is rejected with HTTP
 * 403 and substantially slows the actual wallet-state sync.
 *
 * Returning synthetic metadata is safe here because `put` is also a no-op: the
 * metadata is used only to build a history entry that this application
 * deliberately does not store or consume.
 */
export function makeHeadlessTransactionHistoryService() {
  return {
    put: () => Effect.succeed(undefined),
    getTransactionDetails: (hash: string) => Effect.succeed({
      hash,
      status: 'SUCCESS',
      timestamp: 0,
    } as const),
  };
}

export type WalletContext = {
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
  /** Persist a fully synced/settled state and promote it to last-known-good. */
  saveState: () => Promise<void>;
  /** Persist partial forward progress without replacing last-known-good. */
  saveCheckpoint: () => Promise<void>;
  /** Quarantine a stalled checkpoint and prepare the next supervised recovery. */
  recoverFromSyncStall: (error: WalletSyncStalledError) => Promise<WalletSyncRecoveryResult>;
};

export type WalletCachePolicy = 'prefer-checkpoint' | 'require-last-good';

export type CreateWalletOptions = {
  /**
   * `prefer-checkpoint` is for the dedicated warm-up process: resume the newest
   * partial checkpoint and finish the expensive replay. `require-last-good` is
   * for short-lived transaction processes: never silently start a cold replay.
   */
  cachePolicy?: WalletCachePolicy;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file lives in scripts/shared/, so the contract root is two levels up.
export const contractRoot = path.resolve(__dirname, '..', '..');
export const zkConfigPath = path.resolve(contractRoot, 'src', 'managed', 'dareu-v2');

// On-disk cache of synced wallet state so repeated deploy/keeper runs sync
// incrementally instead of replaying ~1M events from scratch each time.
const walletCacheDir = path.join(contractRoot, '.wallet-cache');
const WALLET_CACHE_VERSION = 1;

function walletCacheFingerprint(): string {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(contractRoot, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { version?: string }>;
    };
    const version = (name: string) => lock.packages?.[`node_modules/${name}`]?.version ?? 'unknown';
    return [
      `wallet-facade@${version('@midnight-ntwrk/wallet-sdk-facade')}`,
      `dust-wallet@${version('@midnight-ntwrk/wallet-sdk-dust-wallet')}`,
      `ledger-v8@${version('@midnight-ntwrk/ledger-v8')}`,
      'sync=v1',
    ].join('|');
  } catch {
    // A missing lockfile should not disable wallet operation. The fallback is
    // deliberately distinct, so a later locked install invalidates this cache.
    return 'wallet-packages@unknown|sync=v1';
  }
}

const WALLET_CACHE_FINGERPRINT = walletCacheFingerprint();

export function isWalletCacheFingerprintCompatible(fingerprint: string | undefined): boolean {
  // A serialized wallet contains both the ledger commitment tree and a separate
  // sync cursor.  Legacy caches did not record which SDK/ledger implementation
  // produced those two values, so restoring one can resume after an unapplied
  // tree index and permanently loop with "values inserted non-linearly".
  return fingerprint === WALLET_CACHE_FINGERPRINT;
}

type WalletStateCache = {
  version: number;
  fingerprint?: string;
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

function walletLastGoodCachePath(network: SupportedNetwork): string {
  return `${walletCachePath(network)}.last-good`;
}

function walletSyncRecoveryPath(network: SupportedNetwork): string {
  return `${walletCachePath(network)}.sync-recovery.json`;
}

function walletCacheEnabled(): boolean {
  return (process.env.MIDNIGHT_WALLET_CACHE?.trim() ?? '1') !== '0';
}

/** Keep the checkpoint that existed before a supervised warm-up starts. */
export function preserveWalletCheckpoint(
  network: SupportedNetwork,
  label = 'before-v3-prepare',
): string | undefined {
  if (!walletCacheEnabled()) return undefined;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(label)) {
    throw new Error('Wallet checkpoint backup label contains unsupported characters.');
  }
  const source = walletCachePath(network);
  if (!fs.existsSync(source)) return undefined;
  const backup = `${source}.${label}`;
  try {
    fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return backup;
}

/** Load a valid, matching cache for this network+address, or undefined. */
function readWalletStateCache(file: string, network: SupportedNetwork, address: string): WalletStateCache | undefined {
  if (!fs.existsSync(file)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as WalletStateCache;
  if (parsed.version !== WALLET_CACHE_VERSION || parsed.network !== network || parsed.address !== address) {
    return undefined;
  }
  // Never restore an unversioned/foreign SDK snapshot. A clean replay is slower,
  // but it is the only safe recovery when tree state and appliedIndex disagree.
  if (!isWalletCacheFingerprintCompatible(parsed.fingerprint)) return undefined;
  if (!parsed.shielded || !parsed.unshielded || !parsed.dust) return undefined;
  return parsed;
}

function loadWalletStateCache(
  network: SupportedNetwork,
  address: string,
  policy: WalletCachePolicy,
): { cache: WalletStateCache; source: 'checkpoint' | 'last-good' } | undefined {
  if (!walletCacheEnabled()) return undefined;
  try {
    if (policy === 'require-last-good') {
      const cache = readWalletStateCache(walletLastGoodCachePath(network), network, address);
      return cache ? { cache, source: 'last-good' } : undefined;
    }
    const checkpoint = readWalletStateCache(walletCachePath(network), network, address);
    if (checkpoint) return { cache: checkpoint, source: 'checkpoint' };
    const lastGood = readWalletStateCache(walletLastGoodCachePath(network), network, address);
    return lastGood ? { cache: lastGood, source: 'last-good' } : undefined;
  } catch {
    return undefined;
  }
}

type WalletSyncRecoveryRecord = {
  dustAppliedIndex: number;
  attempts: number;
  updatedAt: string;
};

export type WalletSyncRecoveryResult = {
  attempt: number;
  exhausted: boolean;
  quarantinedPath?: string;
  restoredLastKnownGood: boolean;
};

export function nextWalletSyncRecoveryAttempt(
  previous: WalletSyncRecoveryRecord | undefined,
  dustAppliedIndex: number,
  updatedAt = new Date().toISOString(),
): WalletSyncRecoveryRecord {
  return {
    dustAppliedIndex,
    attempts: previous?.dustAppliedIndex === dustAppliedIndex ? previous.attempts + 1 : 1,
    updatedAt,
  };
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

/**
 * Fee headroom added after the ledger's own DUST fee estimate.
 *
 * The previous 300e12-speck value came from early wallet examples and can make
 * an affordable remote-network transaction fail local coin selection. Keep the
 * current small remote-network cushion configurable for future fee changes.
 */
export function dustCostParameters() {
  return {
    additionalFeeOverhead: bigintEnv('MIDNIGHT_DUST_ADDITIONAL_FEE_OVERHEAD', 1_000n),
    feeBlocksMargin: 5,
  };
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

export class WalletSyncStalledError extends Error {
  readonly code = 'WALLET_SYNC_STALLED';

  constructor(
    readonly stallTimeoutMs: number,
    readonly dustAppliedIndex: number,
    readonly stalledStreams: string[],
    readonly progress: string,
  ) {
    super(
      `Midnight wallet sync made no applied-index progress for ${stallTimeoutMs}ms ` +
        `(stalled=${stalledStreams.join(', ')}, DUST applied=${dustAppliedIndex}). ${progress}`,
    );
    this.name = 'WalletSyncStalledError';
  }
}

export class WalletSyncRecoveryExhaustedError extends Error {
  readonly code = 'WALLET_SYNC_RECOVERY_EXHAUSTED';

  constructor(readonly attempt: number, readonly dustAppliedIndex: number) {
    super(
      `Midnight wallet sync stalled ${attempt} times at DUST applied index ${dustAppliedIndex}. ` +
        'The active checkpoint was quarantined; automatic restart is stopped to avoid an infinite cold-replay loop.',
    );
    this.name = 'WalletSyncRecoveryExhaustedError';
  }
}

export function isWalletSyncRecoveryExhausted(error: unknown): error is WalletSyncRecoveryExhaustedError {
  return error instanceof WalletSyncRecoveryExhaustedError ||
    (error instanceof Error && (error as Error & { code?: string }).code === 'WALLET_SYNC_RECOVERY_EXHAUSTED');
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

function formatMemoryUsage() {
  const memory = process.memoryUsage();
  const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  return `memory(rss=${mb(memory.rss)}MB heap=${mb(memory.heapUsed)}/${mb(memory.heapTotal)}MB)`;
}

function formatDustStatus(state: WalletSyncedState) {
  return [
    `balance=${state.dust.balance(new Date()).toString()}`,
    `availableCoins=${state.dust.availableCoins.length}`,
    `pendingCoins=${state.dust.pendingCoins.length}`,
  ].join(' ');
}

export type WalletAppliedProgress = {
  shielded: bigint;
  dust: bigint;
  unshielded: bigint;
};

function bigintProgressValue(progress: unknown, key: string): bigint {
  const value = (progress as Record<string, unknown> | undefined)?.[key];
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.floor(value)));
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

export function walletAppliedProgress(state: WalletSyncedState): WalletAppliedProgress {
  return {
    shielded: bigintProgressValue(state.shielded.state.progress, 'appliedIndex'),
    dust: bigintProgressValue(state.dust.state.progress, 'appliedIndex'),
    unshielded: bigintProgressValue(state.unshielded.progress, 'appliedId'),
  };
}

export function hasWalletAppliedProgress(previous: WalletAppliedProgress, next: WalletAppliedProgress): boolean {
  return next.shielded > previous.shielded || next.dust > previous.dust || next.unshielded > previous.unshielded;
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

/**
 * Fail fast before starting four wallet services when the public node websocket is
 * accepting TCP connections but not answering JSON-RPC. Without this guard the SDK
 * waits 60 seconds per initialization and may leave reconnecting providers behind.
 */
export async function assertNodeRpcResponsive(config: NetworkConfig): Promise<void> {
  const waitMs = timeoutMs('MIDNIGHT_RPC_PREFLIGHT_TIMEOUT_MS', 15_000);
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(config.nodeWS);
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`RPC preflight timed out after ${waitMs}ms waiting for ${config.nodeWS}`));
    }, waitMs);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // terminate() is deliberate: this socket is a one-shot health probe and must not
      // enter the provider-style reconnect loop after a failed or successful response.
      try { ws.terminate(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve();
    };

    ws.once('open', () => {
      try {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] }));
      } catch (error) {
        finish(new Error(`RPC preflight could not query ${config.nodeWS}: ${errorMessage(error)}`));
      }
    });
    ws.on('message', (raw) => {
      try {
        const response = JSON.parse(String(raw)) as { id?: number; result?: unknown; error?: unknown };
        if (response.id !== 1) return;
        if (response.error) {
          finish(new Error(`RPC preflight failed for ${config.nodeWS}: ${JSON.stringify(response.error)}`));
          return;
        }
        if (response.result == null) {
          finish(new Error(`RPC preflight received an empty system_health response from ${config.nodeWS}`));
          return;
        }
        finish();
      } catch (error) {
        finish(new Error(`RPC preflight received an invalid response from ${config.nodeWS}: ${errorMessage(error)}`));
      }
    });
    ws.once('error', (error) => {
      finish(new Error(`RPC preflight websocket error for ${config.nodeWS}: ${errorMessage(error)}`));
    });
    ws.once('close', (code, reason) => {
      if (!settled) finish(new Error(`RPC preflight websocket closed for ${config.nodeWS}: ${code} ${String(reason)}`));
    });
  });
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

export async function createWallet(
  seedHex: string,
  network: SupportedNetwork,
  config: NetworkConfig,
  options: CreateWalletOptions = {},
): Promise<WalletContext> {
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
  await assertNodeRpcResponsive(config);
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
  const costParameters = dustCostParameters();
  const indexerClientConnection = {
    indexerHttpUrl: config.indexer,
    indexerWsUrl: config.indexerWS,
  };

  // wallet-sdk 4.x: each wallet factory takes only its own config slice (no more
  // shared provingServerUrl/relayURL on the per-wallet configs). The proving/
  // submission endpoints live on the WalletFacade configuration below.
  const shieldedClass = CustomShieldedWallet(
    { networkId: network, indexerClientConnection, txHistoryStorage },
    new ShieldedV1Builder()
      .withDefaults()
      .withTransactionHistory(() => makeHeadlessTransactionHistoryService()),
  );
  const unshieldedClass = UnshieldedWallet({ networkId: network, indexerClientConnection, txHistoryStorage });
  const dustClass = CustomDustWallet(
    { networkId: network, indexerClientConnection, txHistoryStorage, costParameters },
    new DustV1Builder()
      .withDefaults()
      .withTransactionHistory(() => makeHeadlessTransactionHistoryService()),
  );

  // Resume from a cached synced state when available (incremental sync); otherwise
  // start fresh. Any restore failure (stale/incompatible cache) falls back to fresh.
  const address = String(unshieldedKeystore.getBech32Address());
  const cachePolicy = options.cachePolicy ?? 'prefer-checkpoint';
  const cachedState = loadWalletStateCache(network, address, cachePolicy);
  if (cachePolicy === 'require-last-good' && !cachedState) {
    throw new Error(
      `No valid fully-synced wallet snapshot exists at ${walletLastGoodCachePath(network)}. ` +
        `Run "npm run wallet:v3:prepare:${network}" first. The deploy command will not perform a cold wallet replay.`,
    );
  }
  const buildFresh = () => ({
    shielded: shieldedClass.startWithSecretKeys(shieldedSecretKeys),
    unshielded: unshieldedClass.startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: dustClass.startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  let wallets: ReturnType<typeof buildFresh>;
  if (cachedState) {
    try {
      const cache = cachedState.cache;
      wallets = {
        shielded: shieldedClass.restore(cache.shielded),
        unshielded: unshieldedClass.restore(cache.unshielded),
        dust: dustClass.restore(cache.dust),
      };
      console.log(
        `Restored wallet state from ${cachedState.source}; syncing incrementally from the cached point.`,
      );
    } catch (error) {
      if (cachePolicy === 'require-last-good') {
        throw new Error(
          `The fully-synced wallet snapshot could not be restored; rerun the wallet preparation command: ${errorMessage(error)}`,
          { cause: error },
        );
      }
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
  try {
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
  } catch (error) {
    // createWallet has not returned yet, so the caller cannot own cleanup. Stop every
    // partially-started service here or its websocket will keep reconnecting after the
    // supervisor starts a replacement process.
    try {
      await withTimeout(
        wallet.stop(),
        timeoutMs('KEEPER_WALLET_STOP_TIMEOUT_MS', 30_000),
        'Partially-started Midnight wallet did not stop within the cleanup timeout.',
      );
    } catch (stopError) {
      console.warn(`Could not stop partially-started Midnight wallet: ${errorMessage(stopError)}`);
    }
    throw error;
  }
  console.log('Midnight wallet services started (shielded + unshielded + DUST).');

  // The active file is a resumable working checkpoint. Only a fully synced or
  // post-transaction-settled state is also promoted to `.last-good`, so a failed
  // replay can be quarantined without losing the last state known to be safe.
  let observedApplied: number | undefined;
  let lastSavedApplied: number | undefined;
  let saveInFlight: Promise<boolean> | undefined;

  const writeJsonAtomic = (file: string, data: WalletStateCache) => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  };

  const performCacheWrite = async (promoteLastKnownGood: boolean, requireProgress: boolean): Promise<boolean> => {
    if (!walletCacheEnabled()) return false;
    if (requireProgress && (observedApplied === undefined || observedApplied <= (lastSavedApplied ?? observedApplied))) {
      return false;
    }
    try {
      const data: WalletStateCache = {
        version: WALLET_CACHE_VERSION,
        fingerprint: WALLET_CACHE_FINGERPRINT,
        network,
        address,
        shielded: await wallet.shielded.serializeState(),
        unshielded: await wallet.unshielded.serializeState(),
        dust: await wallet.dust.serializeState(),
      };
      fs.mkdirSync(walletCacheDir, { recursive: true });
      writeJsonAtomic(walletCachePath(network), data);
      if (promoteLastKnownGood) {
        writeJsonAtomic(walletLastGoodCachePath(network), data);
        try { fs.unlinkSync(walletSyncRecoveryPath(network)); } catch { /* no recovery marker */ }
      }
      lastSavedApplied = observedApplied;
      return true;
    } catch (error) {
      console.warn(`Could not cache wallet state: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const writeCache = async (promoteLastKnownGood: boolean, requireProgress = false): Promise<boolean> => {
    if (saveInFlight) await saveInFlight;
    const operation = performCacheWrite(promoteLastKnownGood, requireProgress);
    saveInFlight = operation;
    try {
      return await operation;
    } finally {
      if (saveInFlight === operation) saveInFlight = undefined;
    }
  };

  const saveState = async () => {
    if (await writeCache(true)) {
      console.log(`Wallet sync state cached and promoted to last-known-good: ${walletCachePath(network)}`);
    }
  };

  const saveCheckpoint = async () => {
    if (await writeCache(false, true)) {
      console.log(`Wallet sync checkpoint cached at applied=${observedApplied ?? 0}.`);
    }
  };

  const recoverFromSyncStall = async (error: WalletSyncStalledError): Promise<WalletSyncRecoveryResult> => {
    if (saveInFlight) await saveInFlight;
    fs.mkdirSync(walletCacheDir, { recursive: true });
    const recoveryFile = walletSyncRecoveryPath(network);
    let previous: WalletSyncRecoveryRecord | undefined;
    try {
      previous = JSON.parse(fs.readFileSync(recoveryFile, 'utf8')) as WalletSyncRecoveryRecord;
    } catch {
      previous = undefined;
    }
    const recovery = nextWalletSyncRecoveryAttempt(previous, error.dustAppliedIndex);
    fs.writeFileSync(recoveryFile, JSON.stringify(recovery, null, 2));

    const activeFile = walletCachePath(network);
    let quarantinedPath: string | undefined;
    if (fs.existsSync(activeFile)) {
      const suffix = recovery.updatedAt.replace(/[^0-9]/g, '').slice(0, 14);
      quarantinedPath = `${activeFile}.quarantine-${suffix}-attempt-${recovery.attempts}`;
      fs.renameSync(activeFile, quarantinedPath);
    }

    const lastGoodFile = walletLastGoodCachePath(network);
    const restoredLastKnownGood = fs.existsSync(lastGoodFile);
    if (restoredLastKnownGood) fs.copyFileSync(lastGoodFile, activeFile);

    const maxAttempts = Math.max(
      1,
      Math.floor(Number(process.env.MIDNIGHT_WALLET_SYNC_RECOVERY_ATTEMPTS ?? 2)) || 2,
    );
    return {
      attempt: recovery.attempts,
      exhausted: recovery.attempts >= maxAttempts,
      quarantinedPath,
      restoredLastKnownGood,
    };
  };

  // Progress-driven checkpoint DURING the (long, first-time) sync: every time the
  // applied index advances by MIDNIGHT_WALLET_CHECKPOINT_EVERY events (default
  // 200k) we persist, so an interruption — dropped websocket, timeout, Ctrl-C —
  // resumes from the last checkpoint instead of restarting from zero.
  const checkpointEvery = Number(process.env.MIDNIGHT_WALLET_CHECKPOINT_EVERY ?? 200_000);
  if (walletCacheEnabled() && Number.isFinite(checkpointEvery) && checkpointEvery > 0) {
    let lastCheckpointAt: number | undefined;
    let pending = false;
    wallet
      .state()
      .pipe(Rx.auditTime(2_000))
      .subscribe((state) => {
        const applied = dustAppliedIndex(state);
        observedApplied = applied;
        if (lastCheckpointAt === undefined) {
          // Establish the restored/fresh baseline without rewriting an unchanged
          // cache as if it were new progress.
          lastCheckpointAt = applied;
          lastSavedApplied = applied;
          return;
        }
        if (pending || applied - lastCheckpointAt < checkpointEvery) return;
        pending = true;
        lastCheckpointAt = applied;
        void writeCache(false, true).then((ok) => {
          pending = false;
          if (ok) console.log(`Sync checkpoint saved at applied=${applied}; a failed run resumes from here.`);
        });
      });
  }

  return {
    wallet,
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
    saveState,
    saveCheckpoint,
    recoverFromSyncStall,
  };
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

export type WalletTransactionCheckpoint = {
  /** DUST event index applied before the transaction starts proving. */
  dustAppliedIndex: number;
};

/**
 * Capture the DUST sync position immediately before building a transaction.
 * The post-transaction barrier requires this index to advance, which prevents a
 * merely "currently synced" wallet from satisfying the barrier against the
 * pre-transaction Indexer view.
 */
export async function captureWalletTransactionCheckpoint(
  wallet: WalletFacade,
): Promise<WalletTransactionCheckpoint> {
  const state = await currentWalletState(wallet);
  return { dustAppliedIndex: dustAppliedIndex(state) };
}

/** Exported as a small pure predicate so the strict Keeper barrier is testable. */
export function isWalletTransactionSettled(
  state: Awaited<ReturnType<typeof currentWalletState>>,
  checkpoint: WalletTransactionCheckpoint,
): boolean {
  return (
    // callTx already waits for Indexer finalization. The pending service then
    // independently observes that finalized transaction through the Indexer.
    state.pending.all.length === 0 &&
    // A DUST spend is booked while balancing. Do not let another proof reuse
    // the session until the wallet has consumed/released every booked DUST coin.
    state.dust.pendingCoins.length === 0 &&
    // Require the wallet to have applied at least one new DUST-relevant event
    // after the pre-proof checkpoint, not just report the old tip as synced.
    dustAppliedIndex(state) > checkpoint.dustAppliedIndex &&
    // Publishing uses an exact post-transaction barrier even if a looser gap is
    // configured for the initial, potentially very long wallet replay.
    isWalletStateSyncedWithin(state, 0n)
  );
}

/**
 * Block before the next proof until the finalized transaction is visible to the
 * wallet, all pending bookkeeping is cleared, and every wallet stream has caught
 * up exactly to the Indexer tip. A timeout is fatal to the current Keeper context.
 */
export async function waitForWalletTransactionSettlement(
  wallet: WalletFacade,
  txId: string,
  checkpoint: WalletTransactionCheckpoint,
) {
  const waitMs = timeoutMs('MIDNIGHT_WALLET_POST_TX_SYNC_TIMEOUT_MS', 300_000);
  console.log(
    `Waiting for wallet/DUST confirmation of transaction ${txId || '(unknown)'} ` +
      `(DUST applied index > ${checkpoint.dustAppliedIndex})...`,
  );

  const state = await Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.filter((next) => isWalletTransactionSettled(next, checkpoint)),
      Rx.timeout({
        first: waitMs,
        with: () => Rx.throwError(
          () => new Error(
            `Timed out after ${waitMs}ms waiting for wallet sync and DUST pending state to clear ` +
              `after transaction ${txId || '(unknown)'}.`,
          ),
        ),
      }),
    ),
  );

  console.log(
    `Wallet/DUST confirmed transaction ${txId || '(unknown)'} ` +
      `(DUST applied=${dustAppliedIndex(state)}, pending=0).`,
  );
  return state;
}

export async function submitTransactionOnce(tx: { serialize(): Uint8Array }, config: NetworkConfig) {
  const provider = new WsProvider(config.nodeWS);
  let api: ApiPromise | undefined;

  try {
    api = await ApiPromise.create({
      provider,
      throwOnConnect: false,
      noInitWarn: true,
    });
    const serializedTx = u8aToHex(tx.serialize());
    const txHash = await (api.tx as any).midnight.sendMnTransaction(serializedTx).send();
    return String(txHash);
  } finally {
    // ApiPromise.create itself can reject after the 60s RPC initialization timeout.
    // In that case there is no `api` to disconnect, but the WsProvider is already live.
    if (api) await api.disconnect().catch(() => undefined);
    else await provider.disconnect().catch(() => undefined);
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

  // Do not leave an operator staring at a silent terminal for up to an hour.
  // `tap` runs before the readiness filters, so stalled/zero-DUST states remain
  // visible together with all three cursors and process memory.
  let lastPrintedAt = 0;

  return Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(
      Rx.auditTime(5_000),
      Rx.tap((state) => {
        const now = Date.now();
        if (now - lastPrintedAt < 5_000) return;
        lastPrintedAt = now;
        console.log(
          `DUST wait progress: ${formatSyncProgress(state)} ${formatDustStatus(state)} ${formatMemoryUsage()}`,
        );
      }),
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

export async function waitForSyncedState(wallet: WalletFacade, allowedGap = syncAllowedGap()) {
  const stallTimeoutMs = timeoutMs('MIDNIGHT_WALLET_SYNC_STALL_TIMEOUT_MS', 10 * 60 * 1000);
  const progressSubscription = wallet.state().pipe(Rx.auditTime(5_000)).subscribe({
    next: (state) => console.log(`${formatSyncProgress(state)} ${formatDustStatus(state)} ${formatMemoryUsage()}`),
  });

  console.log(
    `Waiting for Midnight wallet sync (allowed gap: ${allowedGap.toString()}, ` +
      `stall timeout: ${stallTimeoutMs}ms)...`,
  );

  let latestProgress: WalletAppliedProgress | undefined;
  let latestWalletState: WalletSyncedState | undefined;
  let latestStateText = 'Wallet sync progress has not emitted a state yet.';
  const watchStartedAt = Date.now();
  const lastAppliedProgressAt = {
    shielded: watchStartedAt,
    dust: watchStartedAt,
    unshielded: watchStartedAt,
  };
  let rejectStall: ((error: WalletSyncStalledError) => void) | undefined;
  const stallPromise = new Promise<never>((_resolve, reject) => {
    rejectStall = reject;
  });
  const appliedProgressSubscription = wallet.state().subscribe({
    next: (state) => {
      const next = walletAppliedProgress(state);
      latestWalletState = state;
      latestStateText = formatSyncProgress(state);
      const now = Date.now();
      if (!latestProgress || next.shielded > latestProgress.shielded) {
        lastAppliedProgressAt.shielded = now;
      }
      if (!latestProgress || next.dust > latestProgress.dust) {
        lastAppliedProgressAt.dust = now;
      }
      if (!latestProgress || next.unshielded > latestProgress.unshielded) {
        lastAppliedProgressAt.unshielded = now;
      }
      latestProgress = next;
    },
  });
  const stallCheckEveryMs = Math.max(1_000, Math.min(30_000, Math.floor(stallTimeoutMs / 4)));
  const stallTimer = setInterval(() => {
    const now = Date.now();
    const stalledStreams: string[] = [];
    if (!latestProgress || !latestWalletState) {
      if (now - watchStartedAt < stallTimeoutMs) return;
      stalledStreams.push('all (no wallet state emitted)');
    } else {
      if (
        !latestWalletState.shielded.state.progress.isCompleteWithin(allowedGap) &&
        now - lastAppliedProgressAt.shielded >= stallTimeoutMs
      ) stalledStreams.push('shielded');
      if (
        !latestWalletState.dust.state.progress.isCompleteWithin(allowedGap) &&
        now - lastAppliedProgressAt.dust >= stallTimeoutMs
      ) stalledStreams.push('dust');
      if (
        !latestWalletState.unshielded.progress.isCompleteWithin(allowedGap) &&
        now - lastAppliedProgressAt.unshielded >= stallTimeoutMs
      ) stalledStreams.push('unshielded');
    }
    if (stalledStreams.length === 0) return;
    rejectStall?.(
      new WalletSyncStalledError(
        stallTimeoutMs,
        Number(latestProgress?.dust ?? 0n),
        stalledStreams,
        `Stalled stream(s): ${stalledStreams.join(', ')}. ${latestStateText}`,
      ),
    );
  }, stallCheckEveryMs);

  try {
    const [shielded, unshielded, dust, pending] = await withTimeout(
      Promise.race([
        Promise.all([
          wallet.shielded.waitForSyncedState(allowedGap),
          wallet.unshielded.waitForSyncedState(allowedGap),
          wallet.dust.waitForSyncedState(allowedGap),
          Rx.firstValueFrom(wallet.pendingTransactionsService.state()),
        ]),
        stallPromise,
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
    clearInterval(stallTimer);
    appliedProgressSubscription.unsubscribe();
    progressSubscription.unsubscribe();
  }
}

export type CreateProvidersOptions = {
  /** Compiled-contract asset dir (defaults to the active V2 assets). Threading it
   *  here (instead of overwriting `providers.zkConfigProvider` after the fact, as
   *  separate deploy/market callers historically did) also points the proofProvider at the
   *  right prover keys, since it is constructed from this same zkConfigProvider. */
  zkConfigPath?: string;
  /** Circuit assets that this workflow will use. The upstream HTTP proof provider
   *  deliberately treats ZK-provider read failures as "no key material", which can
   *  turn a missing/wrong asset directory into an opaque proof-server `bad input`.
   *  Loading these circuits here makes that configuration error fail locally. */
  expectedCircuitIds?: readonly string[];
  /** Which token kinds balanceTx may spend. V2 `place_bet` takes a
   *  ShieldedCoinInfo argument, so transaction flows normally pass `all`. */
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
      submitTx: (tx: any) => {
        // Size is public operational telemetry; never print the serialized tx.
        // This makes block-limit failures distinguishable from fee/proof errors.
        const serializedBytes = tx.serialize().length;
        console.log(`Submitting finalized transaction: ${serializedBytes} bytes.`);
        return walletCtx.wallet.submitTransaction(tx) as any;
      },
    },
  };
}
