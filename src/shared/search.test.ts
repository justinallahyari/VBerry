import { describe, expect, it } from 'vitest'
import { formatKeyEvent, matchesShortcut, rankSearchItems, scoreSearchMatch } from './search'

describe('Search Ranking & Panel Shortcuts', () => {
  it('ranks exact / prefix / domain matches above loose URL matches', () => {
    const items = [
      { id: 1, title: 'Random article', url: 'https://blog.example.com/about-github-actions' },
      { id: 2, title: 'GitHub', url: 'https://github.com/' },
      { id: 3, title: 'GitHub Pull Requests', url: 'https://github.com/pulls' },
    ]
    const ranked = rankSearchItems(items, 'github', i => i)
    expect(ranked.map(i => i.id)).toEqual([2, 3, 1])
  })

  it('supports multi-word token matching', () => {
    expect(scoreSearchMatch('git pull', 'GitHub Pull Requests', 'https://github.com/pulls')).toBeGreaterThan(0)
    expect(scoreSearchMatch('git nope', 'GitHub Pull Requests', 'https://github.com/pulls')).toBe(0)
  })

  it('formats and matches Alt+1 shortcuts cleanly even on macOS Alt symbol keys', () => {
    const macAlt1 = {
      key: '¡',
      code: 'Digit1',
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    } as KeyboardEvent

    expect(formatKeyEvent(macAlt1)).toBe('Alt+1')
    expect(matchesShortcut(macAlt1, 'Alt+1')).toBe(true)
    expect(matchesShortcut(macAlt1, 'Alt+2')).toBe(false)
  })
})
