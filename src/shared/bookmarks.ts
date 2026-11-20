export interface BookmarkFolderOption {
  id: string
  title: string
  level: number
}

export type BookmarkDropPosition = 'before' | 'into' | 'after'

/**
 * Chrome forbids renaming, moving, or deleting the synthetic root ('0') and
 * built-in top-level roots (Bookmarks Bar '1', Other Bookmarks '2', Mobile '3').
 */
export function isRootBookmarkFolder(node: chrome.bookmarks.BookmarkTreeNode): boolean {
  return node.id === '0' || !node.parentId || node.parentId === '0'
}

export function findBookmarkNode(
  nodes: chrome.bookmarks.BookmarkTreeNode[],
  id: string
): chrome.bookmarks.BookmarkTreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n
    if (n.children) {
      const hit = findBookmarkNode(n.children, id)
      if (hit) return hit
    }
  }
  return null
}

/**
 * True if `candidateId` is `ancestorId` itself or lives anywhere inside `ancestorId`.
 */
export function isBookmarkDescendant(
  tree: chrome.bookmarks.BookmarkTreeNode[],
  ancestorId: string,
  candidateId: string
): boolean {
  if (ancestorId === candidateId) return true
  const ancestor = findBookmarkNode(tree, ancestorId)
  if (!ancestor?.children) return false
  return findBookmarkNode(ancestor.children, candidateId) !== null
}

/**
 * Return ancestor folder IDs from top-level down to the immediate parent of `nodeId`.
 */
export function getBookmarkAncestorIds(
  nodes: chrome.bookmarks.BookmarkTreeNode[],
  nodeId: string,
  path: string[] = []
): string[] | null {
  for (const n of nodes) {
    if (n.id === nodeId) return path
    if (n.children) {
      const nextPath = n.id === '0' ? path : [...path, n.id]
      const found = getBookmarkAncestorIds(n.children, nodeId, nextPath)
      if (found) return found
    }
  }
  return null
}

/**
 * Collect all folders in display order for destination dropdowns, optionally excluding
 * a folder and its entire subtree (to prevent moving a folder into itself).
 */
export function collectBookmarkFolders(
  nodes: chrome.bookmarks.BookmarkTreeNode[],
  excludeSubtreeId?: string,
  level = 0
): BookmarkFolderOption[] {
  const out: BookmarkFolderOption[] = []
  for (const n of nodes) {
    if (n.id === '0') {
      if (n.children) out.push(...collectBookmarkFolders(n.children, excludeSubtreeId, 0))
      continue
    }
    if (n.url) continue
    if (excludeSubtreeId && n.id === excludeSubtreeId) continue
    out.push({ id: n.id, title: n.title || 'Folder', level })
    if (n.children) {
      out.push(...collectBookmarkFolders(n.children, excludeSubtreeId, level + 1))
    }
  }
  return out
}

export function countFolderItems(node: chrome.bookmarks.BookmarkTreeNode): number {
  let count = 0
  for (const c of node.children ?? []) {
    count += 1 + countFolderItems(c)
  }
  return count
}

export function normalizeBookmarkUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

/**
 * Compute the Chrome `chrome.bookmarks.move(id, destination)` target for dragging
 * `dragged` onto `target` at `position`. Returns `null` if the drop is invalid or a no-op.
 */
export function computeBookmarkDropDestination(
  tree: chrome.bookmarks.BookmarkTreeNode[],
  dragged: chrome.bookmarks.BookmarkTreeNode,
  target: chrome.bookmarks.BookmarkTreeNode,
  position: BookmarkDropPosition
): { parentId: string; index?: number } | null {
  if (isRootBookmarkFolder(dragged)) return null
  if (dragged.id === target.id) return null

  const targetIsFolder = !target.url
  if (position === 'into') {
    if (!targetIsFolder) return null
    if (isBookmarkDescendant(tree, dragged.id, target.id)) return null
    return { parentId: target.id }
  }

  // Cannot drop before/after a root folder (parentId === '0')
  if (isRootBookmarkFolder(target) || !target.parentId) return null
  if (isBookmarkDescendant(tree, dragged.id, target.parentId)) return null

  const targetIdx = target.index ?? 0
  const rawIndex = position === 'before' ? targetIdx : targetIdx + 1

  // No-op check when already in the exact spot inside the same parent
  if (
    dragged.parentId === target.parentId &&
    dragged.index !== undefined &&
    (rawIndex === dragged.index || rawIndex === dragged.index + 1)
  ) {
    return null
  }

  return { parentId: target.parentId, index: rawIndex }
}

/**
 * Sort direct children of `folderId` (folders first, then bookmarks) by title or URL.
 */
export async function sortFolderBookmarks(
  folderId: string,
  by: 'title' | 'url'
): Promise<void> {
  const children = await chrome.bookmarks.getChildren(folderId)
  if (children.length < 2) return

  const sorted = [...children].sort((a, b) => {
    const aFolder = !a.url ? 0 : 1
    const bFolder = !b.url ? 0 : 1
    if (aFolder !== bFolder) return aFolder - bFolder
    const av = (by === 'url' && a.url ? a.url : a.title) || ''
    const bv = (by === 'url' && b.url ? b.url : b.title) || ''
    return av.localeCompare(bv, undefined, { sensitivity: 'base' })
  })

  for (let i = 0; i < sorted.length; i++) {
    await chrome.bookmarks.move(sorted[i].id, { parentId: folderId, index: i }).catch(() => {})
  }
}
