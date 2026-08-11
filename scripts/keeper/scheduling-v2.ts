export type KeeperWorkResult = {
  selected: number
  succeeded: number
  preempted?: boolean
}

export type KeeperPriorityCycle = {
  resolveBeforePublish: KeeperWorkResult
  cancelBeforePublish: KeeperWorkResult
  publish: KeeperWorkResult
  resolveAfterPublish: KeeperWorkResult
  cancelAfterPublish: KeeperWorkResult
  madeProgress: boolean
}

type KeeperPriorityTasks = {
  resolve: () => Promise<KeeperWorkResult>
  cancel: () => Promise<KeeperWorkResult>
  publish: () => Promise<KeeperWorkResult>
}

const progressed = (result: KeeperWorkResult) => result.succeeded > 0

/**
 * Lifecycle work always gets two opportunities around a bounded publish quantum.
 * The same task functions are awaited serially so one operator wallet context is
 * never shared by concurrent proof/transaction calls.
 */
export async function runKeeperPriorityCycle(tasks: KeeperPriorityTasks): Promise<KeeperPriorityCycle> {
  const resolveBeforePublish = await tasks.resolve()
  const cancelBeforePublish = await tasks.cancel()
  const publish = await tasks.publish()
  const resolveAfterPublish = await tasks.resolve()
  const cancelAfterPublish = await tasks.cancel()

  return {
    resolveBeforePublish,
    cancelBeforePublish,
    publish,
    resolveAfterPublish,
    cancelAfterPublish,
    madeProgress: [
      resolveBeforePublish,
      cancelBeforePublish,
      publish,
      resolveAfterPublish,
      cancelAfterPublish,
    ].some(progressed),
  }
}
