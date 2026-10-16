// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import {
  createModelLifetimeFixture,
  modelLifetimeFile,
  resetModelLifetimeFixtures
} from './editor-model-lifetime-fixture'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import {
  checkDetailsReadingKey,
  checkReadingIntentKey,
  checkReadingLogKey,
  checkReadingOuterKey,
  checkReadingStepsKey
} from './check-details-reading-cache'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))
afterEach(resetModelLifetimeFixtures)

function seed(id: string): void {
  const owner = checkDetailsReadingKey(id, 'pane', 'context')
  for (const key of [
    checkReadingOuterKey(owner),
    checkReadingLogKey(owner, 'job', 'digest'),
    checkReadingStepsKey(owner, 'job', true),
    checkReadingIntentKey(owner, 'job'),
    `${checkDetailsReadingKey(id, null, 'context')}::first-payload`
  ]) {
    setWithLRU(scrollTopCache, key, 10)
  }
}

it.each([false, true])(
  'sweeps closed check details through the live attach controller, Monaco=%s',
  async (registered) => {
    const { store, attach } = createModelLifetimeFixture(registered)
    const closed = modelLifetimeFile('closed-check', 'check-details')
    const live = modelLifetimeFile('live-check', 'check-details')
    const ordinary = modelLifetimeFile('ordinary')
    store.setState({ openFiles: [closed, live, ordinary] })
    attach()
    seed(closed.id)
    seed(live.id)
    setWithLRU(scrollTopCache, ordinary.filePath, 320)
    store.getState().closeFile(closed.id)
    await Promise.resolve()
    expect([...scrollTopCache.keys()].some((key) => key.startsWith(`${closed.id}::`))).toBe(false)
    expect([...scrollTopCache.keys()].some((key) => key.startsWith(`${live.id}::`))).toBe(true)
    store.getState().closeFile(ordinary.id)
    await Promise.resolve()
    expect(scrollTopCache.get(ordinary.filePath)).toBe(320)
  }
)

it('sweeps never-mounted close-all and same-ID mode replacements without Monaco', async () => {
  const { store, attach } = createModelLifetimeFixture(false)
  const a = modelLifetimeFile('never-a', 'check-details')
  const b = modelLifetimeFile('never-b', 'check-details')
  store.setState({ openFiles: [a, b] })
  attach()
  seed(a.id)
  seed(b.id)
  store.setState({ openFiles: [{ ...a, mode: 'edit' }, b] })
  await Promise.resolve()
  expect([...scrollTopCache.keys()].some((key) => key.startsWith(`${a.id}::`))).toBe(false)
  store.setState({ openFiles: [] })
  await Promise.resolve()
  expect(scrollTopCache.size).toBe(0)
})

it('spares a check ID reopened before the pending flush', async () => {
  const { store, attach } = createModelLifetimeFixture(false)
  const file = modelLifetimeFile('reopened', 'check-details')
  store.setState({ openFiles: [file] })
  attach()
  seed(file.id)
  store.setState({ openFiles: [] })
  store.setState({ openFiles: [file] })
  await Promise.resolve()
  expect(scrollTopCache.size).toBe(5)
})
