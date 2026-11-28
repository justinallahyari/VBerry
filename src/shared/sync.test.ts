import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  type SavedPanel,
  type VBerrySnapshot,
} from './types'
import {
  loadSavedPanels,
  loadSettings,
  loadSnapshots,
  loadSyncMeta,
  saveSavedPanels,
  saveSettings,
  saveSnapshots,
  saveSyncConfig,
} from './storage'
import {
  decodeSyncPayload,
  encodeSyncPayload,
  estimateSyncItemBytes,
  estimateSyncMapBytes,
  packSnapshotsWithinBudget,
  reconcileSync,
  SYNC_CFG_META_KEY,
  SYNC_ITEM_QUOTA_BYTES,
  SYNC_QUOTA_BYTES,
  SYNC_SNP_CHUNK_PREFIX,
  SYNC_SNP_META_KEY,
} from './sync'

function createStorageAreaMock(backing: Record<string, any>, enforceSyncQuotas = false) {
  return {
    QUOTA_BYTES: SYNC_QUOTA_BYTES,
    QUOTA_BYTES_PER_ITEM: SYNC_ITEM_QUOTA_BYTES,
    MAX_ITEMS: 512,
    get: vi.fn(async (keys?: string | string[] | Record<string, any> | null) => {
      if (keys === null || keys === undefined) {
        return JSON.parse(JSON.stringify(backing))
      }
      if (typeof keys === 'string') {
        return keys in backing ? { [keys]: JSON.parse(JSON.stringify(backing[keys])) } : {}
      }
      if (Array.isArray(keys)) {
        const out: Record<string, any> = {}
        for (const k of keys) {
          if (k in backing) out[k] = JSON.parse(JSON.stringify(backing[k]))
        }
        return out
      }
      const out: Record<string, any> = { ...keys }
      for (const k of Object.keys(keys)) {
        if (k in backing) out[k] = JSON.parse(JSON.stringify(backing[k]))
      }
      return out
    }),
    set: vi.fn(async (items: Record<string, any>) => {
      for (const [k, v] of Object.entries(items)) {
        if (enforceSyncQuotas && estimateSyncItemBytes(k, v) > SYNC_ITEM_QUOTA_BYTES) {
          throw new Error(`QUOTA_BYTES_PER_ITEM quota exceeded for ${k}`)
        }
        backing[k] = JSON.parse(JSON.stringify(v))
      }
      if (enforceSyncQuotas && estimateSyncMapBytes(backing) > SYNC_QUOTA_BYTES) {
        throw new Error('QUOTA_BYTES quota exceeded')
      }
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) delete backing[k]
    }),
    clear: vi.fn(async () => {
      for (const k of Object.keys(backing)) delete backing[k]
    }),
    getBytesInUse: vi.fn(async () => estimateSyncMapBytes(backing)),
  }
}

function makeSnapshot(id: string, time: number, tabCount = 8, entropy = ''): VBerrySnapshot {
  return {
    id,
    time,
    source: 'vberry',
    windows: [
      {
        pinned: [
          {
            url: 'https://vivaldi.com/features/sync/',
            title: 'Vivaldi Sync — End-to-End Encrypted',
            level: 0,
            pinned: true,
          },
        ],
        groups: [
          {
            id: 'grp_work',
            title: 'Engineering 🚀',
            color: 'blue',
            tabs: Array.from({ length: tabCount }, (_, idx) => ({
              url: `https://example.com/${id}/${idx}?q=${entropy}`,
              title: `Spec ${idx} — 日本語テスト ${entropy}`,
              level: idx % 3,
              folded: idx === 0 ? true : undefined,
            })),
          },
        ],
      },
    ],
  }
}

describe('browser account sync engine (Chrome Google Account & Vivaldi Account)', () => {
  let cloudSyncStore: Record<string, any>
  let deviceALocal: Record<string, any>
  let deviceBLocal: Record<string, any>

  function useDevice(localBacking: Record<string, any>) {
    ;(globalThis as any).chrome = {
      storage: {
        local: createStorageAreaMock(localBacking, false),
        sync: createStorageAreaMock(cloudSyncStore, true),
        session: createStorageAreaMock({}, false),
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    }
  }

  beforeEach(() => {
    cloudSyncStore = {}
    deviceALocal = {}
    deviceBLocal = {}
    useDevice(deviceALocal)
  })

  it('compresses large snapshot payloads with deflate-raw and roundtrips Unicode losslessly', async () => {
    const snaps = Array.from({ length: 20 }, (_, i) =>
      makeSnapshot(`s_${i}`, 1_700_000_000_000 + i * 1000, 15)
    )
    const rawJsonBytes = new TextEncoder().encode(JSON.stringify(snaps)).byteLength
    const encoded = await encodeSyncPayload({ v: 1, snapshots: snaps, deletedIds: [] })

    expect(encoded.startsWith('d:')).toBe(true)
    expect(encoded.length).toBeLessThan(rawJsonBytes * 0.25)

    const decoded = await decodeSyncPayload<{ v: 1; snapshots: VBerrySnapshot[] }>(encoded)
    expect(decoded.snapshots).toEqual(snaps)
  })

  it('syncs settings, custom themes, preset overrides, saved groups, and snapshots from Device A to a fresh Device B', async () => {
    useDevice(deviceALocal)
    await saveSettings({
      theme: 'theme_solar',
      customThemes: [
        {
          id: 'theme_solar',
          name: 'Solarized Studio',
          scheme: 'dark',
          bg: '#002b36',
          surface: '#073642',
          bgSubtle: '#00212b',
          border: '#194854',
          text: '#eee8d5',
          textMuted: '#93a1a1',
          defaultAccent: '#2aa198',
        },
      ],
      themeOverrides: {
        'vivaldi-dark': { bg: '#22232b', defaultAccent: '#ff6666' },
      },
      density: 'compact',
      customCss: '.tab-row { border-radius: 6px; }',
    })
    const panels: SavedPanel[] = [
      {
        id: 'p_work',
        title: 'Work',
        color: 'cyan',
        moveRules: [{ id: 'r1', active: true, pattern: 'github.com' }],
      },
    ]
    await saveSavedPanels(panels)
    const snap1 = makeSnapshot('snap_1', 1_760_000_001_000)
    await saveSnapshots([snap1])

    const metaA = await reconcileSync()
    expect(metaA.lastError).toBeNull()
    expect(metaA.bytesInUse).toBeGreaterThan(0)
    expect(metaA.syncedSnapshotCount).toBe(1)
    expect(cloudSyncStore[SYNC_CFG_META_KEY]).toBeTruthy()
    expect(cloudSyncStore[SYNC_SNP_META_KEY]).toBeTruthy()

    // Switch to brand-new Device B signed into the same Google / Vivaldi account
    useDevice(deviceBLocal)
    const metaB = await reconcileSync()
    expect(metaB.lastError).toBeNull()

    const bSettings = await loadSettings()
    expect(bSettings.theme).toBe('theme_solar')
    expect(bSettings.customThemes).toHaveLength(1)
    expect(bSettings.customThemes[0].name).toBe('Solarized Studio')
    expect(bSettings.customThemes[0].bg).toBe('#002b36')
    expect(bSettings.themeOverrides['vivaldi-dark']).toEqual({
      bg: '#22232b',
      defaultAccent: '#ff6666',
    })
    expect(bSettings.density).toBe('compact')
    expect(bSettings.customCss).toBe('.tab-row { border-radius: 6px; }')
    expect(await loadSavedPanels()).toEqual(panels)
    expect(await loadSnapshots()).toEqual([snap1])
  })

  it('merges concurrent snapshots across devices and propagates snapshot deletions via tombstones', async () => {
    // Device A creates snap_shared and snap_a, then syncs
    useDevice(deviceALocal)
    const snapShared = makeSnapshot('snap_shared', 1_760_000_001_000)
    const snapA = makeSnapshot('snap_a', 1_760_000_002_000)
    await saveSnapshots([snapA, snapShared])
    await reconcileSync()

    // Device B pulls initial state, then deletes snap_shared and captures snap_b
    useDevice(deviceBLocal)
    await reconcileSync()
    expect((await loadSnapshots()).map(s => s.id)).toEqual(['snap_a', 'snap_shared'])

    const snapB = makeSnapshot('snap_b', 1_760_000_005_000)
    await saveSnapshots([snapB, snapA]) // snap_shared was removed
    await reconcileSync()

    // Device A meantime also captured snap_a2 before pulling Device B's update
    useDevice(deviceALocal)
    const snapA2 = makeSnapshot('snap_a2', 1_760_000_004_000)
    await saveSnapshots([snapA2, snapA, snapShared])
    await reconcileSync()

    // Both devices converge on [snap_b, snap_a2, snap_a] with snap_shared deleted (never resurrected)
    const finalA = (await loadSnapshots()).map(s => s.id)
    expect(finalA).toEqual(['snap_b', 'snap_a2', 'snap_a'])

    useDevice(deviceBLocal)
    await reconcileSync()
    const finalB = (await loadSnapshots()).map(s => s.id)
    expect(finalB).toEqual(['snap_b', 'snap_a2', 'snap_a'])
  })

  it('advances monotonic revisions past skewed remote clocks on subsequent local edits', async () => {
    // Seed Device A with a clock 120 seconds in the future
    useDevice(deviceALocal)
    await saveSettings({ theme: 'tokyo' })
    await reconcileSync()
    cloudSyncStore[SYNC_CFG_META_KEY].rev = Date.now() + 120_000

    // Device B pulls future-dated remote config, then user edits theme on Device B
    useDevice(deviceBLocal)
    await reconcileSync()
    expect((await loadSettings()).theme).toBe('tokyo')

    await saveSettings({ theme: 'espresso' })
    await reconcileSync()

    // Device A pulls Device B's newer edit despite its earlier clock lead
    useDevice(deviceALocal)
    await reconcileSync()
    expect((await loadSettings()).theme).toBe('espresso')
  })

  it('waits safely without clobbering local or remote state if a multi-chunk sync batch arrives partially', async () => {
    useDevice(deviceALocal)
    const bigCss = Array.from({ length: 700 }, (_, i) => `.rule-${i} { padding: ${(i * 7) % 19}px; }`).join('\n')
    await saveSettings({ theme: 'pine', customCss: bigCss })
    await reconcileSync()

    // Simulate Vivaldi/Chrome sync delivering vb_cfg_m and vb_cfg_0 while vb_cfg_1 is still in transit
    const savedChunk1 = cloudSyncStore.vb_cfg_1
    const meta = cloudSyncStore[SYNC_CFG_META_KEY]
    if (meta.n < 2) {
      // Force multi-chunk check if deflate squeezed CSS into 1 chunk: corrupt length temporarily
      cloudSyncStore[SYNC_CFG_META_KEY] = { ...meta, len: meta.len + 5 }
    } else {
      delete cloudSyncStore.vb_cfg_1
    }

    useDevice(deviceBLocal)
    await saveSettings({ theme: 'paper' })
    // Adjust Device B timestamp below remote rev so Device B would pull once complete
    deviceBLocal.vberry_sync_meta.settingsUpdatedAt = 1
    await reconcileSync()

    // Device B kept its local 'paper' while waiting AND did not overwrite remote meta
    expect((await loadSettings()).theme).toBe('paper')
    expect(cloudSyncStore[SYNC_CFG_META_KEY].rev).toBe(meta.rev)

    // Restore missing chunk / exact meta and reconcile again -> pulls 'pine' cleanly
    if (savedChunk1 !== undefined) cloudSyncStore.vb_cfg_1 = savedChunk1
    cloudSyncStore[SYNC_CFG_META_KEY] = meta
    await reconcileSync()
    expect((await loadSettings()).theme).toBe('pine')
  })

  it('fits newest snapshots within byte budget without losing local snapshots and cleans up stale tail chunks', async () => {
    let seed = 0x12345678
    const nextRandChar = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return String.fromCharCode(48 + ((seed >>> 0) % 74))
    }
    const highEntropySnaps = Array.from({ length: 18 }, (_, i) => {
      let rand = ''
      for (let k = 0; k < 500; k++) rand += nextRandChar()
      return makeSnapshot(`heavy_${i}`, 1_760_000_000_000 + i * 1000, 6, rand)
    })

    const tightPacked = await packSnapshotsWithinBudget(highEntropySnaps, [], 6_500, 100, 'dev_1')
    expect(tightPacked.count).toBeGreaterThan(0)
    expect(tightPacked.count).toBeLessThan(highEntropySnaps.length)
    expect(estimateSyncMapBytes(tightPacked.entries)).toBeLessThanOrEqual(6_500)

    // Verify stale tail chunk cleanup when shrinking from many snapshots down to 1
    useDevice(deviceALocal)
    await saveSnapshots(highEntropySnaps)
    await reconcileSync()
    const initialChunkKeys = Object.keys(cloudSyncStore).filter(
      k => k.startsWith(SYNC_SNP_CHUNK_PREFIX) && k !== SYNC_SNP_META_KEY
    )
    expect(initialChunkKeys.length).toBeGreaterThan(1)

    await saveSnapshots([highEntropySnaps[0]])
    await reconcileSync()
    const shrunkChunkKeys = Object.keys(cloudSyncStore).filter(
      k => k.startsWith(SYNC_SNP_CHUNK_PREFIX) && k !== SYNC_SNP_META_KEY
    )
    expect(shrunkChunkKeys).toEqual(['vb_snp_0'])
  })

  it('respects per-device pause toggle without deleting remote synced data', async () => {
    useDevice(deviceALocal)
    await saveSettings({ theme: 'dawn' })
    await reconcileSync()

    await saveSyncConfig({ enabled: false })
    await saveSettings({ theme: 'espresso' })
    await reconcileSync()

    // Cloud still holds 'dawn' while Device A is paused
    useDevice(deviceBLocal)
    await reconcileSync()
    expect((await loadSettings()).theme).toBe('dawn')
    expect((await loadSyncMeta()).lastError).toBeNull()
  })

  it('does not push to empty sync storage during pull-only startup, then pulls settings and pushes merged snapshots once sync delivers remote data', async () => {
    // Device B has local data before Vivaldi finishes decrypting remote sync storage (cloud is empty)
    useDevice(deviceBLocal)
    await saveSettings({ theme: 'paper' })
    const localSnap = makeSnapshot('snap_local_b', 1_760_000_002_000)
    await saveSnapshots([localSnap])

    // Startup pull-only reconcile must NOT write anything to chrome.storage.sync
    const startupMeta = await reconcileSync({ pullOnly: true })
    expect(startupMeta.lastError).toBeNull()
    expect(startupMeta.lastSyncedAt).toBeNull()
    expect(Object.keys(cloudSyncStore)).toEqual([])

    // Now simulate Vivaldi finishing decryption and delivering Device A's newer remote config & snapshot
    useDevice(deviceALocal)
    await saveSettings({ theme: 'nord' })
    const remoteSnap = makeSnapshot('snap_remote_a', 1_760_000_005_000)
    await saveSnapshots([remoteSnap])
    await reconcileSync()
    // Ensure Device A's config revision is strictly newer than Device B's earlier local edit
    cloudSyncStore[SYNC_CFG_META_KEY].rev = Date.now() + 10_000

    // Chrome/Vivaldi fires storage.onChanged(area === 'sync') -> full reconcile on Device B
    useDevice(deviceBLocal)
    const afterDecryptMeta = await reconcileSync()
    expect(afterDecryptMeta.lastError).toBeNull()
    expect(afterDecryptMeta.lastSyncedAt).not.toBeNull()
    expect((await loadSettings()).theme).toBe('nord')
    expect((await loadSnapshots()).map(s => s.id)).toEqual(['snap_remote_a', 'snap_local_b'])

    // Verify Device B also pushed the merged snapshots back so Device A receives snap_local_b
    useDevice(deviceALocal)
    await reconcileSync()
    expect((await loadSnapshots()).map(s => s.id)).toEqual(['snap_remote_a', 'snap_local_b'])
  })

  it('preserves real edit revision instead of bumping to Date.now() so an older offline edit cannot beat a newer remote edit', async () => {
    const t1 = 1_760_000_001_000
    const t2 = 1_760_000_002_000
    const t3 = 1_760_000_003_000

    // Seed cloud with older T1 state
    useDevice(deviceALocal)
    await saveSettings({ theme: 'paper' })
    deviceALocal.vberry_sync_meta.settingsUpdatedAt = t1
    await reconcileSync()
    expect(cloudSyncStore[SYNC_CFG_META_KEY].rev).toBe(t1)

    // Device B pulls T1, then makes an offline edit at T2
    useDevice(deviceBLocal)
    await reconcileSync()
    await saveSettings({ theme: 'espresso' })
    deviceBLocal.vberry_sync_meta.settingsUpdatedAt = t2

    // Device B pushes T2 before learning about Device A's T3 edit: revision must stay T2 (not Date.now())
    await reconcileSync()
    expect(cloudSyncStore[SYNC_CFG_META_KEY].rev).toBe(t2)

    // Device A's newer T3 edit arrives after decryption and cleanly wins over T2
    useDevice(deviceALocal)
    await saveSettings({ theme: 'tokyo' })
    deviceALocal.vberry_sync_meta.settingsUpdatedAt = t3
    await reconcileSync()
    expect(cloudSyncStore[SYNC_CFG_META_KEY].rev).toBe(t3)

    useDevice(deviceBLocal)
    await reconcileSync()
    expect((await loadSettings()).theme).toBe('tokyo')
  })
})
