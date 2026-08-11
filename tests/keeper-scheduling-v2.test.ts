import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PRIORITY_MARKET_EXISTS_SQL } from '../scripts/keeper/publish-v2.js'
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
    cancel: async () => {
      calls.push(`cancel-${++cancelCalls}`)
      return none()
    },
    publish: async () => {
      calls.push('publish')
      return { selected: 10, succeeded: 10 }
    },
  })

  assert.deepEqual(calls, [
    'resolve-1',
    'cancel-1',
    'publish',
    'resolve-2',
    'cancel-2',
  ])
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
    cancel: async () => {
      calls.push('cancel')
      return none()
    },
    publish: async () => {
      calls.push('publish')
      return { selected: 10, succeeded: 2, preempted: true }
    },
  })

  assert.deepEqual(calls, ['resolve', 'cancel', 'publish', 'resolve', 'cancel'])
  assert.equal(cycle.publish.preempted, true)
  assert.equal(cycle.resolveAfterPublish.succeeded, 1)
})

test('publish preemption query covers both resolution and refund work in the same scope', () => {
  assert.match(PRIORITY_MARKET_EXISTS_SQL, /ready_to_resolve/)
  assert.match(PRIORITY_MARKET_EXISTS_SQL, /cancel_requested/)
  assert.match(PRIORITY_MARKET_EXISTS_SQL, /onchain_contract_address = \$1/)
  assert.match(PRIORITY_MARKET_EXISTS_SQL, /category = \$2/)
})
