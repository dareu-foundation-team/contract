// Network registry — the SINGLE SOURCE OF TRUTH for which Midnight networks the
// scripts support. Lightweight on purpose (no wallet/provider deps) so even the
// standalone balance script can import it.
//
// TO ADD A NETWORK (e.g. mainnet when Midnight launches it): add ONE entry to
// `defaultConfigs` below. `SupportedNetwork`, `SUPPORTED_NETWORKS`, and every
// validator (`resolveNetwork`) are DERIVED from these keys — no other file changes.

export type NetworkConfig = {
  indexer: string
  indexerWS: string
  node: string
  nodeWS: string
  proofServer: string
  faucet: string
}

const defaultConfigs = {
  preprod: {
    indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preprod.midnight.network',
    nodeWS: 'wss://rpc.preprod.midnight.network',
    proofServer: 'http://127.0.0.1:6300',
    faucet: 'https://midnight-tmnight-preprod.nethermind.dev/',
  },
  preview: {
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preview.midnight.network',
    nodeWS: 'wss://rpc.preview.midnight.network',
    proofServer: 'http://127.0.0.1:6300',
    faucet: 'https://midnight-tmnight-preview.nethermind.dev/',
  },
  // mainnet: {   // ← uncomment + fill when Midnight mainnet endpoints are published.
  //   indexer: 'https://indexer.mainnet.midnight.network/api/v4/graphql',
  //   indexerWS: 'wss://indexer.mainnet.midnight.network/api/v4/graphql/ws',
  //   node: 'https://rpc.mainnet.midnight.network',
  //   nodeWS: 'wss://rpc.mainnet.midnight.network',
  //   proofServer: 'http://127.0.0.1:6300',
  //   faucet: '',
  // },
} satisfies Record<string, NetworkConfig>

// Derived from the config keys — import these instead of hardcoding network names.
export type SupportedNetwork = keyof typeof defaultConfigs
export const SUPPORTED_NETWORKS = Object.keys(defaultConfigs) as SupportedNetwork[]

/** Validate a CLI/env network argument against the supported set. */
export function resolveNetwork(arg?: string): SupportedNetwork {
  const network = arg || process.env.MIDNIGHT_NETWORK || 'preprod'
  if (!(SUPPORTED_NETWORKS as string[]).includes(network)) {
    throw new Error(`Unsupported network "${network}". Use one of: ${SUPPORTED_NETWORKS.join(', ')}.`)
  }
  return network as SupportedNetwork
}

/** Per-network endpoints, with per-field env overrides (MIDNIGHT_INDEXER_URL, …). */
export function resolveNetworkConfig(network: SupportedNetwork, env = process.env): NetworkConfig {
  const defaults = defaultConfigs[network]
  return {
    indexer: env.MIDNIGHT_INDEXER_URL || defaults.indexer,
    indexerWS: env.MIDNIGHT_INDEXER_WS_URL || defaults.indexerWS,
    node: env.MIDNIGHT_NODE_URL || defaults.node,
    nodeWS: env.MIDNIGHT_NODE_WS_URL || defaults.nodeWS,
    proofServer: env.MIDNIGHT_PROOF_SERVER || defaults.proofServer,
    faucet: env.MIDNIGHT_FAUCET_URL || defaults.faucet,
  }
}
