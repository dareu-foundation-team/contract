/**
 * Persist a V2 ledger snapshot without rewriting every market on every sync.
 *
 * `synced_at` historically only moved when mirrored values changed. That made it
 * unsuitable as proof that an unchanged pool had been observed after market close.
 * `onchain_observed_at` records that observation explicitly. A row is refreshed:
 *
 * - whenever a mirrored value changes;
 * - once when the observation column is introduced/new; and
 * - once after close, if its latest observation was still pre-close.
 *
 * The final rule gives the resolver a post-close pool snapshot while avoiding a
 * write (and WAL/autovacuum work) every 30 seconds for already-fresh markets.
 */
export const V2_MARKET_MIRROR_UPDATE_SQL = `WITH incoming AS (
   SELECT *
     FROM unnest(
       $1::text[], $2::text[], $3::numeric[], $4::numeric[], $5::text[]
     ) AS state(id, status, yes_pool, no_pool, outcome)
 )
 UPDATE markets AS market
    SET onchain_status = state.status,
        onchain_yes_pool = state.yes_pool,
        onchain_no_pool = state.no_pool,
        onchain_outcome = state.outcome,
        onchain_contract_version = 'v2',
        onchain_contract_address = $6,
        synced_at = now(),
        onchain_observed_at = now()
   FROM incoming AS state
  WHERE market.id = state.id
    AND (
      market.onchain_status IS DISTINCT FROM state.status OR
      market.onchain_yes_pool IS DISTINCT FROM state.yes_pool OR
      market.onchain_no_pool IS DISTINCT FROM state.no_pool OR
      market.onchain_outcome IS DISTINCT FROM state.outcome OR
      market.onchain_contract_version IS DISTINCT FROM 'v2' OR
      market.onchain_contract_address IS DISTINCT FROM $6 OR
      (market.status = 'open' AND market.onchain_observed_at IS NULL) OR
      (
        market.status = 'open' AND
        market.close_time <= now() AND
        market.onchain_observed_at < market.close_time
      )
    )`
