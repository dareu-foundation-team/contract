import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PRIORITY_MARKET_EXISTS_SQL } from '../scripts/keeper/publish-v2.js'
import {
  EMPTY_CANCEL_PREDICATE,
  FUNDED_CANCEL_PREDICATE,
} from '../scripts/keeper/resolve-v2.js'
import {
  type KeeperWorkResult,
  runKeeperPriorityCycle,
} from '../scripts/keeper/scheduling-v2.js'

const none = (): KeeperWorkResult => ({ selected: 0, succeeded: 0 })

test('keeper settles before publishing and checks settlement again afterwards', async () => {
  const calls: string[] = []
  let resolveCalls = 0
  let cancelCalls = 0

  const cycle = await runKeeperPriorityCycle({
    resolve: async () => {
      calls.push(`resolve-${++resolveCalls}`)
      return resolveCalls === 1 ? { selected: 1, succeeded: 1 } : none()
    },
    cancelFunded: async () => {
      calls.push(`funded-cancel-${++cancelCalls}`)
      return none()
    },
    cancelEmpty: async () => {
      calls.push('empty-cancel')
      return { selected: 2, succeeded: 2 }
    },
    publish: async () => {
      calls.push('publish')
      return { selected: 10, succeeded: 10 }
    },
  })

  assert.deepEqual(calls, [
    'resolve-1',
    'funded-cancel-1',
    'publish',
    'resolve-2',
    'funded-cancel-2',
    'empty-cancel',
  ])
  assert.equal(cycle.emptyCancelAfterPublish.succeeded, 2)
  assert.equal(cycle.madeProgress, true)
})

test('a preempted publish turn still reaches the post-publish settlement check', async () => {
  const calls: string[] = []
  let resolveCalls = 0

  const cycle = await runKeeperPriorityCycle({
    resolve: async () => {
      calls.push('resolve')
      resolveCalls++
      return resolveCalls === 2 ? { selected: 1, succeeded: 1 } : none()
    },
    cancelFunded: async () => {
      calls.push('funded-cancel')
      return none()
    },
    cancelEmpty: async () => {
      calls.push('empty-cancel')
      return none()
    },
    publish: async () => {
      calls.push('publish')
      return { selected: 10, succeeded: 2, preempted: true }
    },
  })

  assert.deepEqual(calls, ['resolve', 'funded-cancel', 'publish', 'resolve', 'funded-cancel'])
  assert.equal(cycle.publish.preempted, true)
  assert.equal(cycle.resolveAfterPublish.succeeded, 1)
  assert.equal(cycle.emptyCancelAfterPublish.succeeded, 0)
})

test('publish preemption covers resolutions and funded refunds, but not empty cleanup', () => {
  assert.match(PRIORITY_MARKET_EXISTS_SQL, /ready_to_resolve/)
  assert.match(PRIORITY_MARKET_EXISTS_SQL, /cancel_requested/)
  assert.match(PRIORITY_MARKET_EXISTS_SQL, /onchain_yes_pool/)
  assert.match(PRIORITY_MARKET_EXISTS_SQL, /onchain_no_pool/)
  assert.match(PRIORITY_MARKET_EXISTS_SQL, /> 0/)
  assert.match(PRIORITY_MARKET_EXISTS_SQL, /onchain_contract_address = \$1/)
  assert.match(PRIORITY_MARKET_EXISTS_SQL, /category = \$2/)
})

test('cancel queue predicates separate funded refunds from empty market cleanup', () => {
  assert.match(FUNDED_CANCEL_PREDICATE, /> 0/)
  assert.match(EMPTY_CANCEL_PREDICATE, /= 0/)
})
