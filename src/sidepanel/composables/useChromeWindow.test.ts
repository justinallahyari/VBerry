import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type ActiveView, type Settings } from '@/shared/types'
import { resolvePopupInitialView } from './useChromeWindow'

function makeSettings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...patch }
}

describe('resolvePopupInitialView', () => {
  const activeGroup: ActiveView = { kind: 'group', groupId: 7 }

  it('opens Unified Search by default when enabled', () => {
    expect(resolvePopupInitialView(makeSettings(), activeGroup)).toEqual({ kind: 'search' })
  })

  it('falls back to active tab view when Unified Search is disabled', () => {
    expect(
      resolvePopupInitialView(makeSettings({ popupDefaultView: 'search', unifiedSearch: false }), activeGroup)
    ).toEqual(activeGroup)
  })

  it('opens active tab view when set to tabs', () => {
    expect(resolvePopupInitialView(makeSettings({ popupDefaultView: 'tabs' }), activeGroup)).toEqual(
      activeGroup
    )
  })

  it('opens Bookmarks, History, or Snapshots when selected and enabled', () => {
    expect(resolvePopupInitialView(makeSettings({ popupDefaultView: 'bookmarks' }), activeGroup)).toEqual({
      kind: 'bookmarks',
    })
    expect(resolvePopupInitialView(makeSettings({ popupDefaultView: 'history' }), activeGroup)).toEqual({
      kind: 'history',
    })
    expect(resolvePopupInitialView(makeSettings({ popupDefaultView: 'snapshots' }), activeGroup)).toEqual({
      kind: 'snapshots',
    })
  })

  it('falls back to active tab view when chosen utility panel is hidden', () => {
    expect(
      resolvePopupInitialView(
        makeSettings({ popupDefaultView: 'bookmarks', showBookmarksPanel: false }),
        activeGroup
      )
    ).toEqual(activeGroup)
    expect(
      resolvePopupInitialView(
        makeSettings({ popupDefaultView: 'history', showHistoryPanel: false }),
        activeGroup
      )
    ).toEqual(activeGroup)
    expect(
      resolvePopupInitialView(
        makeSettings({ popupDefaultView: 'snapshots', showSnapshotsPanel: false }),
        activeGroup
      )
    ).toEqual(activeGroup)
  })
})
