import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The REAL @eneris/push-receiver, not the stand-in from test/setup.ts: the
// bug lives in how the library rejects `whenReady` inside destroy().
vi.unmock('@eneris/push-receiver')

import { PushReceiver } from '@eneris/push-receiver'
import { RingApi } from '../api.ts'
import { createMockRestClient } from './fixtures/mock-websocket.ts'

const nextMacrotask = () => new Promise((resolve) => setImmediate(resolve))

describe('push receiver supervisor', () => {
  let api: RingApi
  const unhandledRejections: unknown[] = [],
    onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason)
    }

  beforeEach(() => {
    unhandledRejections.length = 0
    process.on('unhandledRejection', onUnhandledRejection)

    // The only piece replaced: the FCM registration, which needs the network.
    // It fails the way it does when the connection is down.
    vi.spyOn(PushReceiver.prototype, 'registerIfNeeded').mockRejectedValue(
      new Error('network down'),
    )

    api = new RingApi({ refreshToken: 'test-refresh' })
    ;(api as any).restClient = createMockRestClient(() => Promise.resolve({}))
  })

  afterEach(() => {
    api.disconnect()
    process.off('unhandledRejection', onUnhandledRejection)
    vi.restoreAllMocks()
  })

  it('uses the real library', () => {
    expect(vi.isMockFunction(PushReceiver)).toBe(false)
    expect(typeof new PushReceiver({} as any).destroy).toBe('function')
  })

  it('does not leave an unhandled rejection when it destroys a receiver that never became ready', async () => {
    // connect() fails, so the supervisor takes over: destroy() + connect().
    // destroy() rejects the still-pending whenReady ("Client destroyed").
    await (api as any).registerPushReceiver([], [])
    await nextMacrotask()
    await nextMacrotask()

    expect(PushReceiver.prototype.registerIfNeeded).toHaveBeenCalledTimes(2)
    expect(unhandledRejections).toEqual([])
  })

  it('does not leave an unhandled rejection when the library retries connect() on its own', async () => {
    await (api as any).registerPushReceiver([], [])
    await nextMacrotask()

    // What the library's retry timer does after a socket close: call
    // connect() and drop the promise. The registration is still failing.
    const receiver = vi.mocked(PushReceiver.prototype.registerIfNeeded).mock
      .contexts[0] as PushReceiver
    setTimeout(() => receiver.connect(), 0)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await nextMacrotask()
    await nextMacrotask()

    expect(unhandledRejections).toEqual([])
  })

  it('does not leave an unhandled rejection when disconnect() destroys the receiver', async () => {
    await (api as any).registerPushReceiver([], [])
    await nextMacrotask()

    api.disconnect()
    await nextMacrotask()
    await nextMacrotask()

    expect(unhandledRejections).toEqual([])
  })
})
