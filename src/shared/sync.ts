import {
  DEFAULT_SETTINGS,
  type SavedPanel,
  type Settings,
  type SyncStateMeta,
  type VBerrySnapshot,
} from './types'
import {
  applySyncedConfigToLocal,
  applySyncedSnapshotsToLocal,
  loadSavedPanels,
  loadSettings,
  loadSnapshots,
  loadSyncConfig,
  loadSyncMeta,
  normalizeSettings,
  saveSyncMeta,
  STORAGE_KEYS,
  toArray,
} from './storage'

/**
 * Browser Account Sync Engine (`chrome.storage.sync`)
 * - Google Chrome: Syncs through the signed-in Google Account (Chrome Sync -> Extensions / Settings)
 * - Vivaldi: Syncs through the signed-in Vivaldi Account (Vivaldi Sync -> Extensions, E2EE)
 *
 * Uses built-in Web `CompressionStream('deflate-raw')`, deterministic slot keys (`vb_cfg_*`, `vb_snp_*`)
 * to prevent Vivaldi sync server key-churn conflicts, FNV-1a checksums against partial sync batches,
 * tombstone-aware snapshot merging, and binary-searched quota fitting under Chromium's 100 KB ceiling.
 */

export const SYNC_QUOTA_BYTES = 102_400
export const SYNC_ITEM_QUOTA_BYTES = 8_192
const SAFE_SYNC_TOTAL_BYTES = 98_000
const CHUNK_CHAR_LIMIT = 7_600
const MAX_TOMBSTONES = 150

export const SYNC_CFG_META_KEY = 'vb_cfg_m'
export const SYNC_CFG_CHUNK_PREFIX = 'vb_cfg_'
export const SYNC_SNP_META_KEY = 'vb_snp_m'
export const SYNC_SNP_CHUNK_PREFIX = 'vb_snp_'

interface SyncChunkMeta {
  v: 1
  rev: number
  by: string
  n: number
  len: number
  hash: number
  count?: number
  total?: number
}

interface SyncedConfigPayload {
  v: 1
  settings: Settings
  savedPanels: SavedPanel[]
}

interface SyncedSnapshotsPayload {
  v: 1
  snapshots: VBerrySnapshot[]
  deletedIds: string[]
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

export function fnv1a32(str: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  const step = 0x2000
  for (let i = 0; i < bytes.length; i += step) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + step)))
  }
  return btoa(parts.join(''))
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

export async function encodeSyncPayload(data: unknown): Promise<string> {
  const json = JSON.stringify(data)
  if (typeof CompressionStream === 'function') {
    try {
      const cs = new CompressionStream('deflate-raw')
      const writer = cs.writable.getWriter()
      void writer.write(utf8Encoder.encode(json))
      void writer.close()
      const compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer())
      const b64 = bytesToBase64(compressed)
      if (b64.length + 2 < utf8Encoder.encode(json).byteLength) {
        return `d:${b64}`
      }
    } catch {
      // Fall back to plain JSON below
    }
  }
  return `j:${json}`
}

export async function decodeSyncPayload<T = unknown>(encoded: string): Promise<T> {
  if (encoded.startsWith('d:')) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('DecompressionStream unavailable')
    }
    const bytes = base64ToBytes(encoded.slice(2))
    const ds = new DecompressionStream('deflate-raw')
    const writer = ds.writable.getWriter()
    void writer.write(bytes)
    void writer.close()
    const decompressed = new Uint8Array(await new Response(ds.readable).arrayBuffer())
    return JSON.parse(utf8Decoder.decode(decompressed)) as T
  }
  if (encoded.startsWith('j:')) {
    return JSON.parse(encoded.slice(2)) as T
  }
  throw new Error('Unrecognized sync payload header')
}

export function splitIntoChunks(encoded: string, limit = CHUNK_CHAR_LIMIT): string[] {
  if (!encoded.length) return []
  const chunks: string[] = []
  for (let i = 0; i < encoded.length; i += limit) {
    chunks.push(encoded.slice(i, i + limit))
  }
  return chunks
}

export function estimateSyncItemBytes(key: string, value: unknown): number {
  return (
    utf8Encoder.encode(key).byteLength + utf8Encoder.encode(JSON.stringify(value)).byteLength
  )
}

export function estimateSyncMapBytes(items: Record<string, unknown>): number {
  let total = 0
  for (const [k, v] of Object.entries(items)) {
    if (v !== undefined) total += estimateSyncItemBytes(k, v)
  }
  return total
}

function buildBundleEntries(
  metaKey: string,
  chunkPrefix: string,
  encoded: string,
  metaBase: Omit<SyncChunkMeta, 'n' | 'len' | 'hash'>
): Record<string, unknown> {
  const chunks = splitIntoChunks(encoded)
  const meta: SyncChunkMeta = {
    ...metaBase,
    n: chunks.length,
    len: encoded.length,
    hash: fnv1a32(encoded),
  }
  const out: Record<string, unknown> = { [metaKey]: meta }
  for (let i = 0; i < chunks.length; i++) {
    out[`${chunkPrefix}${i}`] = chunks[i]
  }
  return out
}

function isValidChunkMeta(raw: unknown): raw is SyncChunkMeta {
  if (!raw || typeof raw !== 'object') return false
  const m = raw as Partial<SyncChunkMeta>
  return (
    m.v === 1 &&
    typeof m.rev === 'number' &&
    typeof m.n === 'number' &&
    m.n >= 0 &&
    m.n <= 256 &&
    typeof m.len === 'number' &&
    typeof m.hash === 'number'
  )
}

function assembleRemoteEncoded(
  syncSnapshot: Record<string, unknown>,
  metaKey: string,
  chunkPrefix: string
): { meta: SyncChunkMeta; encoded: string } | null {
  const rawMeta = syncSnapshot[metaKey]
  if (!isValidChunkMeta(rawMeta)) return null

  const parts: string[] = []
  for (let i = 0; i < rawMeta.n; i++) {
    const chunk = syncSnapshot[`${chunkPrefix}${i}`]
    if (typeof chunk !== 'string') return null
    parts.push(chunk)
  }
  const joined = parts.join('')
  if (joined.length !== rawMeta.len || fnv1a32(joined) !== rawMeta.hash) {
    // Partial sync batch still arriving from browser sync engine; wait for remaining chunks
    return null
  }
  return { meta: rawMeta, encoded: joined }
}

async function applyDiffWriteToSync(
  currentSync: Record<string, unknown>,
  nextEntries: Record<string, unknown>,
  chunkPrefix: string,
  newChunkCount: number
): Promise<void> {
  const syncArea = chrome.storage?.sync
  if (!syncArea) throw new Error('Browser sync storage API is unavailable.')

  const toSet: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(nextEntries)) {
    const prev = currentSync[k]
    if (typeof v === 'string') {
      if (prev !== v) toSet[k] = v
    } else if (JSON.stringify(prev) !== JSON.stringify(v)) {
      toSet[k] = v
    }
  }

  const staleKeys: string[] = []
  const metaKey = `${chunkPrefix}m`
  for (const existingKey of Object.keys(currentSync)) {
    if (existingKey === metaKey || !existingKey.startsWith(chunkPrefix)) continue
    const idx = Number(existingKey.slice(chunkPrefix.length))
    if (Number.isInteger(idx) && idx >= newChunkCount) {
      staleKeys.push(existingKey)
    }
  }

  // Remove stale tail chunks BEFORE setting new items so total bytes never transiently spike over quota
  if (staleKeys.length > 0) {
    await syncArea.remove(staleKeys)
    for (const k of staleKeys) delete currentSync[k]
  }

  if (Object.keys(toSet).length > 0) {
    for (const [k, v] of Object.entries(toSet)) {
      if (estimateSyncItemBytes(k, v) > SYNC_ITEM_QUOTA_BYTES) {
        throw new Error(`Sync item "${k}" exceeded the 8 KB browser per-item limit.`)
      }
    }
    await syncArea.set(toSet)
    Object.assign(currentSync, toSet)
  }
}

export function mergeSnapshotsWithTombstones(
  localSnapshots: VBerrySnapshot[],
  remoteSnapshots: VBerrySnapshot[],
  localDeletedIds: string[],
  remoteDeletedIds: string[]
): {
  snapshots: VBerrySnapshot[]
  deletedIds: string[]
  localChanged: boolean
  remoteMissingChanges: boolean
} {
  const deletedSet = new Set<string>()
  for (const id of localDeletedIds) if (id) deletedSet.add(id)
  for (const id of remoteDeletedIds) if (id) deletedSet.add(id)
  const deletedIds = [...deletedSet].slice(-MAX_TOMBSTONES)
  const activeTombstones = new Set(deletedIds)

  const byId = new Map<string, VBerrySnapshot>()
  // Remote first, then local (or identical snapshots by ID; snapshots are immutable once captured)
  for (const s of remoteSnapshots) {
    if (s && typeof s.id === 'string' && !activeTombstones.has(s.id)) {
      byId.set(s.id, s)
    }
  }
  for (const s of localSnapshots) {
    if (s && typeof s.id === 'string' && !activeTombstones.has(s.id)) {
      if (!byId.has(s.id)) byId.set(s.id, s)
    }
  }

  const merged = [...byId.values()].sort((a, b) => (b.time || 0) - (a.time || 0))
  const localIds = localSnapshots.map(s => s.id).join(',')
  const mergedIds = merged.map(s => s.id).join(',')
  const remoteIds = remoteSnapshots.map(s => s.id).join(',')

  const remoteDeletedSet = new Set(remoteDeletedIds)
  const hasNewLocalTombstones = localDeletedIds.some(id => !remoteDeletedSet.has(id))

  return {
    snapshots: merged,
    deletedIds,
    localChanged: localIds !== mergedIds,
    remoteMissingChanges: remoteIds !== mergedIds || hasNewLocalTombstones,
  }
}

export async function packSnapshotsWithinBudget(
  snapshots: VBerrySnapshot[],
  deletedIds: string[],
  maxBytesBudget: number,
  rev: number,
  deviceId: string
): Promise<{ entries: Record<string, unknown>; count: number }> {
  const sorted = [...snapshots].sort((a, b) => (b.time || 0) - (a.time || 0))
  const trimmedDeleted = deletedIds.slice(-MAX_TOMBSTONES)

  const buildForCount = async (count: number) => {
    const slice = sorted.slice(0, count)
    const payload: SyncedSnapshotsPayload = {
      v: 1,
      snapshots: slice,
      deletedIds: trimmedDeleted,
    }
    const encoded = await encodeSyncPayload(payload)
    const entries = buildBundleEntries(SYNC_SNP_META_KEY, SYNC_SNP_CHUNK_PREFIX, encoded, {
      v: 1,
      rev,
      by: deviceId,
      count,
      total: sorted.length,
    })
    return { entries, bytes: estimateSyncMapBytes(entries), count }
  }

  const full = await buildForCount(sorted.length)
  if (full.bytes <= maxBytesBudget) {
    return { entries: full.entries, count: full.count }
  }

  // Binary-search largest newest-first prefix fitting inside maxBytesBudget
  let lo = 0
  let hi = sorted.length - 1
  let best = await buildForCount(0)
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const candidate = await buildForCount(mid)
    if (candidate.bytes <= maxBytesBudget) {
      best = candidate
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return { entries: best.entries, count: best.count }
}

function countOtherSyncBytes(
  currentSync: Record<string, unknown>,
  excludePrefixes: string[]
): number {
  let bytes = 0
  for (const [k, v] of Object.entries(currentSync)) {
    if (excludePrefixes.some(p => k.startsWith(p))) continue
    bytes += estimateSyncItemBytes(k, v)
  }
  return bytes
}

async function hasCustomLocalConfig(): Promise<boolean> {
  const res = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.savedPanels])
  return res[STORAGE_KEYS.settings] !== undefined || res[STORAGE_KEYS.savedPanels] !== undefined
}

let syncChain: Promise<SyncStateMeta> = Promise.resolve(null as unknown as SyncStateMeta)

function withSyncLock(fn: () => Promise<SyncStateMeta>): Promise<SyncStateMeta> {
  const next = syncChain.then(fn, fn)
  syncChain = next.catch(() => null as unknown as SyncStateMeta)
  return next
}

/**
 * Reconcile local settings, saved groups, and snapshots with `chrome.storage.sync`.
 * Safe to call from startup (`pullOnly: true`), debounced local storage listeners,
 * `sync` storage change listeners, or the Preferences "Sync now" button.
 */
export async function reconcileSync(opts?: {
  forcePush?: boolean
  pullOnly?: boolean
}): Promise<SyncStateMeta> {
  return withSyncLock(async () => {
    const [config, initialMeta] = await Promise.all([loadSyncConfig(), loadSyncMeta()])
    let meta = { ...initialMeta }
    const allowPush = opts?.pullOnly !== true || opts?.forcePush === true

    const syncArea = chrome.storage?.sync
    if (!syncArea) {
      return saveSyncMeta({ lastError: 'Browser sync storage is unavailable in this context.' })
    }

    if (!config.enabled) {
      const bytes = await syncArea
        .getBytesInUse?.(null)
        .catch(async () => estimateSyncMapBytes(await syncArea.get(null).catch(() => ({}))))
      return saveSyncMeta({
        bytesInUse: typeof bytes === 'number' ? bytes : meta.bytesInUse,
        lastError: null,
      })
    }

    try {
      const currentSync = (await syncArea.get(null)) as Record<string, unknown>
      let syncedWithRemote = allowPush

      // 1. Reconcile Settings + Saved Panels
      if (config.syncSettings) {
        const rawCfgMeta = isValidChunkMeta(currentSync[SYNC_CFG_META_KEY])
          ? (currentSync[SYNC_CFG_META_KEY] as SyncChunkMeta)
          : null
        const remoteCfgBundle = assembleRemoteEncoded(
          currentSync,
          SYNC_CFG_META_KEY,
          SYNC_CFG_CHUNK_PREFIX
        )
        if (remoteCfgBundle) syncedWithRemote = true
        const cfgBatchIncomplete = rawCfgMeta !== null && remoteCfgBundle === null
        const remoteRev = remoteCfgBundle?.meta.rev ?? rawCfgMeta?.rev ?? 0

        if (
          !cfgBatchIncomplete &&
          remoteCfgBundle &&
          !opts?.forcePush &&
          remoteRev > meta.settingsUpdatedAt &&
          remoteRev !== meta.appliedSettingsRev
        ) {
          const decoded = await decodeSyncPayload<SyncedConfigPayload>(remoteCfgBundle.encoded)
          const nextSettings = normalizeSettings(decoded?.settings ?? DEFAULT_SETTINGS)
          const nextPanels = toArray<SavedPanel>(decoded?.savedPanels)
          await applySyncedConfigToLocal(nextSettings, nextPanels, remoteRev)
          meta = await loadSyncMeta()
        } else if (!cfgBatchIncomplete) {
          const localHasData = meta.settingsUpdatedAt > 0 || (await hasCustomLocalConfig())
          const shouldPushCfg =
            allowPush &&
            (opts?.forcePush === true ||
              (remoteCfgBundle === null && localHasData && rawCfgMeta === null) ||
              meta.settingsUpdatedAt > remoteRev)

          if (shouldPushCfg) {
            const [settings, savedPanels] = await Promise.all([loadSettings(), loadSavedPanels()])
            const pushRev = opts?.forcePush
              ? Math.max(Date.now(), meta.settingsUpdatedAt, remoteRev + 1)
              : meta.settingsUpdatedAt > remoteRev
                ? meta.settingsUpdatedAt
                : Math.max(Date.now(), remoteRev + 1)
            const payload: SyncedConfigPayload = {
              v: 1,
              settings,
              savedPanels,
            }
            const encoded = await encodeSyncPayload(payload)
            const entries = buildBundleEntries(
              SYNC_CFG_META_KEY,
              SYNC_CFG_CHUNK_PREFIX,
              encoded,
              { v: 1, rev: pushRev, by: meta.deviceId }
            )
            const otherBytes = countOtherSyncBytes(currentSync, [SYNC_CFG_CHUNK_PREFIX])
            if (otherBytes + estimateSyncMapBytes(entries) > SAFE_SYNC_TOTAL_BYTES) {
              if (estimateSyncMapBytes(entries) > SAFE_SYNC_TOTAL_BYTES) {
                throw new Error(
                  'Settings & custom CSS exceed the 100 KB browser sync limit. Shorten custom CSS to sync.'
                )
              }
            }
            const chunkCount = (entries[SYNC_CFG_META_KEY] as SyncChunkMeta).n
            await applyDiffWriteToSync(currentSync, entries, SYNC_CFG_CHUNK_PREFIX, chunkCount)
            meta = await saveSyncMeta({
              settingsUpdatedAt: pushRev,
              appliedSettingsRev: pushRev,
            })
          } else if (remoteCfgBundle && meta.appliedSettingsRev !== remoteRev) {
            meta = await saveSyncMeta({ appliedSettingsRev: remoteRev })
          }
        }
      }

      // 2. Reconcile Snapshots (Non-destructive union merge + tombstones + quota-aware prefix packing)
      let localSnapshots = await loadSnapshots()
      let syncedSnapshotCount = meta.syncedSnapshotCount

      if (config.syncSnapshots) {
        const rawSnpMeta = isValidChunkMeta(currentSync[SYNC_SNP_META_KEY])
          ? (currentSync[SYNC_SNP_META_KEY] as SyncChunkMeta)
          : null
        const remoteSnpBundle = assembleRemoteEncoded(
          currentSync,
          SYNC_SNP_META_KEY,
          SYNC_SNP_CHUNK_PREFIX
        )
        if (remoteSnpBundle) syncedWithRemote = true
        const snpBatchIncomplete = rawSnpMeta !== null && remoteSnpBundle === null
        const remoteRev = remoteSnpBundle?.meta.rev ?? rawSnpMeta?.rev ?? 0

        if (!snpBatchIncomplete) {
          let remotePayload: SyncedSnapshotsPayload | null = null
          if (remoteSnpBundle) {
            remotePayload = await decodeSyncPayload<SyncedSnapshotsPayload>(remoteSnpBundle.encoded)
          }

          const remoteSnapshots = toArray<VBerrySnapshot>(remotePayload?.snapshots)
          const remoteDeleted = Array.isArray(remotePayload?.deletedIds)
            ? remotePayload!.deletedIds.filter((x): x is string => typeof x === 'string')
            : []

          const merged = mergeSnapshotsWithTombstones(
            localSnapshots,
            remoteSnapshots,
            meta.deletedSnapshotIds,
            remoteDeleted
          )

          const remoteWasQuotaCapped =
            remoteSnpBundle !== null &&
            typeof remoteSnpBundle.meta.count === 'number' &&
            typeof remoteSnpBundle.meta.total === 'number' &&
            remoteSnpBundle.meta.count < remoteSnpBundle.meta.total

          const effectiveRemoteMissing = remoteWasQuotaCapped
            ? merged.snapshots
                .slice(0, remoteSnpBundle!.meta.count)
                .map(s => s.id)
                .join(',') !== remoteSnapshots.map(s => s.id).join(',') ||
              meta.deletedSnapshotIds.some(id => !remoteDeleted.includes(id))
            : merged.remoteMissingChanges

          const shouldPushSnapshots =
            allowPush &&
            (opts?.forcePush === true ||
              (remoteSnpBundle === null &&
                rawSnpMeta === null &&
                (merged.snapshots.length > 0 || merged.deletedIds.length > 0)) ||
              meta.snapshotsUpdatedAt > remoteRev ||
              (remoteSnpBundle !== null && effectiveRemoteMissing))

          const nextRev = shouldPushSnapshots
            ? opts?.forcePush
              ? Math.max(Date.now(), meta.snapshotsUpdatedAt, remoteRev + 1)
              : meta.snapshotsUpdatedAt > remoteRev
                ? meta.snapshotsUpdatedAt
                : Math.max(Date.now(), remoteRev + 1)
            : Math.max(remoteRev, meta.snapshotsUpdatedAt)

          if (merged.localChanged || merged.deletedIds.length !== meta.deletedSnapshotIds.length) {
            await applySyncedSnapshotsToLocal(merged.snapshots, merged.deletedIds, nextRev)
            localSnapshots = merged.snapshots
            meta = await loadSyncMeta()
          }

          if (shouldPushSnapshots) {
            const nonSnapBytes = countOtherSyncBytes(currentSync, [SYNC_SNP_CHUNK_PREFIX])
            const budget = Math.max(2_048, SAFE_SYNC_TOTAL_BYTES - nonSnapBytes)
            const packed = await packSnapshotsWithinBudget(
              merged.snapshots,
              merged.deletedIds,
              budget,
              nextRev,
              meta.deviceId
            )
            const chunkCount = (packed.entries[SYNC_SNP_META_KEY] as SyncChunkMeta).n
            await applyDiffWriteToSync(
              currentSync,
              packed.entries,
              SYNC_SNP_CHUNK_PREFIX,
              chunkCount
            )
            syncedSnapshotCount = packed.count
            meta = await saveSyncMeta({
              snapshotsUpdatedAt: nextRev,
              appliedSnapshotsRev: nextRev,
              deletedSnapshotIds: merged.deletedIds,
              syncedSnapshotCount: packed.count,
              totalSnapshotCount: merged.snapshots.length,
            })
          } else {
            syncedSnapshotCount = remoteSnpBundle?.meta.count ?? meta.syncedSnapshotCount
            meta = await saveSyncMeta({
              appliedSnapshotsRev: Math.max(meta.appliedSnapshotsRev, remoteRev),
              syncedSnapshotCount,
              totalSnapshotCount: merged.snapshots.length,
            })
          }
        }
      }

      const measuredBytes =
        typeof syncArea.getBytesInUse === 'function'
          ? await syncArea.getBytesInUse(null).catch(() => estimateSyncMapBytes(currentSync))
          : estimateSyncMapBytes(currentSync)

      return await saveSyncMeta({
        bytesInUse: measuredBytes,
        ...(syncedWithRemote ? { lastSyncedAt: Date.now() } : {}),
        lastError: null,
        syncedSnapshotCount: config.syncSnapshots ? syncedSnapshotCount : 0,
        totalSnapshotCount: localSnapshots.length,
      })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not complete browser sync right now.'
      return saveSyncMeta({ lastError: message })
    }
  })
}
