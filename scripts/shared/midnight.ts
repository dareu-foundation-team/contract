import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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
  saveCheckpoint: () => Promise<boolean>;
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
  /** Use the supplied deployer secret even when the generic wallet mnemonic is configured. */
  ignoreConfiguredMnemonic?: boolean;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file lives in scripts/shared/, so the contract root is two levels up.
export const contractRoot = path.resolve(__dirname, '..', '..');
export const zkConfigPath = path.resolve(contractRoot, 'src', 'managed', 'dareu-v2');

// On-disk cache of synced wallet state so repeated deploy/keeper runs sync
// incrementally instead of replaying ~1M events from scratch each time.
const walletLockDir = path.join(contractRoot, '.wallet-locks');
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
  schemaVersion?: number;
  fingerprint?: string;
  network: SupportedNetwork;
  genesisHash?: string;
  walletRole?: string;
  createdAt?: string;
  applied?: Record<'shielded' | 'dust' | 'unshielded', string>;
  highest?: Record<'shielded' | 'dust' | 'unshielded', string>;
  blobHashes?: Record<'shielded' | 'dust' | 'unshielded', string>;
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
  return path.join(walletCacheDirectory(), `${network}${namespace ? `-${namespace}` : ''}.json`);
}

function walletCacheDirectory(): string {
  const configured = process.env.MIDNIGHT_WALLET_CACHE_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(contractRoot, '.wallet-cache');
}

function assertWalletCacheStorage(): void {
  if (!walletCacheEnabled()) return;
  const directory = walletCacheDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
  const marker = path.join(directory, '.durable-wallet-cache');
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'Mount this directory on durable storage in deployed environments.\n', { mode: 0o600 });
  }
  console.log(`Wallet cache storage: ${directory}`);
}

function walletLastGoodCachePath(network: SupportedNetwork): string {
  return `${walletCachePath(network)}.last-good`;
}

function walletSyncRecoveryPath(network: SupportedNetwork): string {
  return `${walletCachePath(network)}.sync-recovery.json`;
}

function walletCanaryPath(network: SupportedNetwork): string {
  return `${walletCachePath(network)}.requires-canary.json`;
}

function fileSha256(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function walletRequiresCanary(network: SupportedNetwork): boolean {
  return fs.existsSync(walletCanaryPath(network));
}

export function clearWalletCanaryRequirement(network: SupportedNetwork): void {
  try { fs.unlinkSync(walletCanaryPath(network)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function chooseWalletSyncRecoveryMode(
  activeHash: string | undefined,
  lastGoodHash: string | undefined,
): 'last-good' | 'cold' {
  return lastGoodHash && lastGoodHash !== activeHash ? 'last-good' : 'cold';
}

function walletCacheEnabled(): boolean {
  return (process.env.MIDNIGHT_WALLET_CACHE?.trim() ?? '1') !== '0';
}

function acquireWalletAddressLock(address: string): () => void {
  fs.mkdirSync(walletLockDir, { recursive: true });
  const lockFile = path.join(walletLockDir, `${createHash('sha256').update(address).digest('hex')}.lock`);
  const record = () => JSON.stringify({
    pid: process.pid,
    address,
    role: storageNamespace('MIDNIGHT_WALLET_CACHE_NAMESPACE') ?? 'deployer',
    startedAt: new Date().toISOString(),
  });
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(fd, record());
      fs.closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let ownerPid = 0;
      try {
        ownerPid = Number((JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: number }).pid ?? 0);
      } catch { /* malformed locks are treated as stale */ }
      try {
        if (ownerPid > 0) process.kill(ownerPid, 0);
      } catch {
        try { fs.unlinkSync(lockFile); } catch { /* another process won recovery */ }
        continue;
      }
      throw new Error(
        `Wallet address ${address} is already owned by live process ${ownerPid}. ` +
          'Two processes may not submit transactions with the same Midnight wallet.',
      );
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: number };
      if (owner.pid === process.pid) fs.unlinkSync(lockFile);
    } catch { /* already removed */ }
  };
}

function acquireCheckpointWriteLock(lockFile: string): () => void {
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      fs.closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let ownerPid = 0;
      try {
        ownerPid = Number((JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: number }).pid ?? 0);
      } catch { /* malformed checkpoint locks are stale */ }
      let ownerAlive = false;
      if (ownerPid > 0) {
        try {
          process.kill(ownerPid, 0);
          ownerAlive = true;
        } catch { /* dead owner */ }
      }
      if (ownerAlive) {
        throw new Error(`Wallet checkpoint is already being written by live process ${ownerPid}.`);
      }
      try { fs.unlinkSync(lockFile); } catch { /* another process recovered it first */ }
    }
  }
  return () => {
    try {
      const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: number };
      if (owner.pid === process.pid) fs.unlinkSync(lockFile);
    } catch { /* already released */ }
  };
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
function readWalletStateCache(
  file: string,
  network: SupportedNetwork,
  address: string,
  genesisHash: string,
): WalletStateCache | undefined {
  if (!fs.existsSync(file)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as WalletStateCache;
  if (parsed.version !== WALLET_CACHE_VERSION || parsed.network !== network || parsed.address !== address) {
    return undefined;
  }
  if (parsed.genesisHash && parsed.genesisHash !== genesisHash) return undefined;
  // Never restore an unversioned/foreign SDK snapshot. A clean replay is slower,
  // but it is the only safe recovery when tree state and appliedIndex disagree.
  if (!isWalletCacheFingerprintCompatible(parsed.fingerprint)) return undefined;
  if (!parsed.shielded || !parsed.unshielded || !parsed.dust) return undefined;
  if (parsed.schemaVersion && parsed.schemaVersion >= 3) {
    if (parsed.genesisHash !== genesisHash) return undefined;
    if (parsed.walletRole !== (storageNamespace('MIDNIGHT_WALLET_CACHE_NAMESPACE') ?? 'deployer')) return undefined;
    const expected = parsed.blobHashes;
    if (!expected) return undefined;
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    if (
      digest(parsed.shielded) !== expected.shielded ||
      digest(parsed.unshielded) !== expected.unshielded ||
      digest(parsed.dust) !== expected.dust
    ) return undefined;
  }
  return parsed;
}

function loadWalletStateCache(
  network: SupportedNetwork,
  address: string,
  genesisHash: string,
  policy: WalletCachePolicy,
): { cache: WalletStateCache; source: 'checkpoint' | 'last-good' } | undefined {
  if (!walletCacheEnabled()) return undefined;
  try {
    if (policy === 'require-last-good') {
      const cache = readWalletStateCache(walletLastGoodCachePath(network), network, address, genesisHash);
      return cache ? { cache, source: 'last-good' } : undefined;
    }
    const checkpoint = readWalletStateCache(walletCachePath(network), network, address, genesisHash);
    if (checkpoint) return { cache: checkpoint, source: 'checkpoint' };
    const lastGood = readWalletStateCache(walletLastGoodCachePath(network), network, address, genesisHash);
    return lastGood ? { cache: lastGood, source: 'last-good' } : undefined;
  } catch {
    return undefined;
  }
}

type WalletSyncRecoveryRecord = {
  dustAppliedIndex: number;
  attempts: number;
  checkpointHash?: string;
  recoveryMode?: 'last-good' | 'cold';
  updatedAt: string;
};

export type WalletSyncRecoveryResult = {
  attempt: number;
  exhausted: boolean;
  quarantinedPath?: string;
  quarantinedLastGoodPath?: string;
  restoredLastKnownGood: boolean;
  recoveryMode: 'last-good' | 'cold';
};

export function nextWalletSyncRecoveryAttempt(
  previous: WalletSyncRecoveryRecord | undefined,
  dustAppliedIndex: number,
  updatedAt = new Date().toISOString(),
  checkpointHash?: string,
  recoveryMode?: 'last-good' | 'cold',
): WalletSyncRecoveryRecord {
  // The applied index remains the safety breaker. The checkpoint hash explains
  // whether a retry reused the same bytes, but must not reset the breaker after
  // a cold replay reaches the same poisoned Indexer position.
  // Legacy recovery markers did not identify the checkpoint. Reset them once so
  // the new cold-replay path gets a chance instead of immediately inheriting an
  // already-exhausted counter from the old restore loop.
  const sameFailure = previous?.checkpointHash !== undefined &&
    previous.dustAppliedIndex === dustAppliedIndex;
  return {
    dustAppliedIndex,
    attempts: sameFailure ? previous!.attempts + 1 : 1,
    checkpointHash,
    recoveryMode,
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
    readonly disconnectedStreams: string[] = [],
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

export class WalletReplayMemoryLimitError extends Error {
  readonly code = 'WALLET_REPLAY_MEMORY_LIMIT';

  constructor(readonly heapUsedMb: number, readonly limitMb: number) {
    super(
      `Wallet replay reached the ${limitMb}MB heap segment limit ` +
        `(heapUsed=${heapUsedMb}MB); checkpointing before a fresh-process resume.`,
    );
    this.name = 'WalletReplayMemoryLimitError';
  }
}

export class WalletReplaySegmentBoundaryError extends Error {
  readonly code = 'WALLET_REPLAY_SEGMENT_BOUNDARY';

  constructor(
    readonly reason: 'cursor' | 'elapsed',
    readonly dustAppliedIndex: number,
    readonly detail: string,
  ) {
    super(
      `Wallet replay reached a safe ${reason} segment boundary at DUST applied=${dustAppliedIndex} ` +
        `(${detail}); checkpointing before a fresh-process resume.`,
    );
    this.name = 'WalletReplaySegmentBoundaryError';
  }
}

export function isWalletReplayMemoryLimit(error: unknown): error is WalletReplayMemoryLimitError {
  return error instanceof WalletReplayMemoryLimitError ||
    (error instanceof Error && (error as Error & { code?: string }).code === 'WALLET_REPLAY_MEMORY_LIMIT');
}

export function isWalletReplaySegmentBoundary(
  error: unknown,
): error is WalletReplayMemoryLimitError | WalletReplaySegmentBoundaryError {
  return isWalletReplayMemoryLimit(error) || error instanceof WalletReplaySegmentBoundaryError ||
    (error instanceof Error && (error as Error & { code?: string }).code === 'WALLET_REPLAY_SEGMENT_BOUNDARY');
}

/** Lower the next replay child's soft heap boundary after an OOM. */
export function nextWalletReplayHeapLimitMb(currentMb: number, minimumMb = 2_048): number {
  const current = Number.isFinite(currentMb) && currentMb > 0 ? Math.floor(currentMb) : 4_096;
  const minimum = Number.isFinite(minimumMb) && minimumMb > 0 ? Math.floor(minimumMb) : 2_048;
  const reduced = Math.floor((current * 0.75) / 256) * 256;
  return Math.max(minimum, reduced);
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

type WalletHighestProgress = WalletAppliedProgress;

function walletHighestProgress(state: WalletSyncedState): WalletHighestProgress {
  return {
    shielded: bigintProgressValue(state.shielded.state.progress, 'highestRelevantWalletIndex'),
    dust: bigintProgressValue(state.dust.state.progress, 'highestRelevantWalletIndex'),
    unshielded: bigintProgressValue(state.unshielded.progress, 'highestTransactionId'),
  };
}

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

export function walletReplaySegmentStream(
  baseline: WalletAppliedProgress,
  next: WalletAppliedProgress,
  threshold: bigint,
): 'dust' | undefined {
  // DUST is the slow replay bottleneck and MIDNIGHT_WALLET_CHECKPOINT_EVERY is
  // explicitly its checkpoint cadence. Shielded/unshielded can jump quickly;
  // elapsed-time and heap boundaries still protect those streams.
  return next.dust - baseline.dust >= threshold ? 'dust' : undefined;
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

async function queryGenesisHash(config: NetworkConfig): Promise<string> {
  const response = await withTimeout(
    fetch(config.node, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_getBlockHash', params: [0] }),
    }),
    timeoutMs('MIDNIGHT_RPC_PREFLIGHT_TIMEOUT_MS', 15_000),
    `Timed out while reading the genesis hash from ${config.node}.`,
  );
  if (!response.ok) throw new Error(`Genesis hash RPC failed with HTTP ${response.status}.`);
  const payload = await response.json() as { result?: unknown; error?: unknown };
  if (typeof payload.result !== 'string' || !payload.result) {
    throw new Error(`Genesis hash RPC returned an invalid response: ${JSON.stringify(payload.error ?? payload)}`);
  }
  return payload.result;
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
export function resolveWalletSeedHex(rawSeedOrMnemonic: string, ignoreConfiguredMnemonic = false): string {
  // Strip surrounding whitespace and any quote characters — including the curly/
  // smart quotes (“ ” ‘ ’) that copy-paste often introduces — from both ends.
  const dequote = (s: string) => s.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '');
  const explicitMnemonic = ignoreConfiguredMnemonic
    ? ''
    : dequote(process.env.MIDNIGHT_WALLET_MNEMONIC ?? '');
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
  const mnemonic = secretValue('MIDNIGHT_WALLET_MNEMONIC');
  const seed = secretValue('MIDNIGHT_WALLET_SEED');
  const value = mnemonic || seed;
  if (!value) {
    throw new Error(
      'Set MIDNIGHT_WALLET_MNEMONIC (a BIP39 recovery phrase / 助记词) or MIDNIGHT_WALLET_SEED ' +
        '(a hex HD seed) in contract/.env.local.',
    );
  }
  return value;
}

/**
 * Deployment uses a dedicated wallet identity so admin transactions can never
 * race a category keeper for the same DUST coins. Do not fall back to the
 * generic wallet secret: a missing deployer secret must fail closed.
 */
export function requiredDeployerWalletSeedOrMnemonic(): string {
  const value = secretValue('MIDNIGHT_DEPLOYER_WALLET_MNEMONIC')
    || secretValue('MIDNIGHT_DEPLOYER_WALLET_SEED');
  if (!value) {
    throw new Error(
      'Set MIDNIGHT_DEPLOYER_WALLET_MNEMONIC (a BIP39 recovery phrase) or ' +
        'MIDNIGHT_DEPLOYER_WALLET_SEED (a hex HD seed) in contract/.env.local.',
    );
  }
  return value;
}

/** Manual/demo market commands use a disposable wallet, never the deployer. */
export function requiredTestWalletSeedOrMnemonic(): string {
  const value = secretValue('MIDNIGHT_TEST_WALLET_MNEMONIC')
    || secretValue('MIDNIGHT_TEST_WALLET_SEED');
  if (!value) {
    throw new Error(
      'Set MIDNIGHT_TEST_WALLET_MNEMONIC (a BIP39 recovery phrase) or ' +
        'MIDNIGHT_TEST_WALLET_SEED (a hex HD seed) before running a manual market command.',
    );
  }
  return value;
}

function secretValue(name: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const file = process.env[`${name}_FILE`]?.trim();
  if (!file) return undefined;
  const resolved = path.isAbsolute(file) ? file : path.resolve(contractRoot, file);
  const stat = fs.statSync(resolved);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${name}_FILE must not be group/world accessible: ${resolved}`);
  }
  const value = fs.readFileSync(resolved, 'utf8').trim();
  if (!value) throw new Error(`${name}_FILE is empty: ${resolved}`);
  return value;
}

export function deriveKeys(seedOrMnemonic: string, ignoreConfiguredMnemonic = false) {
  const seedHex = resolveWalletSeedHex(seedOrMnemonic, ignoreConfiguredMnemonic);
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
  assertWalletCacheStorage();
  await assertNodeRpcResponsive(config);
  const genesisHash = await queryGenesisHash(config);
  // NOTE: ledger-v8 8.1.0 parses & replays the v9 `DustGenerationDtimeUpdate` events
  // natively, so the old replay-filter workaround (removed) is no longer needed. If
  // DUST replay errors ever return, recover the patch from git history.

  const keys = deriveKeys(seedHex, options.ignoreConfiguredMnemonic);
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
  const cachedState = loadWalletStateCache(network, address, genesisHash, cachePolicy);
  if (cachePolicy === 'require-last-good' && !cachedState) {
    const walletRole = storageNamespace('MIDNIGHT_WALLET_CACHE_NAMESPACE');
    const prepareCommand = walletRole
      ? `npm run keeper:v3:prepare-wallet -- ${network} ${walletRole}`
      : `npm run wallet:v3:prepare:${network}`;
    throw new Error(
      `No valid fully-synced wallet snapshot exists at ${walletLastGoodCachePath(network)}. ` +
        `Run "${prepareCommand}" first. Transaction processes will not perform a cold wallet replay.`,
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
        `Restored wallet state from ${cachedState.source}; syncing incrementally from the cached point` +
          `${cache.applied ? ` (applied shielded=${cache.applied.shielded} dust=${cache.applied.dust} unshielded=${cache.applied.unshielded})` : ''}` +
          `${fileSha256(cachedState.source === 'checkpoint' ? walletCachePath(network) : walletLastGoodCachePath(network))
            ? ` checkpointHash=${fileSha256(cachedState.source === 'checkpoint' ? walletCachePath(network) : walletLastGoodCachePath(network))}`
            : ''}.`,
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

  const releaseAddressLock = acquireWalletAddressLock(address);
  let wallet: WalletFacade;
  try {
    wallet = await WalletFacade.init({
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
  } catch (error) {
    releaseAddressLock();
    throw error;
  }
  let cacheProgressSubscription: Rx.Subscription | undefined;
  const originalStop = wallet.stop.bind(wallet);
  wallet.stop = async () => {
    try {
      return await originalStop();
    } finally {
      cacheProgressSubscription?.unsubscribe();
      releaseAddressLock();
    }
  };

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
  let observedProgress: WalletAppliedProgress | undefined;
  let observedHighest: WalletHighestProgress | undefined;
  let lastSavedProgress: WalletAppliedProgress | undefined;
  let saveInFlight: Promise<boolean> | undefined;

  const writeJsonAtomic = (file: string, data: WalletStateCache) => {
    const tmp = `${file}.tmp`;
    const lock = `${file}.write.lock`;
    const releaseWriteLock = acquireCheckpointWriteLock(lock);
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(data));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (!readWalletStateCache(tmp, network, address, genesisHash)) {
        throw new Error(`Wallet checkpoint verification failed for ${tmp}.`);
      }
      fs.renameSync(tmp, file);
    } finally {
      releaseWriteLock();
      try { fs.unlinkSync(tmp); } catch { /* renamed or cleanup on best effort */ }
    }
  };

  const performCacheWrite = async (promoteLastKnownGood: boolean, requireProgress: boolean): Promise<boolean> => {
    if (!walletCacheEnabled()) return false;
    if (
      requireProgress &&
      (!observedProgress || !lastSavedProgress || !hasWalletAppliedProgress(lastSavedProgress, observedProgress))
    ) {
      return false;
    }
    try {
      const shielded = await wallet.shielded.serializeState();
      const unshielded = await wallet.unshielded.serializeState();
      const dust = await wallet.dust.serializeState();
      // Verify that all three opaque SDK blobs are actually deserializable before
      // any file is promoted. Hash/read-back checks alone cannot detect a
      // structurally invalid wallet state.
      shieldedClass.restore(shielded);
      unshieldedClass.restore(unshielded);
      dustClass.restore(dust);
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      const stringifyProgress = (progress: WalletAppliedProgress | WalletHighestProgress | undefined) =>
        progress
          ? Object.fromEntries(Object.entries(progress).map(([key, value]) => [key, value.toString()])) as Record<'shielded' | 'dust' | 'unshielded', string>
          : undefined;
      const data: WalletStateCache = {
        version: WALLET_CACHE_VERSION,
        schemaVersion: 3,
        fingerprint: WALLET_CACHE_FINGERPRINT,
        network,
        genesisHash,
        walletRole: storageNamespace('MIDNIGHT_WALLET_CACHE_NAMESPACE') ?? 'deployer',
        createdAt: new Date().toISOString(),
        address,
        applied: stringifyProgress(observedProgress),
        highest: stringifyProgress(observedHighest),
        blobHashes: { shielded: digest(shielded), unshielded: digest(unshielded), dust: digest(dust) },
        shielded,
        unshielded,
        dust,
      };
      fs.mkdirSync(walletCacheDirectory(), { recursive: true });
      writeJsonAtomic(walletCachePath(network), data);
      if (promoteLastKnownGood) {
        writeJsonAtomic(walletLastGoodCachePath(network), data);
        try { fs.unlinkSync(walletSyncRecoveryPath(network)); } catch { /* no recovery marker */ }
      }
      lastSavedProgress = observedProgress ? { ...observedProgress } : undefined;
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
    if (!await writeCache(true)) {
      throw new Error('Could not persist and verify the fully-synced wallet last-known-good snapshot.');
    }
    console.log(`Wallet sync state cached and promoted to last-known-good: ${walletCachePath(network)}`);
  };

  const saveCheckpoint = async () => {
    const saved = await writeCache(false, true);
    if (saved) {
      console.log(`Wallet sync checkpoint cached at applied=${observedApplied ?? 0}.`);
    }
    return saved;
  };

  const recoverFromSyncStall = async (error: WalletSyncStalledError): Promise<WalletSyncRecoveryResult> => {
    if (saveInFlight) await saveInFlight;
    fs.mkdirSync(walletCacheDirectory(), { recursive: true });
    const recoveryFile = walletSyncRecoveryPath(network);
    let previous: WalletSyncRecoveryRecord | undefined;
    try {
      previous = JSON.parse(fs.readFileSync(recoveryFile, 'utf8')) as WalletSyncRecoveryRecord;
    } catch {
      previous = undefined;
    }
    const activeFile = walletCachePath(network);
    const lastGoodFile = walletLastGoodCachePath(network);
    const activeHash = fileSha256(activeFile);
    const lastGoodHash = fileSha256(lastGoodFile);
    // Restoring an identical snapshot repeats the same incompatible commitment
    // tree forever. Quarantine both copies and force a clean replay instead.
    const recoveryMode = chooseWalletSyncRecoveryMode(activeHash, lastGoodHash);
    const recovery = nextWalletSyncRecoveryAttempt(
      previous,
      error.dustAppliedIndex,
      new Date().toISOString(),
      activeHash,
      recoveryMode,
    );
    fs.writeFileSync(recoveryFile, JSON.stringify(recovery, null, 2));

    let quarantinedPath: string | undefined;
    const suffix = recovery.updatedAt.replace(/[^0-9]/g, '').slice(0, 14);
    if (fs.existsSync(activeFile)) {
      quarantinedPath = `${activeFile}.quarantine-${suffix}-attempt-${recovery.attempts}`;
      fs.renameSync(activeFile, quarantinedPath);
    }

    let quarantinedLastGoodPath: string | undefined;
    const restoredLastKnownGood = recoveryMode === 'last-good' && fs.existsSync(lastGoodFile);
    if (restoredLastKnownGood) fs.copyFileSync(lastGoodFile, activeFile);
    if (recoveryMode === 'cold' && fs.existsSync(lastGoodFile)) {
      quarantinedLastGoodPath = `${lastGoodFile}.quarantine-${suffix}-attempt-${recovery.attempts}`;
      fs.renameSync(lastGoodFile, quarantinedLastGoodPath);
    }
    if (recoveryMode === 'cold') {
      fs.writeFileSync(walletCanaryPath(network), JSON.stringify({
        reason: 'wallet-sync-cold-recovery',
        dustAppliedIndex: error.dustAppliedIndex,
        checkpointHash: activeHash,
        createdAt: recovery.updatedAt,
      }, null, 2));
    }

    const maxAttempts = Math.max(
      1,
      Math.floor(Number(process.env.MIDNIGHT_WALLET_SYNC_RECOVERY_ATTEMPTS ?? 2)) || 2,
    );
    return {
      attempt: recovery.attempts,
      exhausted: recovery.attempts >= maxAttempts,
      quarantinedPath,
      quarantinedLastGoodPath,
      restoredLastKnownGood,
      recoveryMode,
    };
  };

  // Observe progress in every process, including replay children. Serialization
  // stays separate and is only requested by callers after wallet.stop(), because
  // wallet-sdk 4.x can produce an incoherent tree/cursor snapshot while live.
  cacheProgressSubscription = wallet.state().subscribe((state) => {
    const applied = dustAppliedIndex(state);
    observedApplied = applied;
    observedProgress = walletAppliedProgress(state);
    observedHighest = walletHighestProgress(state);
    if (lastSavedProgress === undefined) lastSavedProgress = { ...observedProgress };
  });

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

export async function walletHealthSnapshot(wallet: WalletFacade, network: SupportedNetwork) {
  const state = await currentWalletState(wallet);
  const applied = walletAppliedProgress(state);
  const highest = walletHighestProgress(state);
  const connected = {
    shielded: Boolean(state.shielded.state.progress.isConnected),
    dust: Boolean(state.dust.state.progress.isConnected),
    unshielded: Boolean(state.unshielded.progress.isConnected),
  };
  return {
    event: 'wallet_health',
    timestamp: new Date().toISOString(),
    network,
    role: storageNamespace('MIDNIGHT_WALLET_CACHE_NAMESPACE') ?? 'deployer',
    connected,
    applied: Object.fromEntries(Object.entries(applied).map(([key, value]) => [key, value.toString()])),
    highest: Object.fromEntries(Object.entries(highest).map(([key, value]) => [key, value.toString()])),
    pendingTransactions: state.pending.all.length,
    dustPendingCoins: state.dust.pendingCoins.length,
    dustAvailableCoins: state.dust.availableCoins.length,
    checkpointHash: fileSha256(walletCachePath(network)) ?? null,
    healthy: Object.values(connected).every(Boolean) && state.pending.all.length === 0,
  };
}

export function startWalletHealthMetrics(wallet: WalletFacade, network: SupportedNetwork): () => void {
  const intervalMs = timeoutMs('KEEPER_WALLET_HEALTH_INTERVAL_MS', 60_000);
  const emit = async () => {
    try {
      const snapshot = await walletHealthSnapshot(wallet, network);
      const line = JSON.stringify(snapshot);
      if (snapshot.healthy) console.log(line);
      else {
        console.error(line);
        const webhook = process.env.KEEPER_WALLET_ALERT_WEBHOOK_URL?.trim();
        if (webhook) {
          void fetch(webhook, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: line,
          }).catch((error) => console.error(`[wallet-alert] delivery failed: ${errorMessage(error)}`));
        }
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: 'wallet_health_error',
        timestamp: new Date().toISOString(),
        network,
        error: errorMessage(error),
      }));
    }
  };
  void emit();
  const timer = setInterval(() => void emit(), intervalMs);
  return () => clearInterval(timer);
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
  const disconnectedSince: Partial<Record<'shielded' | 'dust' | 'unshielded', number>> = {};
  let rejectStall: ((error: WalletSyncStalledError) => void) | undefined;
  const stallPromise = new Promise<never>((_resolve, reject) => {
    rejectStall = reject;
  });
  const replayHeapLimitMb = Number(process.env.MIDNIGHT_WALLET_REPLAY_MAX_HEAP_MB ?? '0');
  const segmentedReplay = process.env.DAREU_WALLET_SEGMENTED_REPLAY === '1';
  const replayCursorSegment = Number(process.env.MIDNIGHT_WALLET_CHECKPOINT_EVERY ?? '0');
  const replaySegmentMs = Number(process.env.MIDNIGHT_WALLET_REPLAY_SEGMENT_MS ?? 30 * 60 * 1000);
  let segmentBaseline: WalletAppliedProgress | undefined;
  let rejectMemoryLimit: ((error: WalletReplayMemoryLimitError | WalletReplaySegmentBoundaryError) => void) | undefined;
  let memoryLimitTriggered = false;
  const memoryLimitPromise = new Promise<never>((_resolve, reject) => {
    rejectMemoryLimit = reject;
  });
  const appliedProgressSubscription = wallet.state().subscribe({
    next: (state) => {
      const next = walletAppliedProgress(state);
      const nextHighest = walletHighestProgress(state);
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
      segmentBaseline ??= next;
      const connectivity = {
        shielded: Boolean(state.shielded.state.progress.isConnected),
        dust: Boolean(state.dust.state.progress.isConnected),
        unshielded: Boolean(state.unshielded.progress.isConnected),
      };
      for (const stream of ['shielded', 'dust', 'unshielded'] as const) {
        if (connectivity[stream]) delete disconnectedSince[stream];
        else disconnectedSince[stream] ??= now;
      }
      if (!memoryLimitTriggered && Number.isFinite(replayHeapLimitMb) && replayHeapLimitMb > 0) {
        const heapUsedMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        if (!isWalletStateSyncedWithin(state, allowedGap) && heapUsedMb >= replayHeapLimitMb) {
          memoryLimitTriggered = true;
          rejectMemoryLimit?.(new WalletReplayMemoryLimitError(heapUsedMb, replayHeapLimitMb));
        }
      }
      if (
        !memoryLimitTriggered && segmentedReplay && segmentBaseline &&
        Number.isFinite(replayCursorSegment) && replayCursorSegment > 0
      ) {
        const threshold = BigInt(Math.floor(replayCursorSegment));
        const advanced = walletReplaySegmentStream(segmentBaseline, next, threshold);
        if (advanced && !isWalletStateSyncedWithin(state, allowedGap)) {
          memoryLimitTriggered = true;
          rejectMemoryLimit?.(new WalletReplaySegmentBoundaryError(
            'cursor',
            Number(next.dust),
            `${advanced} advanced by at least ${threshold.toString()}`,
          ));
        }
      }
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
      // Wallet streams commonly emit a disconnected bootstrap state while their
      // websocket subscription is being established. Give transport recovery the
      // same grace as an applied-index stall; never treat a 15-second startup
      // transition as evidence that a checkpoint tree is corrupt.
      const disconnectGraceMs = timeoutMs('MIDNIGHT_WALLET_DISCONNECT_GRACE_MS', stallTimeoutMs);
      for (const stream of ['shielded', 'dust', 'unshielded'] as const) {
        const since = disconnectedSince[stream];
        if (since !== undefined && now - since >= disconnectGraceMs) {
          stalledStreams.push(stream);
        }
      }
      if (
        !latestWalletState.shielded.state.progress.isCompleteWithin(allowedGap) &&
        now - lastAppliedProgressAt.shielded >= stallTimeoutMs
      && !stalledStreams.includes('shielded')) stalledStreams.push('shielded');
      if (
        !latestWalletState.dust.state.progress.isCompleteWithin(allowedGap) &&
        now - lastAppliedProgressAt.dust >= stallTimeoutMs
      && !stalledStreams.includes('dust')) stalledStreams.push('dust');
      if (
        !latestWalletState.unshielded.progress.isCompleteWithin(allowedGap) &&
        now - lastAppliedProgressAt.unshielded >= stallTimeoutMs
      && !stalledStreams.includes('unshielded')) stalledStreams.push('unshielded');
    }
    if (stalledStreams.length === 0) return;
    rejectStall?.(
      new WalletSyncStalledError(
        stallTimeoutMs,
        Number(latestProgress?.dust ?? 0n),
        stalledStreams,
        `Stalled stream(s): ${stalledStreams.join(', ')}. ${latestStateText}`,
        stalledStreams.filter((stream) => disconnectedSince[stream as 'shielded' | 'dust' | 'unshielded'] !== undefined),
      ),
    );
  }, stallCheckEveryMs);
  const segmentTimer = segmentedReplay && Number.isFinite(replaySegmentMs) && replaySegmentMs > 0
    ? setTimeout(() => {
        if (
          !memoryLimitTriggered && latestProgress && segmentBaseline &&
          hasWalletAppliedProgress(segmentBaseline, latestProgress)
        ) {
          memoryLimitTriggered = true;
          rejectMemoryLimit?.(new WalletReplaySegmentBoundaryError(
            'elapsed',
            Number(latestProgress.dust),
            `${Math.floor(replaySegmentMs)}ms elapsed with forward progress`,
          ));
        }
      }, replaySegmentMs)
    : undefined;

  try {
    const [shielded, unshielded, dust, pending] = await Promise.race([
        Promise.all([
          wallet.shielded.waitForSyncedState(allowedGap),
          wallet.unshielded.waitForSyncedState(allowedGap),
          wallet.dust.waitForSyncedState(allowedGap),
          Rx.firstValueFrom(wallet.pendingTransactionsService.state()),
        ]),
        stallPromise,
        memoryLimitPromise,
      ]);

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
    if (segmentTimer) clearTimeout(segmentTimer);
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
