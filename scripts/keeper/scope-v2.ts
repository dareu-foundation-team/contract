// Runtime scope for the three dedicated V2 Keeper instances.
//
// Category is an off-chain Postgres partition (the Compact ledger commits only the
// metadata hash).  Requiring it here prevents an accidentally unscoped Keeper from
// competing with all three production instances.

export const KEEPER_CATEGORIES = ['crypto', 'stocks', 'sports'] as const

export type KeeperCategory = (typeof KEEPER_CATEGORIES)[number]

function parseCategory(value: string | undefined): KeeperCategory | undefined {
  const normalized = value?.trim().toLowerCase()
  return KEEPER_CATEGORIES.includes(normalized as KeeperCategory)
    ? normalized as KeeperCategory
    : undefined
}

/**
 * Configure a process before loadEnvFiles().  The category-specific env file is
 * loaded first, so its Midnight wallet credentials override the old shared wallet
 * in .env.local without duplicating common DB/network/operator configuration.
 */
export function configureKeeperCategory(cliValue?: string): KeeperCategory {
  const raw = cliValue?.trim() || process.env.DAREU_KEEPER_CATEGORY?.trim()
  const category = parseCategory(raw)
  if (!category) {
    throw new Error(
      `A Keeper category is required (${KEEPER_CATEGORIES.join('|')}). ` +
        'Use: <command> -- preprod <category>, or set DAREU_KEEPER_CATEGORY.',
    )
  }

  process.env.DAREU_KEEPER_CATEGORY = category
  process.env.DAREU_ENV_FILE ??= `.env.keeper.${category}.local`
  process.env.MIDNIGHT_WALLET_CACHE_NAMESPACE ??= category
  process.env.MIDNIGHT_PRIVATE_STATE_NAMESPACE ??= category
  return category
}

/** Read the category after configureKeeperCategory() has run. */
export function requiredKeeperCategory(): KeeperCategory {
  const category = parseCategory(process.env.DAREU_KEEPER_CATEGORY)
  if (!category) {
    throw new Error('DAREU_KEEPER_CATEGORY is missing or invalid; configure the Keeper category before running a loop.')
  }
  return category
}
