/**
 * A promise chain that runs work one item at a time.
 *
 * It exists for connections that cannot carry two statements at once. A
 * Firebird attachment is the case here: node-firebird matches every response
 * against a single FIFO queue per socket, and `op_cancel` cancels whatever the
 * attachment is running without saying which statement it meant. Work that
 * shares one attachment therefore has to take turns.
 *
 * Rejections are isolated: a failing task rejects its own promise and leaves
 * the chain able to run the next one.
 */
export type QueueTask<T> = () => T | PromiseLike<T>

export class SerialQueue {
  /** Settles when the last enqueued task settles. Never rejects. */
  private tail: Promise<void> = Promise.resolve()
  private running = 0
  private waiting = 0

  /** True while a task body is executing. */
  get busy(): boolean {
    return this.running > 0
  }

  /** Tasks enqueued that have not started. The running one is not counted. */
  get pending(): number {
    return this.waiting
  }

  run<T>(task: QueueTask<T>): Promise<T> {
    this.waiting += 1
    const result = this.tail.then(() => {
      this.waiting -= 1
      this.running += 1
      return Promise.resolve()
        .then(task)
        .then(
          (value) => {
            this.running -= 1
            return value
          },
          (error: unknown) => {
            this.running -= 1
            throw error
          }
        )
    })
    // The chain tracks completion only, so one rejection cannot stall it.
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /** Resolves once every task enqueued so far has settled. */
  drain(): Promise<void> {
    return this.tail
  }
}
