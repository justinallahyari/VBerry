import type { Directive } from 'vue'

interface AutofocusCleanup {
  stop: () => void
}

const cleanupMap = new WeakMap<HTMLElement, AutofocusCleanup>()

/**
 * Popup auto-focus directive optimized for both Chrome and Vivaldi:
 * - On Chrome (`document.hasFocus() === true` at mount): focuses immediately at 0ms.
 * - On Vivaldi (`document.hasFocus() === false` at mount): runs the benchmarked L6 winner
 *   (`window.load` -> `history.pushState` -> `window.focus()` -> `el.focus()`), floored at
 *   ~22ms from navigationStart so ultra-fast loads don't fire before Vivaldi attaches the
 *   popup host. Watches `document.hasFocus()` on rAF to latch immediately (even if Vivaldi
 *   skips a DOM `focus` event) and only triggers a single safety retry at +210ms if needed.
 */
export const vAutofocus: Directive<HTMLElement, boolean | undefined> = {
  mounted(el, binding) {
    if (binding.value === false) return

    let settled = false
    let interacted = false
    let triggerTimer: ReturnType<typeof setTimeout> | null = null
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    let watchRaf: number | null = null

    const clearPending = () => {
      if (triggerTimer !== null) {
        clearTimeout(triggerTimer)
        triggerTimer = null
      }
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer)
        fallbackTimer = null
      }
      if (watchRaf !== null) {
        cancelAnimationFrame(watchRaf)
        watchRaf = null
      }
    }

    const checkSettled = () => {
      if (document.activeElement === el && document.hasFocus()) {
        settled = true
        clearPending()
        return true
      }
      return false
    }

    const startWatch = () => {
      if (settled || interacted || watchRaf !== null) return
      const tick = () => {
        watchRaf = null
        if (settled || interacted) return
        if (document.hasFocus() && document.activeElement !== el) {
          el.focus({ preventScroll: true })
        }
        if (!checkSettled()) {
          watchRaf = requestAnimationFrame(tick)
        }
      }
      watchRaf = requestAnimationFrame(tick)
    }

    const runPushStateFocus = (hash: string) => {
      if (settled || interacted || checkSettled()) return
      history.pushState(null, '', hash)
      window.focus()
      el.focus({ preventScroll: true })
      checkSettled()
    }

    const onInteract = () => {
      interacted = true
      clearPending()
    }

    const onWindowFocus = () => {
      if (settled || interacted) return
      if (document.activeElement !== el) el.focus({ preventScroll: true })
      checkSettled()
    }

    const scheduleAfterLoad = () => {
      if (settled || interacted || checkSettled()) return
      // Match L6's winning ~22ms post-load floor so fast loads never fire before Vivaldi attaches
      const waitMs = Math.max(0, Math.ceil(22 - performance.now()))
      triggerTimer = setTimeout(() => {
        triggerTimer = null
        runPushStateFocus('#/search')
        if (!settled && !interacted) {
          startWatch()
          // Safety retry only past L6's ~176ms window so it never resets a normal handoff
          fallbackTimer = setTimeout(() => {
            fallbackTimer = null
            runPushStateFocus('#/ready')
          }, 210)
        }
      }, waitMs)
    }

    window.addEventListener('pointerdown', onInteract, true)
    window.addEventListener('keydown', onInteract, true)
    window.addEventListener('focus', onWindowFocus)

    if (document.hasFocus()) {
      el.focus({ preventScroll: true })
      checkSettled()
    } else if (document.readyState === 'complete') {
      scheduleAfterLoad()
    } else {
      window.addEventListener('load', scheduleAfterLoad, { once: true })
    }

    cleanupMap.set(el, {
      stop() {
        clearPending()
        window.removeEventListener('load', scheduleAfterLoad)
        window.removeEventListener('pointerdown', onInteract, true)
        window.removeEventListener('keydown', onInteract, true)
        window.removeEventListener('focus', onWindowFocus)
      },
    })
  },

  unmounted(el) {
    cleanupMap.get(el)?.stop()
    cleanupMap.delete(el)
  },
}
