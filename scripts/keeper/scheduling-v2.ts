export type KeeperWorkResult = {
  selected: number
  succeeded: number
  preempted?: boolean
}

export type KeeperPriorityCycle = {
  resolveBeforePublish: KeeperWorkResult
  fundedCancelBeforePublish: KeeperWorkResult
  publish: KeeperWorkResult
  resolveAfterPublish: KeeperWorkResult
  fundedCancelAfterPublish: KeeperWorkResult
  emptyCancelAfterPublish: KeeperWorkResult
  madeProgress: boolean
}

type KeeperPriorityTasks = {
  resolve: () => Promise<KeeperWorkResult>
  cancelFunded: () => Promise<KeeperWorkResult>
  cancelEmpty: () => Promise<KeeperWorkResult>
  publish: () => Promise<KeeperWorkResult>
}

const progressed = (result: KeeperWorkResult) => result.succeeded > 0
const noWork = (): KeeperWorkResult => ({ selected: 0, succeeded: 0 })

/**
 * Funded lifecycle work gets two opportunities around a bounded publish quantum.
 * Empty 0/0 markets receive one small cleanup turn after publishing, unless funded
 * work preempted that publish. Tasks remain serial so one operator wallet context
 * is never shared by concurrent proof/transaction calls.
 */
export async function runKeeperPriorityCycle(tasks: KeeperPriorityTasks): Promise<KeeperPriorityCycle> {
  const resolveBeforePublish = await tasks.resolve()
  const fundedCancelBeforePublish = await tasks.cancelFunded()
  const publish = await tasks.publish()
  const resolveAfterPublish = await tasks.resolve()
  const fundedCancelAfterPublish = await tasks.cancelFunded()
  // A preempted publish means funded lifecycle work is still waiting. Do not spend
  // wallet/prover capacity on empty 0/0 cleanup until the funded queue is clear.
  const emptyCancelAfterPublish = publish.preempted
    ? noWork()
    : await tasks.cancelEmpty()

  return {
    resolveBeforePublish,
    fundedCancelBeforePublish,
    publish,
    resolveAfterPublish,
    fundedCancelAfterPublish,
    emptyCancelAfterPublish,
    madeProgress: [
      resolveBeforePublish,
      fundedCancelBeforePublish,
      publish,
      resolveAfterPublish,
      fundedCancelAfterPublish,
      emptyCancelAfterPublish,
    ].some(progressed),
  }
}
