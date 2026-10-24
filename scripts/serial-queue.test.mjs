/**
 * SerialQueue behavioural test.
 *
 * The queue is what keeps two tabs off one Firebird attachment at the same
 * time, so these checks exercise the real class: ordering, the busy/pending
 * counters, and rejection isolation (one failed statement must not stop the
 * statements queued behind it).
 *
 * No database and no driver are involved. Run with
 * `npm run test:serial-queue`.
 */
import assert from 'node:assert/strict'
import { SerialQueue } from '../src/main/db/serialQueue.ts'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const checks = []
const check = (name, run) => checks.push({ name, run })

check('a fresh queue is idle', () => {
  const queue = new SerialQueue()
  assert.equal(queue.busy, false)
  assert.equal(queue.pending, 0)
})

check('tasks run in the order they were enqueued, even when the first is slow', async () => {
  const queue = new SerialQueue()
  const finished = []
  const first = queue.run(async () => {
    await delay(15)
    finished.push('a')
  })
  await delay(1)
  const second = queue.run(async () => {
    await delay(1)
    finished.push('b')
  })
  const third = queue.run(async () => {
    await delay(5)
    finished.push('c')
  })
  assert.equal(queue.pending, 2, 'two tasks wait while the first runs')
  await Promise.all([first, second, third])
  assert.deepEqual(finished, ['a', 'b', 'c'])
})

check('two tasks never execute at the same time', async () => {
  const queue = new SerialQueue()
  let inside = 0
  let maxInside = 0
  const tasks = []
  for (let i = 0; i < 20; i += 1) {
    tasks.push(
      queue.run(async () => {
        inside += 1
        maxInside = Math.max(maxInside, inside)
        await delay(i % 3)
        inside -= 1
        return i
      })
    )
  }
  assert.deepEqual(await Promise.all(tasks), [...Array(20).keys()])
  assert.equal(maxInside, 1, 'only one task body ever ran at a time')
})

check('busy and pending describe the running and waiting tasks', async () => {
  const queue = new SerialQueue()
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const running = queue.run(async () => {
    await gate
    return 'first'
  })
  // The task body starts on a microtask, so let the queue settle first.
  await Promise.resolve()
  assert.equal(queue.busy, true)
  assert.equal(queue.pending, 0)

  const waiting = queue.run(async () => 'second')
  const alsoWaiting = queue.run(async () => 'third')
  assert.equal(queue.pending, 2, 'both queued tasks are pending')
  assert.equal(queue.busy, true)

  release()
  assert.equal(await running, 'first')
  await Promise.all([waiting, alsoWaiting])
  await queue.drain()
  assert.equal(queue.busy, false)
  assert.equal(queue.pending, 0)
})

check('a rejected task rejects only itself and the queue keeps running', async () => {
  const queue = new SerialQueue()
  const ran = []
  const first = queue.run(async () => {
    ran.push('a')
    return 'a'
  })
  const second = queue.run(async () => {
    ran.push('b')
    throw new Error('statement failed')
  })
  const third = queue.run(async () => {
    ran.push('c')
    return 'c'
  })

  assert.equal(await first, 'a')
  await assert.rejects(second, /statement failed/)
  assert.equal(await third, 'c')
  assert.deepEqual(ran, ['a', 'b', 'c'], 'the failed task did not block the rest')
  assert.equal(queue.busy, false)
  assert.equal(queue.pending, 0)

  // A task enqueued after the rejection still runs.
  assert.equal(await queue.run(async () => 'after'), 'after')
})

check('a task that throws synchronously fails like any other', async () => {
  const queue = new SerialQueue()
  const failed = queue.run(() => {
    throw new Error('sync boom')
  })
  await assert.rejects(failed, /sync boom/)
  assert.equal(await queue.run(() => 'ok'), 'ok', 'the chain survived the sync throw')
})

check('consecutive failures do not disturb later results', async () => {
  const queue = new SerialQueue()
  const outcomes = Promise.allSettled([
    queue.run(async () => {
      throw new Error('one')
    }),
    queue.run(async () => {
      throw new Error('two')
    }),
    queue.run(async () => 'three')
  ])
  const settled = await outcomes
  assert.deepEqual(
    settled.map((entry) => entry.status),
    ['rejected', 'rejected', 'fulfilled']
  )
  assert.equal(settled[2].value, 'three')
})

check('drain waits for everything already enqueued, including rejections', async () => {
  const queue = new SerialQueue()
  const order = []
  queue.run(async () => {
    await delay(10)
    order.push('first')
    throw new Error('ignored by its own caller')
  })
  queue.run(async () => {
    order.push('second')
  })
  await queue.drain()
  assert.deepEqual(order, ['first', 'second'])
})

check('results pass through unchanged and work starts only when a slot is free', async () => {
  const queue = new SerialQueue()
  let startedEarly = false
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const holder = queue.run(async () => {
    await gate
  })
  const queued = queue.run(() => {
    startedEarly = true
    return { rows: 2 }
  })
  await delay(5)
  assert.equal(startedEarly, false, 'a queued task does not start while the queue is busy')
  release()
  await holder
  assert.deepEqual(await queued, { rows: 2 })
})

let failed = 0
for (const { name, run } of checks) {
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}

console.log(`\n${checks.length - failed}/${checks.length} serial queue checks passed`)
if (failed > 0) process.exitCode = 1
