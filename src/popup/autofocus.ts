import type { ObjectDirective } from 'vue'

interface AutofocusCleanup {
  stop: () => void
}

const cleanupMap = new WeakMap<HTMLElement, AutofocusCleanup>()
const EXPIRE_MS = 1000

/**
 * Popup auto-focus directive for Chrome and Vivaldi:
 * - Focuses the input immediately on mount.
 * - After load, uses a `MessageChannel` turn (unthrottled while hidden) to trigger
 *   `history.replaceState(history.state, '', location.href)` so Vivaldi runs its
 *   same-document navigation focus handoff without altering URL or history length.
 * - Listens for `window` `focus`, `visibilitychange`, and `requestAnimationFrame`
 *   for up to 1s, allowing one recovery attempt after the popup becomes visible,
 *   and cancels on success, typing, clicks, popup closure (`pagehide`), or unmount.
 */
export const vAutofocus: ObjectDirective<HTMLElement, boolean | undefined> = {
  mounted(el, binding) {
    if (binding.value === false) return

    let stopped = false
    let handoffStarted = false
    let recoveredAfterVisible = false
    let channel: MessageChannel | null = null
    let rafId: number | null = null
    let expireTimer: ReturnType<typeof setTimeout> | null = null

    const closeChannel = () => {
      if (!channel) return
      channel.port1.onmessage = null
      channel.port1.close()
      channel.port2.close()
      channel = null
    }

    const isSettled = () => document.activeElement === el && document.hasFocus()

    const stop = () => {
      if (stopped) return
      stopped = true
      closeChannel()
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      if (expireTimer !== null) {
        clearTimeout(expireTimer)
        expireTimer = null
      }
      window.removeEventListener('load', onLoad)
      window.removeEventListener('focus', onWindowFocus)
      window.removeEventListener('pointerdown', onUserInteract, true)
      window.removeEventListener('keydown', onUserInteract, true)
      window.removeEventListener('pagehide', stop)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }

    const focusInput = (): boolean => {
      if (stopped) return false
      if (document.activeElement !== el) {
        el.focus({ preventScroll: true })
      }
      if (isSettled()) {
        stop()
        return true
      }
      return false
    }

    const triggerHandoff = () => {
      history.replaceState(history.state, '', location.href)
      focusInput()
    }

    const scheduleRafWatch = () => {
      if (stopped || rafId !== null) return
      const tick = () => {
        rafId = null
        if (stopped) return
        if (focusInput()) return
        if (document.visibilityState === 'visible' && handoffStarted && !recoveredAfterVisible) {
          recoveredAfterVisible = true
          triggerHandoff()
          if (stopped) return
        }
        rafId = requestAnimationFrame(tick)
      }
      rafId = requestAnimationFrame(tick)
    }

    const onWindowFocus = () => {
      if (stopped) return
      focusInput()
    }

    const onVisibilityChange = () => {
      if (stopped || document.visibilityState !== 'visible') return
      if (focusInput()) return
      if (handoffStarted && !recoveredAfterVisible) {
        recoveredAfterVisible = true
        triggerHandoff()
      }
    }

    const onUserInteract = () => {
      stop()
    }

    const runChannelHandoff = () => {
      if (stopped) return
      const complete = () => {
        closeChannel()
        focusInput()
        if (stopped) return

        handoffStarted = true
        history.replaceState(history.state, '', location.href)
        focusInput()
        if (!stopped) {
          scheduleRafWatch()
        }
      }

      if (typeof MessageChannel !== 'undefined') {
        channel = new MessageChannel()
        channel.port1.onmessage = complete
        channel.port2.postMessage(null)
      } else {
        queueMicrotask(complete)
      }
    }

    const onLoad = () => {
      if (stopped) return
      if (focusInput()) return
      runChannelHandoff()
    }

    window.addEventListener('pointerdown', onUserInteract, true)
    window.addEventListener('keydown', onUserInteract, true)
    window.addEventListener('focus', onWindowFocus)
    window.addEventListener('pagehide', stop)
    document.addEventListener('visibilitychange', onVisibilityChange)

    expireTimer = setTimeout(stop, EXPIRE_MS)
    cleanupMap.set(el, { stop })

    if (focusInput()) return

    if (document.readyState === 'complete') {
      onLoad()
    } else {
      window.addEventListener('load', onLoad, { once: true })
    }
  },

  unmounted(el) {
    cleanupMap.get(el)?.stop()
    cleanupMap.delete(el)
  },
}
