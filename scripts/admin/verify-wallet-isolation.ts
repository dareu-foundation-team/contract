import * as fs from 'node:fs'
import * as path from 'node:path'
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd'
import { mnemonicToSeedSync } from '@scure/bip39'
import { createKeystore } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet'

const contractRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')

function envFile(file: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 1) continue
    values.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, ''))
  }
  return values
}

function secret(values: Map<string, string>, prefix: string, file: string): string {
  const direct = values.get(`${prefix}_MNEMONIC`) || values.get(`${prefix}_SEED`)
  if (direct) return direct
  const secretFile = values.get(`${prefix}_MNEMONIC_FILE`) || values.get(`${prefix}_SEED_FILE`)
  if (secretFile) return fs.readFileSync(path.resolve(path.dirname(file), secretFile), 'utf8').trim()
  throw new Error(`${file} does not configure ${prefix}_MNEMONIC/SEED or its _FILE variant.`)
}

function address(value: string, network: string): string {
  const seed = /\s/.test(value)
    ? Buffer.from(mnemonicToSeedSync(value.replace(/\s+/g, ' ').toLowerCase()))
    : Buffer.from(value.replace(/^0x/i, ''), 'hex')
  const wallet = HDWallet.fromSeed(seed)
  if (wallet.type !== 'seedOk') throw new Error('Invalid wallet seed')
  const result = wallet.hdWallet.selectAccount(0).selectRoles([Roles.NightExternal]).deriveKeysAt(0)
  wallet.hdWallet.clear()
  if (result.type !== 'keysDerived') throw new Error('Could not derive wallet address')
  return String(createKeystore(result.keys[Roles.NightExternal], network).getBech32Address())
}

const network = process.argv[2] || 'preprod'
const definitions = [
  { role: 'deployer', file: path.join(contractRoot, '.env.local'), prefix: 'MIDNIGHT_DEPLOYER_WALLET' },
  ...(['crypto', 'stocks', 'sports'] as const).map((role) => ({
    role,
    file: path.join(contractRoot, `.env.keeper.${role}.local`),
    prefix: 'MIDNIGHT_WALLET',
  })),
]
const seen = new Map<string, string>()
for (const definition of definitions) {
  const derived = address(secret(envFile(definition.file), definition.prefix, definition.file), network)
  const duplicate = seen.get(derived)
  if (duplicate) throw new Error(`Wallet isolation violation: ${definition.role} and ${duplicate} derive the same address.`)
  seen.set(derived, definition.role)
  console.log(`[wallet-isolation] ${definition.role}: ${derived}`)
}
console.log('[wallet-isolation] deployer, crypto, stocks and sports are distinct.')
