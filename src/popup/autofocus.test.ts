import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirectiveBinding } from 'vue'
import { vAutofocus } from './autofocus'

function makeBinding(value?: boolean): DirectiveBinding<boolean | undefined> {
  return {
    value,
    oldValue: undefined,
    arg: undefined,
    modifiers: {},
    instance: null,
    dir: vAutofocus,
  }
}

function mountInput(value?: boolean): HTMLInputElement {
  const input = document.createElement('input')
  document.body.appendChild(input)
  vAutofocus.mounted?.(input, makeBinding(value), null as any, null as any)
  return input
}

async function flushMessageChannel() {
  await new Promise<void>(resolve => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => {
      ch.port1.close()
      ch.port2.close()
      resolve()
    }
    ch.port2.postMessage(null)
  })
}

describe('vAutofocus', () => {
  let hasFocusVal = false
  let readyStateVal: DocumentReadyState = 'complete'
  let visibilityVal: DocumentVisibilityState = 'visible'
  let rafQueue: FrameRequestCallback[] = []
  let nextRafId = 1

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    hasFocusVal = false
    readyStateVal = 'complete'
    visibilityVal = 'visible'
    rafQueue = []
    nextRafId = 1
    document.body.innerHTML = ''

    vi.spyOn(document, 'hasFocus').mockImplementation(() => hasFocusVal)
    Object.defineProperty(document, 'readyState', {
      configurable: true,
      get: () => readyStateVal,
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibilityVal,
    })
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        rafQueue.push(cb)
        return nextRafId++
      })
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn(() => {
        rafQueue = []
      })
    )
  })

  afterEach(() => {
    for (const el of Array.from(document.body.querySelectorAll('input'))) {
      vAutofocus.unmounted?.(el, makeBinding(), null as any, null as any)
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function flushNextRaf() {
    const q = rafQueue
    rafQueue = []
    for (const cb of q) cb(performance.now())
  }

  it('1. skips focusing when binding value is false', () => {
    hasFocusVal = true
    const input = mountInput(false)
    expect(document.activeElement).not.toBe(input)
  })

  it('2. focuses immediately on mount and skips replaceState when document already has focus', async () => {
    hasFocusVal = true
    const replaceSpy = vi.spyOn(history, 'replaceState')
    const input = mountInput()

    expect(document.activeElement).toBe(input)
    await flushMessageChannel()
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('3. focuses input immediately on mount even when document does not have focus yet', () => {
    hasFocusVal = false
    const input = mountInput()
    expect(document.activeElement).toBe(input)
  })

  it('4. waits for window load before running MessageChannel + replaceState handoff', async () => {
    readyStateVal = 'loading'
    const replaceSpy = vi.spyOn(history, 'replaceState')
    mountInput()

    await flushMessageChannel()
    expect(replaceSpy).not.toHaveBeenCalled()

    readyStateVal = 'complete'
    window.dispatchEvent(new Event('load'))
    await flushMessageChannel()
    expect(replaceSpy).toHaveBeenCalledTimes(1)
  })

  it('5. runs MessageChannel + replaceState immediately after mount when already loaded', async () => {
    readyStateVal = 'complete'
    const replaceSpy = vi.spyOn(history, 'replaceState')
    mountInput()

    await flushMessageChannel()
    expect(replaceSpy).toHaveBeenCalledTimes(1)
  })

  it('6. preserves URL, hash, history.state, and history.length during replaceState', async () => {
    history.replaceState({ keep: 123 }, '', `${location.pathname}?q=1#keep`)
    const beforeHref = location.href
    const beforeLen = history.length
    const replaceSpy = vi.spyOn(history, 'replaceState')

    mountInput()
    await flushMessageChannel()

    expect(replaceSpy).toHaveBeenCalledWith({ keep: 123 }, '', beforeHref)
    expect(location.href).toBe(beforeHref)
    expect(history.length).toBe(beforeLen)
  })

  it('7. settles and stops retries when window focus event fires', async () => {
    const input = mountInput()
    await flushMessageChannel()

    input.blur()
    expect(document.activeElement).not.toBe(input)

    hasFocusVal = true
    window.dispatchEvent(new Event('focus'))
    expect(document.activeElement).toBe(input)

    // Subsequent rAF ticks should no longer run
    const focusSpy = vi.spyOn(input, 'focus')
    flushNextRaf()
    expect(focusSpy).not.toHaveBeenCalled()
  })

  it('8. performs one recovery replaceState when visibilityState becomes visible, without repeating', async () => {
    visibilityVal = 'hidden'
    const replaceSpy = vi.spyOn(history, 'replaceState')
    mountInput()
    await flushMessageChannel()
    expect(replaceSpy).toHaveBeenCalledTimes(1)

    // Popup becomes visible -> triggers one recovery attempt
    visibilityVal = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(replaceSpy).toHaveBeenCalledTimes(2)

    // Second visibilitychange should NOT trigger another replaceState
    visibilityVal = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    visibilityVal = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(replaceSpy).toHaveBeenCalledTimes(2)
  })

  it('9. recovers focus via requestAnimationFrame when focus events were missed', async () => {
    const input = mountInput()
    await flushMessageChannel()

    input.blur()
    hasFocusVal = true
    flushNextRaf()

    expect(document.activeElement).toBe(input)
  })

  it('10. cancels all pending work on user keydown', async () => {
    readyStateVal = 'loading'
    const replaceSpy = vi.spyOn(history, 'replaceState')
    mountInput()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    readyStateVal = 'complete'
    window.dispatchEvent(new Event('load'))
    await flushMessageChannel()

    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('11. cancels all pending work on user pointerdown', async () => {
    readyStateVal = 'loading'
    const replaceSpy = vi.spyOn(history, 'replaceState')
    mountInput()

    window.dispatchEvent(new Event('pointerdown'))
    readyStateVal = 'complete'
    window.dispatchEvent(new Event('load'))
    await flushMessageChannel()

    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('12. cancels all pending work on pagehide (popup closure)', async () => {
    readyStateVal = 'loading'
    const replaceSpy = vi.spyOn(history, 'replaceState')
    mountInput()

    window.dispatchEvent(new Event('pagehide'))
    readyStateVal = 'complete'
    window.dispatchEvent(new Event('load'))
    await flushMessageChannel()

    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('13. expires after 1000ms and cleans up on unmount', async () => {
    const input = mountInput()
    await flushMessageChannel()

    // Advance past 1s expiration
    vi.advanceTimersByTime(1000)
    input.blur()
    hasFocusVal = true
    window.dispatchEvent(new Event('focus'))
    expect(document.activeElement).not.toBe(input)

    // Also verify unmount stops before expiration
    hasFocusVal = false
    const input2 = mountInput()
    await flushMessageChannel()
    vAutofocus.unmounted?.(input2, makeBinding(), null as any, null as any)
    input2.blur()
    hasFocusVal = true
    window.dispatchEvent(new Event('focus'))
    expect(document.activeElement).not.toBe(input2)
  })
})
