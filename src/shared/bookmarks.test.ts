import { describe, expect, it, vi } from 'vitest'
import {
  collectBookmarkFolders,
  collectTrashBookmarkIds,
  computeBookmarkDropDestination,
  countFolderItems,
  getBookmarkAncestorIds,
  isBookmarkDescendant,
  isRootBookmarkFolder,
  isTrashBookmarkFolder,
  normalizeBookmarkUrl,
  searchNonTrashBookmarks,
  sortFolderBookmarks,
  stripTrashFolders,
} from './bookmarks'

const sampleTree: chrome.bookmarks.BookmarkTreeNode[] = [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        parentId: '0',
        index: 0,
        title: 'Bookmarks Bar',
        children: [
          { id: '10', parentId: '1', index: 0, title: 'Alpha', url: 'https://alpha.example' },
          {
            id: '11',
            parentId: '1',
            index: 1,
            title: 'Work',
            children: [
              { id: '110', parentId: '11', index: 0, title: 'Docs', url: 'https://docs.example' },
              {
                id: '111',
                parentId: '11',
                index: 1,
                title: 'Nested',
                children: [],
              },
            ],
          },
          { id: '12', parentId: '1', index: 2, title: 'Beta', url: 'https://beta.example' },
        ],
      },
      {
        id: '2',
        parentId: '0',
        index: 1,
        title: 'Other Bookmarks',
        children: [],
      },
    ],
  },
]

describe('bookmark helpers', () => {
  it('identifies root folders and prevents dragging/dropping invalid targets', () => {
    const bar = sampleTree[0].children![0]
    const work = bar.children![1]
    const nested = work.children![1]
    const alpha = bar.children![0]

    expect(isRootBookmarkFolder(sampleTree[0])).toBe(true)
    expect(isRootBookmarkFolder(bar)).toBe(true)
    expect(isRootBookmarkFolder(work)).toBe(false)
    expect(isBookmarkDescendant(sampleTree, '11', '111')).toBe(true)
    expect(isBookmarkDescendant(sampleTree, '11', '10')).toBe(false)

    // Cannot move root folder
    expect(computeBookmarkDropDestination(sampleTree, bar, work, 'into')).toBeNull()
    // Cannot drop folder into its own descendant
    expect(computeBookmarkDropDestination(sampleTree, work, nested, 'into')).toBeNull()
    // Cannot drop before/after a root folder
    expect(computeBookmarkDropDestination(sampleTree, alpha, bar, 'before')).toBeNull()
  })

  it('computes valid drop destinations for before, after, and into', () => {
    const bar = sampleTree[0].children![0]
    const alpha = bar.children![0]
    const work = bar.children![1]
    const beta = bar.children![2]

    // No-op when dropping adjacent to itself
    expect(computeBookmarkDropDestination(sampleTree, alpha, work, 'before')).toBeNull()
    // Move Alpha after Beta
    expect(computeBookmarkDropDestination(sampleTree, alpha, beta, 'after')).toEqual({
      parentId: '1',
      index: 3,
    })
    // Move Beta before Alpha
    expect(computeBookmarkDropDestination(sampleTree, beta, alpha, 'before')).toEqual({
      parentId: '1',
      index: 0,
    })
    // Move Alpha into Work folder
    expect(computeBookmarkDropDestination(sampleTree, alpha, work, 'into')).toEqual({
      parentId: '11',
    })
  })

  it('collects folders excluding a subtree and computes ancestor paths', () => {
    const all = collectBookmarkFolders(sampleTree)
    expect(all.map(f => `${f.level}:${f.id}`)).toEqual(['0:1', '1:11', '2:111', '0:2'])

    const excludingWork = collectBookmarkFolders(sampleTree, '11')
    expect(excludingWork.map(f => f.id)).toEqual(['1', '2'])

    expect(getBookmarkAncestorIds(sampleTree, '110')).toEqual(['1', '11'])
    expect(countFolderItems(sampleTree[0].children![0])).toBe(5)
  })

  it('normalizes URLs cleanly', () => {
    expect(normalizeBookmarkUrl('example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeBookmarkUrl('http://localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeBookmarkUrl('chrome://settings')).toBe('chrome://settings')
    expect(normalizeBookmarkUrl('   ')).toBe('')
  })

  it('sorts folder children with folders first, then bookmarks by title', async () => {
    const moveMock = vi.fn(async () => ({}))
    ;(globalThis as unknown as { chrome: unknown }).chrome = {
      bookmarks: {
        getChildren: vi.fn(async () => [
          { id: 'b2', parentId: '1', title: 'Zeta', url: 'https://z.example' },
          { id: 'f2', parentId: '1', title: 'Sub B' },
          { id: 'b1', parentId: '1', title: 'Alpha', url: 'https://a.example' },
          { id: 'f1', parentId: '1', title: 'Sub A' },
        ]),
        move: moveMock,
      },
    }

    await sortFolderBookmarks('1', 'title')
    expect(moveMock.mock.calls).toEqual([
      ['f1', { parentId: '1', index: 0 }],
      ['f2', { parentId: '1', index: 1 }],
      ['b1', { parentId: '1', index: 2 }],
      ['b2', { parentId: '1', index: 3 }],
    ])
  })

  it('strips Vivaldi Trash folders and excludes trashed bookmarks from search', async () => {
    const treeWithTrash: chrome.bookmarks.BookmarkTreeNode[] = [
      {
        id: '0',
        title: '',
        children: [
          ...sampleTree[0].children!,
          {
            id: '999',
            parentId: '0',
            title: 'Trash',
            children: [
              { id: 't1', parentId: '999', title: 'Deleted Site', url: 'https://deleted.example' },
              {
                id: 't2',
                parentId: '999',
                title: 'Deleted Folder',
                children: [
                  { id: 't3', parentId: 't2', title: 'Deep Deleted', url: 'https://deep.example' },
                ],
              },
            ],
          },
        ],
      },
    ]

    expect(isTrashBookmarkFolder(treeWithTrash[0].children![2])).toBe(true)
    expect([...collectTrashBookmarkIds(treeWithTrash)].sort()).toEqual(['999', 't1', 't2', 't3'])
    expect(stripTrashFolders(treeWithTrash)[0].children!.map(c => c.id)).toEqual(['1', '2'])
    expect(collectBookmarkFolders(treeWithTrash).map(f => f.id)).not.toContain('999')

    ;(globalThis as unknown as { chrome: unknown }).chrome = {
      bookmarks: {
        getTree: vi.fn(async () => treeWithTrash),
        search: vi.fn(async () => [
          { id: '10', parentId: '1', title: 'Alpha', url: 'https://alpha.example' },
          { id: 't1', parentId: '999', title: 'Deleted Site', url: 'https://deleted.example' },
          { id: 't3', parentId: 't2', title: 'Deep Deleted', url: 'https://deep.example' },
        ]),
      },
    }

    const results = await searchNonTrashBookmarks('example')
    expect(results.map(r => r.id)).toEqual(['10'])
  })
})
