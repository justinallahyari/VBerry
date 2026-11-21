import { describe, expect, it } from 'vitest'
import { historyStartTime, rankSearchItems, scoreSearchMatch } from './search'

describe('Search Ranking & History Range', () => {
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

  it('computes history startTime from days (0 = all time)', () => {
    const now = 1_700_000_000_000
    expect(historyStartTime(0, now)).toBe(0)
    expect(historyStartTime(7, now)).toBe(now - 7 * 86_400_000)
    expect(historyStartTime(1, now)).toBe(now - 86_400_000)
  })
})
