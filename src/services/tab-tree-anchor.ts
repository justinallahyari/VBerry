import type * as T from 'src/types'
import type {
  TabCompositeFingerprint,
  TabTreeAnchorRecord,
} from 'src/contracts/sidebery-schema'

const NOID: ID = -1

const DB_NAME = 'sidebery_tab_cache'
const DB_VERSION = 1
const STORE_TABS_BY_ID = 'tabs_by_id'
const STORE_TABS_BY_FP = 'tabs_by_fingerprint'
const STORE_WINDOW_VALUES = 'window_values'
const STORE_META = 'meta'

const SESSION_KEY_TABS = 'sidebery_session_tabs'
const SESSION_KEY_WINDOWS = 'sidebery_session_windows'
const SESSION_KEY_FINGERPRINTS = 'sidebery_fingerprints'
const SESSION_KEY_CONTAINERS = 'sidebery_tab_containers'
const SESSION_KEY_ORIG_URLS = 'sidebery_tab_orig_urls'

const LOCAL_KEY_ANCHORS = 'tabTreeAnchors'
const LOCAL_KEY_IDB_FALLBACK = 'sidebery_idb_fallback'
const MAX_CACHE_ENTRIES = 5000

const EPHEMERAL_IPPC_SUFFIX_RE =
  /~!(?:[^~]*!(?:ch|b)|[A-Za-z0-9+/_-]+={0,3}\.\d{1,8}\.(?:\w|-){12}!\w!\w)!~$/
const GROUP_EXT_URL_RE =
  /^(?:moz|chrome)-extension:\/\/[^/]+\/(?:sidebery\/group|page\.group(?:\/group)?|group)\.html(.*)$/i
const PLACEHOLDER_EXT_URL_RE =
  /^(?:moz|chrome)-extension:\/\/[^/]+\/(?:sidebery\/url|page\.url(?:\/url)?|url)\.html(.*)$/i
const SETUP_EXT_URL_RE =
  /^(?:moz|chrome)-extension:\/\/[^/]+\/(?:page\.setup(?:\/setup)?)\.html(.*)$/i

interface StorageAreaLike {
  get(key: string): Promise<Record<string, any>>
  set(items: Record<string, any>): Promise<void>
}

interface IDBFallbackState {
  tabs_by_id: Record<string, TabTreeAnchorRecord>
  tabs_by_fingerprint: Record<string, TabTreeAnchorRecord>
  window_values: Record<string, Record<string, any>>
  meta: Record<string, any>
}

interface MirrorLocalState {
  byId: Record<string, TabTreeAnchorRecord>
  byFingerprint: Record<string, TabTreeAnchorRecord>
  tabValues: Record<string, Record<string, any>>
  windowValues: Record<string, Record<string, any>>
  containers: Record<string, string>
  originalUrls: Record<string, string>
  updatedAt: number
}

// Layer 1 (hot) in-memory state
let tabValues = new Map<string, Record<string, any>>()
let windowValues = new Map<string, Record<string, any>>()
let fingerprintMap = new Map<string, TabTreeAnchorRecord>()
let anchorsByTabId = new Map<string, TabTreeAnchorRecord>()
let containerByTabId = new Map<string, string>()
let originalUrlByTabId = new Map<string, string>()

let initialized = false
let initPromise: Promise<void> | null = null
let dbPromise: Promise<IDBDatabase | null> | null = null
let persistQueue: Promise<void> = Promise.resolve()

// Fallback storage maps used only when neither chrome.storage nor browser.storage exists (e.g. bare Node tests).
// Kept outside Layer 1 cache so clearInMemoryCacheForTest() simulates SW restart cleanly.
const fallbackSessionStore = new Map<string, any>()
const fallbackLocalStore = new Map<string, any>()

function getSessionStorageArea(): StorageAreaLike | undefined {
  const g = globalThis as any
  return g.chrome?.storage?.session ?? g.browser?.storage?.session
}

function getLocalStorageArea(): StorageAreaLike | undefined {
  const g = globalThis as any
  return g.chrome?.storage?.local ?? g.browser?.storage?.local
}

function getIDBFactory(): IDBFactory | undefined {
  return (globalThis as any).indexedDB
}

async function storageGet(area: StorageAreaLike | undefined, fallback: Map<string, any>, key: string): Promise<any> {
  if (!area) return fallback.get(key)
  try {
    const res = await area.get(key)
    return res?.[key]
  } catch {
    return fallback.get(key)
  }
}

async function storageSet(
  area: StorageAreaLike | undefined,
  fallback: Map<string, any>,
  items: Record<string, any>
): Promise<void> {
  if (!area) {
    for (const [k, v] of Object.entries(items)) {
      fallback.set(k, v)
    }
    return
  }
  try {
    await area.set(items)
  } catch {
    for (const [k, v] of Object.entries(items)) {
      fallback.set(k, v)
    }
  }
}

function toPlainData<TVal>(val: TVal): TVal {
  if (val === undefined || val === null || typeof val !== 'object') return val
  if (Array.isArray(val)) {
    let isFlat = true
    for (let i = 0; i < val.length; i++) {
      const item = val[i]
      if (item !== null && (typeof item === 'object' || typeof item === 'function')) {
        isFlat = false
        break
      }
    }
    if (isFlat) return val.slice() as unknown as TVal
  } else {
    const proto = Object.getPrototypeOf(val)
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, any> = {}
      let isFlat = true
      for (const [k, v] of Object.entries(val as Record<string, any>)) {
        if (v === undefined || typeof v === 'function') continue
        if (v !== null && typeof v === 'object') {
          isFlat = false
          break
        }
        out[k] = v
      }
      if (isFlat) return out as TVal
    }
  }
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(val)
    } catch {
      // Fallback for proxies or non-cloneable values
    }
  }
  if (Array.isArray(val)) return val.map(v => toPlainData(v)) as unknown as TVal
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(val as Record<string, any>)) {
    if (typeof v !== 'function' && v !== undefined) out[k] = toPlainData(v)
  }
  return out as TVal
}

function mapToRecord<V>(map: Map<string, V>): Record<string, V> {
  const rec: Record<string, V> = {}
  for (const [k, v] of map.entries()) {
    rec[k] = v
  }
  return rec
}

interface IDBBatchOp {
  store: string
  type: 'put' | 'delete'
  value?: any
  key?: IDBValidKey
}

function pruneBoundedCaches(): IDBBatchOp[] {
  const ops: IDBBatchOp[] = []
  if (anchorsByTabId.size > MAX_CACHE_ENTRIES) {
    const entries = Array.from(anchorsByTabId.entries()).sort(
      (a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0)
    )
    const evictCount = anchorsByTabId.size - MAX_CACHE_ENTRIES
    for (let i = 0; i < evictCount; i++) {
      const [idKey, rec] = entries[i]
      anchorsByTabId.delete(idKey)
      tabValues.delete(idKey)
      containerByTabId.delete(idKey)
      originalUrlByTabId.delete(idKey)
      ops.push({ store: STORE_TABS_BY_ID, type: 'delete', key: rec.id as IDBValidKey })
      if (rec.fingerprint) {
        const fpOwner = fingerprintMap.get(rec.fingerprint)
        if (!fpOwner || String(fpOwner.id) === idKey) {
          fingerprintMap.delete(rec.fingerprint)
          ops.push({ store: STORE_TABS_BY_FP, type: 'delete', key: rec.fingerprint })
        }
      }
    }
  }
  if (fingerprintMap.size > MAX_CACHE_ENTRIES) {
    const fpEntries = Array.from(fingerprintMap.entries()).sort(
      (a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0)
    )
    const evictCount = fingerprintMap.size - MAX_CACHE_ENTRIES
    for (let i = 0; i < evictCount; i++) {
      const [fp] = fpEntries[i]
      fingerprintMap.delete(fp)
      ops.push({ store: STORE_TABS_BY_FP, type: 'delete', key: fp })
    }
  }
  return ops
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  const idb = getIDBFactory()
  if (!idb || typeof idb.open !== 'function') {
    return Promise.resolve(null)
  }

  dbPromise = new Promise<IDBDatabase | null>(resolve => {
    try {
      const req = idb.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_TABS_BY_ID)) {
          db.createObjectStore(STORE_TABS_BY_ID, { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains(STORE_TABS_BY_FP)) {
          db.createObjectStore(STORE_TABS_BY_FP, { keyPath: 'fingerprint' })
        }
        if (!db.objectStoreNames.contains(STORE_WINDOW_VALUES)) {
          db.createObjectStore(STORE_WINDOW_VALUES, { keyPath: 'windowId' })
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' })
        }
      }
      req.onsuccess = () => {
        const db = req.result
        db.onversionchange = () => {
          db.close()
          dbPromise = null
        }
        resolve(db)
      }
      req.onerror = () => {
        dbPromise = null
        resolve(null)
      }
      req.onblocked = () => {
        dbPromise = null
        resolve(null)
      }
    } catch {
      dbPromise = null
      resolve(null)
    }
  })

  return dbPromise
}

function idbGetAll<TOut>(db: IDBDatabase, storeName: string): Promise<TOut[]> {
  return new Promise(resolve => {
    try {
      const tx = db.transaction(storeName, 'readonly')
      const store = tx.objectStore(storeName)
      const req = store.getAll()
      req.onsuccess = () => resolve((req.result as TOut[]) ?? [])
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

async function idbRunBatch(ops: IDBBatchOp[]): Promise<boolean> {
  if (!ops.length) return true
  const db = await openDatabase()
  if (!db) return false

  const storeNames = Array.from(new Set(ops.map(op => op.store)))
  return new Promise<boolean>(resolve => {
    try {
      const tx = db.transaction(storeNames.length === 1 ? storeNames[0] : storeNames, 'readwrite')
      const stores = new Map<string, IDBObjectStore>()
      for (const name of storeNames) {
        stores.set(name, tx.objectStore(name))
      }
      for (const op of ops) {
        const store = stores.get(op.store)!
        if (op.type === 'put') {
          store.put(toPlainData(op.value))
        } else if (op.type === 'delete' && op.key !== undefined) {
          store.delete(op.key)
        }
      }
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

async function idbPutRecord(storeName: string, record: Record<string, any>): Promise<boolean> {
  return idbRunBatch([{ store: storeName, type: 'put', value: record }])
}

async function idbDeleteKey(storeName: string, key: IDBValidKey): Promise<boolean> {
  return idbRunBatch([{ store: storeName, type: 'delete', key }])
}

function buildIDBFallbackSnapshot(): IDBFallbackState {
  return {
    tabs_by_id: mapToRecord(anchorsByTabId),
    tabs_by_fingerprint: mapToRecord(fingerprintMap),
    window_values: mapToRecord(windowValues),
    meta: {
      tab_values: mapToRecord(tabValues),
      containers: mapToRecord(containerByTabId),
      original_urls: mapToRecord(originalUrlByTabId),
      schema_version: DB_VERSION,
    },
  }
}

function buildMirrorSnapshot(): MirrorLocalState {
  return {
    byId: mapToRecord(anchorsByTabId),
    byFingerprint: mapToRecord(fingerprintMap),
    tabValues: mapToRecord(tabValues),
    windowValues: mapToRecord(windowValues),
    containers: mapToRecord(containerByTabId),
    originalUrls: mapToRecord(originalUrlByTabId),
    updatedAt: Date.now(),
  }
}

function enqueuePersist(task: () => Promise<void>): Promise<void> {
  const next = persistQueue.then(task, task)
  persistQueue = next.catch(() => {})
  return next
}

async function syncSessionLayer(keys?: {
  tabs?: boolean
  windows?: boolean
  fingerprints?: boolean
  containers?: boolean
  originalUrls?: boolean
}): Promise<void> {
  const sessionArea = getSessionStorageArea()
  const payload: Record<string, any> = {}
  const all = !keys

  if (all || keys.tabs) payload[SESSION_KEY_TABS] = mapToRecord(tabValues)
  if (all || keys.windows) payload[SESSION_KEY_WINDOWS] = mapToRecord(windowValues)
  if (all || keys.fingerprints) payload[SESSION_KEY_FINGERPRINTS] = mapToRecord(fingerprintMap)
  if (all || keys.containers) payload[SESSION_KEY_CONTAINERS] = mapToRecord(containerByTabId)
  if (all || keys.originalUrls) payload[SESSION_KEY_ORIG_URLS] = mapToRecord(originalUrlByTabId)

  if (Object.keys(payload).length) {
    await storageSet(sessionArea, fallbackSessionStore, payload)
  }
}

async function syncDurableMirror(writeIDBFallback: boolean): Promise<void> {
  const localArea = getLocalStorageArea()
  const payload: Record<string, any> = {
    [LOCAL_KEY_ANCHORS]: buildMirrorSnapshot(),
  }
  if (writeIDBFallback) {
    payload[LOCAL_KEY_IDB_FALLBACK] = buildIDBFallbackSnapshot()
  }
  await storageSet(localArea, fallbackLocalStore, payload)
}

function recordToSessionData(rec: TabTreeAnchorRecord): T.TabSessionData {
  const sd: T.TabSessionData = {
    id: rec.id,
    panelId: rec.panelId,
    parentId: rec.parentId,
    folded: !!rec.folded,
  }
  if (rec.lvl !== undefined) sd.lvl = rec.lvl
  if (rec.customTitle !== undefined) sd.customTitle = rec.customTitle
  if (rec.customColor !== undefined) sd.customColor = rec.customColor
  if (rec.containerId !== undefined) sd.containerId = rec.containerId
  if (rec.originalUrl !== undefined) sd.originalUrl = rec.originalUrl
  if (rec.chromeUrl !== undefined) sd.chromeUrl = rec.chromeUrl
  return sd
}

function mergeAnchorRecord(rec: TabTreeAnchorRecord | undefined, preferNewer = true): void {
  if (!rec || rec.id === undefined) return
  const idKey = String(rec.id)
  const existing = anchorsByTabId.get(idKey)
  if (existing && preferNewer && (existing.updatedAt ?? 0) > (rec.updatedAt ?? 0)) {
    return
  }

  const normalizedRec = toPlainData(rec)
  anchorsByTabId.set(idKey, normalizedRec)

  if (normalizedRec.fingerprint) {
    const existingFp = fingerprintMap.get(normalizedRec.fingerprint)
    if (!existingFp || !preferNewer || (existingFp.updatedAt ?? 0) <= (normalizedRec.updatedAt ?? 0)) {
      fingerprintMap.set(normalizedRec.fingerprint, normalizedRec)
    }
  }

  if (normalizedRec.containerId && !containerByTabId.has(idKey)) {
    containerByTabId.set(idKey, normalizedRec.containerId)
  }
  if (normalizedRec.originalUrl && !originalUrlByTabId.has(idKey)) {
    originalUrlByTabId.set(idKey, normalizedRec.originalUrl)
  }

  const existingTabVals = tabValues.get(idKey)
  if (!existingTabVals?.data) {
    tabValues.set(idKey, {
      ...(existingTabVals ?? {}),
      data: recordToSessionData(normalizedRec),
    })
  }
}

/**
 * Hydrate hot in-memory caches from chrome.storage.session first, then IndexedDB / chrome.storage.local.
 */
export async function init(): Promise<void> {
  if (initialized) return
  if (initPromise) return initPromise

  initPromise = (async () => {
    const sessionArea = getSessionStorageArea()
    const localArea = getLocalStorageArea()

    // 1. Hydrate from chrome.storage.session (fast Layer 1)
    const [sessTabs, sessWins, sessFps, sessContainers, sessOrigUrls] = await Promise.all([
      storageGet(sessionArea, fallbackSessionStore, SESSION_KEY_TABS),
      storageGet(sessionArea, fallbackSessionStore, SESSION_KEY_WINDOWS),
      storageGet(sessionArea, fallbackSessionStore, SESSION_KEY_FINGERPRINTS),
      storageGet(sessionArea, fallbackSessionStore, SESSION_KEY_CONTAINERS),
      storageGet(sessionArea, fallbackSessionStore, SESSION_KEY_ORIG_URLS),
    ])

    if (sessTabs && typeof sessTabs === 'object') {
      for (const [k, v] of Object.entries(sessTabs)) {
        if (v && typeof v === 'object') tabValues.set(k, toPlainData(v))
      }
    }
    if (sessWins && typeof sessWins === 'object') {
      for (const [k, v] of Object.entries(sessWins)) {
        if (v && typeof v === 'object') windowValues.set(k, toPlainData(v))
      }
    }
    if (sessContainers && typeof sessContainers === 'object') {
      for (const [k, v] of Object.entries(sessContainers)) {
        if (typeof v === 'string') containerByTabId.set(k, v)
      }
    }
    if (sessOrigUrls && typeof sessOrigUrls === 'object') {
      for (const [k, v] of Object.entries(sessOrigUrls)) {
        if (typeof v === 'string') originalUrlByTabId.set(k, v)
      }
    }
    if (sessFps && typeof sessFps === 'object') {
      for (const [fp, rec] of Object.entries(sessFps)) {
        if (rec && typeof rec === 'object') {
          const cloned = toPlainData(rec as TabTreeAnchorRecord)
          fingerprintMap.set(fp, cloned)
          if (cloned.id !== undefined) {
            mergeAnchorRecord(cloned, true)
          }
        }
      }
    }

    // 2. Hydrate from IndexedDB (durable Layer 2), falling back to chrome.storage.local
    const db = await openDatabase()
    if (db) {
      const [idRecords, fpRecords, winRecords, metaRecords] = await Promise.all([
        idbGetAll<TabTreeAnchorRecord>(db, STORE_TABS_BY_ID),
        idbGetAll<TabTreeAnchorRecord>(db, STORE_TABS_BY_FP),
        idbGetAll<{ windowId: string; values: Record<string, any> }>(db, STORE_WINDOW_VALUES),
        idbGetAll<{ key: string; data: any }>(db, STORE_META),
      ])

      for (const meta of metaRecords) {
        if (!meta?.data || typeof meta.data !== 'object') continue
        if (meta.key === 'tab_values') {
          for (const [k, v] of Object.entries(meta.data)) {
            if (!tabValues.has(k) && v && typeof v === 'object') {
              tabValues.set(k, toPlainData(v as Record<string, any>))
            } else if (tabValues.has(k) && v && typeof v === 'object') {
              tabValues.set(k, { ...toPlainData(v as Record<string, any>), ...tabValues.get(k) })
            }
          }
        } else if (meta.key === 'containers') {
          for (const [k, v] of Object.entries(meta.data)) {
            if (!containerByTabId.has(k) && typeof v === 'string') containerByTabId.set(k, v)
          }
        } else if (meta.key === 'original_urls') {
          for (const [k, v] of Object.entries(meta.data)) {
            if (!originalUrlByTabId.has(k) && typeof v === 'string') originalUrlByTabId.set(k, v)
          }
        }
      }

      for (const winRec of winRecords) {
        if (!winRec?.windowId || !winRec.values) continue
        const existingWin = windowValues.get(String(winRec.windowId))
        windowValues.set(String(winRec.windowId), {
          ...toPlainData(winRec.values),
          ...(existingWin ?? {}),
        })
      }

      for (const rec of idRecords) {
        mergeAnchorRecord(rec, true)
      }
      for (const rec of fpRecords) {
        if (rec?.fingerprint && !fingerprintMap.has(rec.fingerprint)) {
          fingerprintMap.set(rec.fingerprint, toPlainData(rec))
        }
        mergeAnchorRecord(rec, true)
      }
    } else {
      const idbFallback = (await storageGet(
        localArea,
        fallbackLocalStore,
        LOCAL_KEY_IDB_FALLBACK
      )) as IDBFallbackState | undefined

      if (idbFallback && typeof idbFallback === 'object') {
        if (idbFallback.meta?.tab_values) {
          for (const [k, v] of Object.entries(idbFallback.meta.tab_values)) {
            if (v && typeof v === 'object') {
              tabValues.set(k, { ...toPlainData(v), ...(tabValues.get(k) ?? {}) })
            }
          }
        }
        if (idbFallback.meta?.containers) {
          for (const [k, v] of Object.entries(idbFallback.meta.containers)) {
            if (!containerByTabId.has(k) && typeof v === 'string') containerByTabId.set(k, v)
          }
        }
        if (idbFallback.meta?.original_urls) {
          for (const [k, v] of Object.entries(idbFallback.meta.original_urls)) {
            if (!originalUrlByTabId.has(k) && typeof v === 'string') originalUrlByTabId.set(k, v)
          }
        }
        if (idbFallback.window_values) {
          for (const [k, v] of Object.entries(idbFallback.window_values)) {
            if (v && typeof v === 'object') {
              windowValues.set(k, { ...toPlainData(v), ...(windowValues.get(k) ?? {}) })
            }
          }
        }
        if (idbFallback.tabs_by_id) {
          for (const rec of Object.values(idbFallback.tabs_by_id)) {
            mergeAnchorRecord(rec, true)
          }
        }
        if (idbFallback.tabs_by_fingerprint) {
          for (const [fp, rec] of Object.entries(idbFallback.tabs_by_fingerprint)) {
            if (rec && !fingerprintMap.has(fp)) {
              fingerprintMap.set(fp, toPlainData(rec))
            }
            mergeAnchorRecord(rec, true)
          }
        }
      }
    }

    // 3. Also hydrate from chrome.storage.local mirror ('tabTreeAnchors')
    const mirror = (await storageGet(localArea, fallbackLocalStore, LOCAL_KEY_ANCHORS)) as
      | MirrorLocalState
      | undefined

    if (mirror && typeof mirror === 'object') {
      if (mirror.tabValues) {
        for (const [k, v] of Object.entries(mirror.tabValues)) {
          if (v && typeof v === 'object') {
            tabValues.set(k, { ...toPlainData(v), ...(tabValues.get(k) ?? {}) })
          }
        }
      }
      if (mirror.windowValues) {
        for (const [k, v] of Object.entries(mirror.windowValues)) {
          if (v && typeof v === 'object') {
            windowValues.set(k, { ...toPlainData(v), ...(windowValues.get(k) ?? {}) })
          }
        }
      }
      if (mirror.containers) {
        for (const [k, v] of Object.entries(mirror.containers)) {
          if (!containerByTabId.has(k) && typeof v === 'string') containerByTabId.set(k, v)
        }
      }
      if (mirror.originalUrls) {
        for (const [k, v] of Object.entries(mirror.originalUrls)) {
          if (!originalUrlByTabId.has(k) && typeof v === 'string') originalUrlByTabId.set(k, v)
        }
      }
      if (mirror.byId) {
        for (const rec of Object.values(mirror.byId)) {
          mergeAnchorRecord(rec, true)
        }
      }
      if (mirror.byFingerprint) {
        for (const [fp, rec] of Object.entries(mirror.byFingerprint)) {
          if (rec && !fingerprintMap.has(fp)) {
            fingerprintMap.set(fp, toPlainData(rec))
          }
          mergeAnchorRecord(rec, true)
        }
      }
    }

    pruneBoundedCaches()
    initialized = true
  })()

  try {
    await initPromise
  } finally {
    initPromise = null
  }
}

/**
 * Clears ONLY in-memory Layer 1 state (leaving chrome.storage.session, IndexedDB, and
 * chrome.storage.local intact) to simulate an MV3 Service Worker restart in tests.
 */
export function clearInMemoryCacheForTest(): void {
  tabValues = new Map()
  windowValues = new Map()
  fingerprintMap = new Map()
  anchorsByTabId = new Map()
  containerByTabId = new Map()
  originalUrlByTabId = new Map()
  initialized = false
  initPromise = null
  dbPromise = null
}

/**
 * Strips ephemeral Sidebery IPPC hash suffixes (`~!...!ch!~` and `~!...!b!~`) and normalizes
 * extension group/placeholder URLs across `moz-extension://` and `chrome-extension://` origins.
 */
export function normalizeUrlForFingerprint(url: string): string {
  if (!url) return ''

  let clean = url
  while (EPHEMERAL_IPPC_SUFFIX_RE.test(clean)) {
    clean = clean.replace(EPHEMERAL_IPPC_SUFFIX_RE, '')
  }

  const groupMatch = GROUP_EXT_URL_RE.exec(clean)
  if (groupMatch) {
    return `sidebery://group.html${groupMatch[1] ?? ''}`
  }

  const placeholderMatch = PLACEHOLDER_EXT_URL_RE.exec(clean)
  if (placeholderMatch) {
    return `sidebery://url.html${placeholderMatch[1] ?? ''}`
  }

  const setupMatch = SETUP_EXT_URL_RE.exec(clean)
  if (setupMatch) {
    return `sidebery://setup.html${setupMatch[1] ?? ''}`
  }

  return clean
}

/**
 * Computes a deterministic composite fingerprint string for tab matching.
 */
export function computeFingerprint(info: TabCompositeFingerprint): string {
  return JSON.stringify([
    String(info.windowId),
    info.index,
    info.normalizedUrl,
    info.title ?? '',
    info.openerTabId !== undefined ? String(info.openerTabId) : '',
  ])
}

async function persistRecordToLayer2(
  record: TabTreeAnchorRecord,
  extraOps?: IDBBatchOp[]
): Promise<void> {
  const ops: IDBBatchOp[] = [{ store: STORE_TABS_BY_ID, type: 'put', value: record }]
  if (record.fingerprint) {
    ops.push({ store: STORE_TABS_BY_FP, type: 'put', value: record })
  }
  if (extraOps?.length) {
    ops.push(...extraOps)
  }
  const ok = await idbRunBatch(ops)
  await syncDurableMirror(!ok)
}

async function persistMetaToLayer2(metaKey: string, data: any): Promise<void> {
  const wrote = await idbPutRecord(STORE_META, { key: metaKey, data })
  await syncDurableMirror(!wrote)
}

export async function setTabValue(tabId: ID, key: string, value: any): Promise<void> {
  await init()

  const idKey = String(tabId)
  const existingMap = tabValues.get(idKey) ?? {}
  const plainValue = toPlainData(value)
  tabValues.set(idKey, { ...existingMap, [key]: plainValue })

  if (key === 'data' && plainValue && typeof plainValue === 'object') {
    const existingAnchor = anchorsByTabId.get(idKey)
    const containerId =
      plainValue.containerId ?? containerByTabId.get(idKey) ?? existingAnchor?.containerId
    const originalUrl =
      plainValue.originalUrl ?? originalUrlByTabId.get(idKey) ?? existingAnchor?.originalUrl
    const chromeUrl = plainValue.chromeUrl ?? existingAnchor?.chromeUrl

    if (containerId) containerByTabId.set(idKey, containerId)
    if (originalUrl) originalUrlByTabId.set(idKey, originalUrl)

    const rawUrl = chromeUrl ?? originalUrl ?? ''
    const normalizedUrl = existingAnchor?.normalizedUrl ?? normalizeUrlForFingerprint(rawUrl)
    const windowId = existingAnchor?.windowId ?? NOID
    const index = existingAnchor?.index ?? 0
    const title = existingAnchor?.title ?? ''
    const openerTabId = existingAnchor?.openerTabId
    const fingerprint =
      existingAnchor?.fingerprint ||
      computeFingerprint({ windowId, index, normalizedUrl, title, openerTabId })

    const updatedAnchor: TabTreeAnchorRecord = {
      id: tabId,
      panelId: plainValue.panelId ?? existingAnchor?.panelId ?? NOID,
      parentId: plainValue.parentId ?? existingAnchor?.parentId ?? NOID,
      folded: !!(plainValue.folded ?? existingAnchor?.folded),
      lvl: plainValue.lvl ?? existingAnchor?.lvl ?? 0,
      customTitle: plainValue.customTitle,
      customColor: plainValue.customColor,
      containerId,
      originalUrl,
      chromeUrl,
      fingerprint,
      windowId,
      index,
      normalizedUrl,
      title,
      openerTabId,
      pinned: existingAnchor?.pinned,
      updatedAt: Date.now(),
    }

    anchorsByTabId.set(idKey, updatedAnchor)
    fingerprintMap.set(fingerprint, updatedAnchor)
    const pruneOps = pruneBoundedCaches()

    await enqueuePersist(async () => {
      await syncSessionLayer({
        tabs: true,
        fingerprints: true,
        containers: Boolean(containerId),
        originalUrls: Boolean(originalUrl),
      })
      await persistRecordToLayer2(updatedAnchor, [
        ...pruneOps,
        { store: STORE_META, type: 'put', value: { key: 'tab_values', data: mapToRecord(tabValues) } },
      ])
    })
    return
  }

  await enqueuePersist(async () => {
    await syncSessionLayer({ tabs: true })
    await persistMetaToLayer2('tab_values', mapToRecord(tabValues))
  })
}

export async function getTabValue<TVal = any>(tabId: ID, key: string): Promise<TVal | undefined> {
  await init()

  const idKey = String(tabId)
  const stored = tabValues.get(idKey)?.[key]
  if (stored !== undefined) return toPlainData(stored) as TVal

  if (key === 'data') {
    const rec = anchorsByTabId.get(idKey)
    if (rec) return recordToSessionData(rec) as unknown as TVal
  }

  return undefined
}

export async function setWindowValue(windowId: ID, key: string, value: any): Promise<void> {
  await init()

  const winKey = String(windowId)
  const existing = windowValues.get(winKey) ?? {}
  const updated = { ...existing, [key]: toPlainData(value) }
  windowValues.set(winKey, updated)

  await enqueuePersist(async () => {
    await syncSessionLayer({ windows: true })
    const wrote = await idbPutRecord(STORE_WINDOW_VALUES, {
      windowId: winKey,
      values: updated,
      updatedAt: Date.now(),
    })
    await syncDurableMirror(!wrote)
  })
}

export async function getWindowValue<TVal = any>(
  windowId: ID,
  key: string
): Promise<TVal | undefined> {
  await init()

  const val = windowValues.get(String(windowId))?.[key]
  return val !== undefined ? (toPlainData(val) as TVal) : undefined
}

export function getTabContainerId(tabId: ID): string | undefined {
  const idKey = String(tabId)
  return containerByTabId.get(idKey) ?? anchorsByTabId.get(idKey)?.containerId
}

export function getTabTitle(tabId: ID): string | undefined {
  const rec = anchorsByTabId.get(String(tabId))
  return rec?.title || undefined
}

export async function setTabContainerId(tabId: ID, containerId: string): Promise<void> {
  await init()

  const idKey = String(tabId)
  containerByTabId.set(idKey, containerId)

  const existingAnchor = anchorsByTabId.get(idKey)
  let updatedAnchor: TabTreeAnchorRecord | undefined
  if (existingAnchor) {
    updatedAnchor = { ...existingAnchor, containerId, updatedAt: Date.now() }
    anchorsByTabId.set(idKey, updatedAnchor)
    if (updatedAnchor.fingerprint) {
      fingerprintMap.set(updatedAnchor.fingerprint, updatedAnchor)
    }
  }

  const existingTabData = tabValues.get(idKey)
  if (existingTabData?.data && typeof existingTabData.data === 'object') {
    tabValues.set(idKey, {
      ...existingTabData,
      data: { ...existingTabData.data, containerId },
    })
  }

  await enqueuePersist(async () => {
    await syncSessionLayer({
      containers: true,
      tabs: Boolean(existingTabData?.data),
      fingerprints: Boolean(updatedAnchor?.fingerprint),
    })
    const ops: IDBBatchOp[] = [
      {
        store: STORE_META,
        type: 'put',
        value: { key: 'containers', data: mapToRecord(containerByTabId) },
      },
    ]
    if (updatedAnchor) {
      ops.push({ store: STORE_TABS_BY_ID, type: 'put', value: updatedAnchor })
      if (updatedAnchor.fingerprint) {
        ops.push({ store: STORE_TABS_BY_FP, type: 'put', value: updatedAnchor })
      }
    }
    const ok = await idbRunBatch(ops)
    await syncDurableMirror(!ok)
  })
}

export function getTabOriginalUrl(tabId: ID): string | undefined {
  const idKey = String(tabId)
  return originalUrlByTabId.get(idKey) ?? anchorsByTabId.get(idKey)?.originalUrl
}

export async function setTabOriginalUrl(tabId: ID, originalUrl: string): Promise<void> {
  await init()

  const idKey = String(tabId)
  originalUrlByTabId.set(idKey, originalUrl)

  const existingAnchor = anchorsByTabId.get(idKey)
  let updatedAnchor: TabTreeAnchorRecord | undefined
  if (existingAnchor) {
    updatedAnchor = { ...existingAnchor, originalUrl, updatedAt: Date.now() }
    anchorsByTabId.set(idKey, updatedAnchor)
    if (updatedAnchor.fingerprint) {
      fingerprintMap.set(updatedAnchor.fingerprint, updatedAnchor)
    }
  }

  const existingTabData = tabValues.get(idKey)
  if (existingTabData?.data && typeof existingTabData.data === 'object') {
    tabValues.set(idKey, {
      ...existingTabData,
      data: { ...existingTabData.data, originalUrl },
    })
  }

  await enqueuePersist(async () => {
    await syncSessionLayer({
      originalUrls: true,
      tabs: Boolean(existingTabData?.data),
      fingerprints: Boolean(updatedAnchor?.fingerprint),
    })
    const ops: IDBBatchOp[] = [
      {
        store: STORE_META,
        type: 'put',
        value: { key: 'original_urls', data: mapToRecord(originalUrlByTabId) },
      },
    ]
    if (updatedAnchor) {
      ops.push({ store: STORE_TABS_BY_ID, type: 'put', value: updatedAnchor })
      if (updatedAnchor.fingerprint) {
        ops.push({ store: STORE_TABS_BY_FP, type: 'put', value: updatedAnchor })
      }
    }
    const ok = await idbRunBatch(ops)
    await syncDurableMirror(!ok)
  })
}

export async function removeTabAnchor(tabId: ID): Promise<void> {
  await init()

  const idKey = String(tabId)
  const existingAnchor = anchorsByTabId.get(idKey)

  tabValues.delete(idKey)
  containerByTabId.delete(idKey)
  originalUrlByTabId.delete(idKey)
  anchorsByTabId.delete(idKey)

  let deletedFp: string | undefined
  if (existingAnchor?.fingerprint) {
    const fpOwner = fingerprintMap.get(existingAnchor.fingerprint)
    if (!fpOwner || String(fpOwner.id) === idKey) {
      fingerprintMap.delete(existingAnchor.fingerprint)
      deletedFp = existingAnchor.fingerprint
    }
  }

  await enqueuePersist(async () => {
    await syncSessionLayer({
      tabs: true,
      fingerprints: Boolean(deletedFp),
      containers: true,
      originalUrls: true,
    })

    const ops: IDBBatchOp[] = [
      { store: STORE_TABS_BY_ID, type: 'delete', key: tabId as IDBValidKey },
      { store: STORE_META, type: 'put', value: { key: 'tab_values', data: mapToRecord(tabValues) } },
      { store: STORE_META, type: 'put', value: { key: 'containers', data: mapToRecord(containerByTabId) } },
      { store: STORE_META, type: 'put', value: { key: 'original_urls', data: mapToRecord(originalUrlByTabId) } },
    ]
    if (deletedFp) {
      ops.push({ store: STORE_TABS_BY_FP, type: 'delete', key: deletedFp })
    }

    const ok = await idbRunBatch(ops)
    await syncDurableMirror(!ok)
  })
}

export async function anchorTabState(
  tab: Partial<T.Tab> & {
    id: ID
    url?: string
    windowId?: ID
    index?: number
    title?: string
    openerTabId?: ID
    pinned?: boolean
  },
  extra?: { containerId?: string; originalUrl?: string; chromeUrl?: string }
): Promise<void> {
  await init()

  const idKey = String(tab.id)
  const existing = anchorsByTabId.get(idKey)
  const existingSession = tabValues.get(idKey)?.data as T.TabSessionData | undefined

  const rawCookieStore = tab.cookieStoreId
  const nonDefaultCookieStore =
    rawCookieStore && rawCookieStore !== 'firefox-default' && rawCookieStore !== 'firefox-private'
      ? rawCookieStore
      : undefined

  const containerId =
    extra?.containerId ??
    tab.reopenInContainer ??
    nonDefaultCookieStore ??
    containerByTabId.get(idKey) ??
    existing?.containerId ??
    existingSession?.containerId

  const originalUrl =
    extra?.originalUrl ??
    originalUrlByTabId.get(idKey) ??
    existing?.originalUrl ??
    existingSession?.originalUrl

  const chromeUrl =
    extra?.chromeUrl ?? tab.url ?? existing?.chromeUrl ?? existingSession?.chromeUrl

  const rawUrl = chromeUrl ?? tab.url ?? originalUrl ?? ''
  const normalizedUrl = normalizeUrlForFingerprint(rawUrl)
  const windowId = tab.windowId ?? existing?.windowId ?? NOID
  const index = tab.index ?? existing?.index ?? 0
  const title = tab.title ?? existing?.title ?? ''
  const openerTabId = tab.openerTabId ?? existing?.openerTabId
  const pinned = tab.pinned ?? existing?.pinned

  const fingerprint = computeFingerprint({
    windowId,
    index,
    normalizedUrl,
    title,
    openerTabId,
  })

  if (existing?.fingerprint && existing.fingerprint !== fingerprint) {
    const oldOwner = fingerprintMap.get(existing.fingerprint)
    if (oldOwner && String(oldOwner.id) === idKey) {
      fingerprintMap.delete(existing.fingerprint)
    }
  }

  const record: TabTreeAnchorRecord = {
    id: tab.id,
    panelId: tab.panelId ?? existing?.panelId ?? existingSession?.panelId ?? NOID,
    parentId: tab.parentId ?? existing?.parentId ?? existingSession?.parentId ?? NOID,
    folded: !!(tab.folded ?? existing?.folded ?? existingSession?.folded),
    lvl: tab.lvl ?? existing?.lvl ?? existingSession?.lvl ?? 0,
    customTitle: tab.customTitle ?? existing?.customTitle ?? existingSession?.customTitle,
    customColor: tab.customColor ?? existing?.customColor ?? existingSession?.customColor,
    containerId,
    originalUrl,
    chromeUrl,
    fingerprint,
    windowId,
    index,
    normalizedUrl,
    title,
    openerTabId,
    pinned,
    updatedAt: Date.now(),
  }

  anchorsByTabId.set(idKey, record)
  fingerprintMap.set(fingerprint, record)

  if (containerId) containerByTabId.set(idKey, containerId)
  if (originalUrl) originalUrlByTabId.set(idKey, originalUrl)

  const existingTabVals = tabValues.get(idKey) ?? {}
  tabValues.set(idKey, {
    ...existingTabVals,
    data: recordToSessionData(record),
  })
  const pruneOps = pruneBoundedCaches()

  await enqueuePersist(async () => {
    const oldFp = existing?.fingerprint && existing.fingerprint !== fingerprint ? existing.fingerprint : undefined
    await syncSessionLayer({
      tabs: true,
      fingerprints: true,
      containers: Boolean(containerId),
      originalUrls: Boolean(originalUrl),
    })
    const extraOps: IDBBatchOp[] = [
      ...pruneOps,
      { store: STORE_META, type: 'put', value: { key: 'tab_values', data: mapToRecord(tabValues) } },
    ]
    if (oldFp) {
      extraOps.unshift({ store: STORE_TABS_BY_FP, type: 'delete', key: oldFp })
    }
    await persistRecordToLayer2(record, extraOps)
  })
}

function findMatchedCacheFromWindows(
  tabs: T.NativeTab[],
  data: T.TabCache[][]
): Record<ID, T.TabCache> | undefined {
  if (!data.length || !tabs.length) return undefined

  const tabNorms: string[] = new Array(tabs.length)
  for (let i = 0; i < tabs.length; i++) {
    tabNorms[i] = tabs[i] ? normalizeUrlForFingerprint(tabs[i].url ?? '') : ''
  }

  if (tabs.length === 1) {
    const singleTab = tabs[0]
    if (!singleTab) return undefined
    const singleNorm = tabNorms[0]
    for (const winTabs of data) {
      if (winTabs.length !== 1) continue
      const tabData = winTabs[0]
      if (!tabData) continue
      if (
        (tabData.url === singleTab.url ||
          normalizeUrlForFingerprint(tabData.url) === singleNorm) &&
        !!tabData.pin === !!singleTab.pinned
      ) {
        return { [singleTab.id]: tabData }
      }
    }
    return undefined
  }

  let maxEqualityCounter = 1
  let result: Record<ID, T.TabCache> | undefined

  for (const winTabs of data) {
    let equalityCounter = 0
    const existedTabs: Record<ID, T.TabCache> = {}

    let dataIndex = 0
    let tabIndex = 0
    perTab: for (let tab, tabData; dataIndex < winTabs.length; dataIndex++, tabIndex++) {
      tab = tabs[tabIndex]
      if (!tab) break
      tabData = winTabs[dataIndex]
      if (!tabData) break

      const blindspot = tab.status === 'loading' && (tab.url === 'about:blank' || !tab.url)
      const tabNorm = tabNorms[tabIndex]
      const cacheNorm = normalizeUrlForFingerprint(tabData.url ?? '')

      if (
        ((tabData.url === tab.url || (tabNorm && tabNorm === cacheNorm)) &&
          !!tabData.pin === !!tab.pinned) ||
        blindspot
      ) {
        existedTabs[tab.id] = tabData
        equalityCounter++
      } else {
        for (let j = tabIndex + 1; j < tabIndex + 5; j++) {
          const tabj = tabs[j]
          if (
            tabj &&
            (tabj.url === tabData.url || (cacheNorm && tabNorms[j] === cacheNorm))
          ) {
            tabIndex = j
            existedTabs[tabj.id] = tabData
            equalityCounter++
            continue perTab
          }
        }
        tabIndex--
      }
    }

    const mismatchedLen = tabs.length - equalityCounter
    if (
      (tabs.length <= winTabs.length && mismatchedLen > 0) ||
      (tabs.length > winTabs.length && mismatchedLen > tabs.length - winTabs.length)
    ) {
      continue
    }

    if (maxEqualityCounter <= equalityCounter) {
      maxEqualityCounter = equalityCounter
      result = existedTabs
    }

    if (equalityCounter === tabs.length) break
  }

  return result
}

function isUrlCompatibleForDirectId(
  nativeTab: T.NativeTab,
  anchor: TabTreeAnchorRecord,
  precomputedNativeNorm?: string
): boolean {
  const nativeNorm = precomputedNativeNorm ?? normalizeUrlForFingerprint(nativeTab.url ?? '')
  const anchorNorm = anchor.normalizedUrl
  const anchorChromeNorm = anchor.chromeUrl ? normalizeUrlForFingerprint(anchor.chromeUrl) : ''
  const anchorOrigNorm = anchor.originalUrl ? normalizeUrlForFingerprint(anchor.originalUrl) : ''

  // If anchor was created via setTabValue('data') without URL metadata, trust direct ID
  if (!anchorNorm && !anchorChromeNorm && !anchorOrigNorm) return true

  // Allow loading blank tabs during restore if window matches
  if (
    nativeTab.status === 'loading' &&
    (!nativeTab.url || nativeTab.url === 'about:blank') &&
    (anchor.windowId === NOID || anchor.windowId === nativeTab.windowId)
  ) {
    return true
  }

  if (!nativeNorm) return false
  return nativeNorm === anchorNorm || nativeNorm === anchorChromeNorm || nativeNorm === anchorOrigNorm
}

/**
 * Restores and matches sidebery tab tree state for native browser tabs across SW restarts
 * and browser session restores (including oldId -> newId parent remapping and lvl recomputation).
 */
export async function restoreOrMatchTabsState(
  nativeTabs: T.NativeTab[],
  cachedWindows?: T.TabCache[][]
): Promise<{
  tabsSessionData: (T.TabSessionData | undefined)[]
  matchedCache?: Record<ID, T.TabCache>
}> {
  await init()

  if (!nativeTabs.length) {
    return { tabsSessionData: [], matchedCache: undefined }
  }

  const matchedCache = cachedWindows?.length
    ? findMatchedCacheFromWindows(nativeTabs, cachedWindows)
    : undefined

  // Precompute normalized URLs and titles for nativeTabs once
  const nativeNormUrls: string[] = new Array(nativeTabs.length)
  const nativeTitles: string[] = new Array(nativeTabs.length)
  for (let i = 0; i < nativeTabs.length; i++) {
    const t = nativeTabs[i]
    if (t) {
      nativeNormUrls[i] = normalizeUrlForFingerprint(t.url ?? '')
      nativeTitles[i] = t.title ?? ''
    } else {
      nativeNormUrls[i] = ''
      nativeTitles[i] = ''
    }
  }

  // Build deduplicated pool of anchor candidates and O(1) normalizedUrl index
  const candidatePool: TabTreeAnchorRecord[] = []
  const candidatesByNormUrl = new Map<string, TabTreeAnchorRecord[]>()
  const seenCandidates = new Set<TabTreeAnchorRecord>()
  const addCandidate = (rec: TabTreeAnchorRecord | undefined) => {
    if (!rec || seenCandidates.has(rec)) return
    seenCandidates.add(rec)
    candidatePool.push(rec)
    const urlKey = rec.normalizedUrl ?? ''
    let bucket = candidatesByNormUrl.get(urlKey)
    if (!bucket) {
      bucket = []
      candidatesByNormUrl.set(urlKey, bucket)
    }
    bucket.push(rec)
  }

  for (const rec of anchorsByTabId.values()) addCandidate(rec)
  for (const rec of fingerprintMap.values()) addCandidate(rec)

  // Also synthesize anchor candidates for any tabValues entries lacking an anchor record
  for (const [idKey, tv] of tabValues.entries()) {
    if (!anchorsByTabId.has(idKey) && tv?.data && typeof tv.data === 'object') {
      const sd = tv.data as T.TabSessionData
      const rawUrl = sd.chromeUrl ?? sd.originalUrl ?? ''
      const normalizedUrl = normalizeUrlForFingerprint(rawUrl)
      addCandidate({
        id: sd.id,
        panelId: sd.panelId ?? NOID,
        parentId: sd.parentId ?? NOID,
        folded: !!sd.folded,
        lvl: sd.lvl ?? 0,
        customTitle: sd.customTitle,
        customColor: sd.customColor,
        containerId: sd.containerId ?? containerByTabId.get(idKey),
        originalUrl: sd.originalUrl ?? originalUrlByTabId.get(idKey),
        chromeUrl: sd.chromeUrl,
        fingerprint: computeFingerprint({
          windowId: NOID,
          index: 0,
          normalizedUrl,
          title: '',
        }),
        windowId: NOID,
        index: 0,
        normalizedUrl,
        title: '',
        updatedAt: 0,
      })
    }
  }

  const usedAnchors = new Set<TabTreeAnchorRecord>()
  const matchedAnchors: (TabTreeAnchorRecord | undefined)[] = new Array(nativeTabs.length)
  const matchedFromCache: (T.TabCache | undefined)[] = new Array(nativeTabs.length)

  // Pass 1: Direct tab.id lookup with URL compatibility check
  for (let i = 0; i < nativeTabs.length; i++) {
    const nativeTab = nativeTabs[i]
    if (!nativeTab) continue
    const idKey = String(nativeTab.id)
    const direct = anchorsByTabId.get(idKey)
    if (
      direct &&
      !usedAnchors.has(direct) &&
      isUrlCompatibleForDirectId(nativeTab, direct, nativeNormUrls[i])
    ) {
      matchedAnchors[i] = direct
      usedAnchors.add(direct)
    }
  }

  // Pass 2a: Exact composite fingerprint match (windowId, index, normalizedUrl, title, openerTabId)
  for (let i = 0; i < nativeTabs.length; i++) {
    if (matchedAnchors[i]) continue
    const nativeTab = nativeTabs[i]
    if (!nativeTab) continue

    const normUrl = nativeNormUrls[i]
    const fp = computeFingerprint({
      windowId: nativeTab.windowId,
      index: nativeTab.index ?? i,
      normalizedUrl: normUrl,
      title: nativeTitles[i],
      openerTabId: nativeTab.openerTabId,
    })

    const fpMatch = fingerprintMap.get(fp)
    if (fpMatch && !usedAnchors.has(fpMatch)) {
      matchedAnchors[i] = fpMatch
      usedAnchors.add(fpMatch)
      continue
    }

    const urlBucket = candidatesByNormUrl.get(normUrl)
    const poolMatch = urlBucket?.find(c => !usedAnchors.has(c) && c.fingerprint === fp)
    if (poolMatch) {
      matchedAnchors[i] = poolMatch
      usedAnchors.add(poolMatch)
    }
  }

  // Pass 2b: Relaxed match (windowId, normalizedUrl, title) ordered by nearest index
  for (let i = 0; i < nativeTabs.length; i++) {
    if (matchedAnchors[i]) continue
    const nativeTab = nativeTabs[i]
    if (!nativeTab) continue

    const normUrl = nativeNormUrls[i]
    const urlBucket = candidatesByNormUrl.get(normUrl)
    if (!urlBucket) continue

    const title = nativeTitles[i]
    const targetIdx = nativeTab.index ?? i
    let bestMatch: TabTreeAnchorRecord | undefined
    let bestDist = Infinity

    for (let j = 0; j < urlBucket.length; j++) {
      const c = urlBucket[j]
      if (usedAnchors.has(c) || c.windowId !== nativeTab.windowId || c.title !== title) continue
      const dist = Math.abs(c.index - targetIdx)
      if (dist < bestDist) {
        bestDist = dist
        bestMatch = c
        if (dist === 0) break
      }
    }

    if (bestMatch) {
      matchedAnchors[i] = bestMatch
      usedAnchors.add(bestMatch)
    }
  }

  // Pass 2c: Relaxed match across windows (normalizedUrl, title) ordered by nearest index
  for (let i = 0; i < nativeTabs.length; i++) {
    if (matchedAnchors[i]) continue
    const nativeTab = nativeTabs[i]
    if (!nativeTab) continue

    const normUrl = nativeNormUrls[i]
    const urlBucket = candidatesByNormUrl.get(normUrl)
    if (!urlBucket) continue

    const title = nativeTitles[i]
    const targetIdx = nativeTab.index ?? i
    let bestMatch: TabTreeAnchorRecord | undefined
    let bestDist = Infinity

    for (let j = 0; j < urlBucket.length; j++) {
      const c = urlBucket[j]
      if (usedAnchors.has(c) || c.title !== title) continue
      const dist = Math.abs(c.index - targetIdx)
      if (dist < bestDist) {
        bestDist = dist
        bestMatch = c
        if (dist === 0) break
      }
    }

    if (bestMatch) {
      matchedAnchors[i] = bestMatch
      usedAnchors.add(bestMatch)
    }
  }

  // Pass 2d: URL-only fallback when title is missing/placeholder during discarded session restore
  for (let i = 0; i < nativeTabs.length; i++) {
    if (matchedAnchors[i]) continue
    const nativeTab = nativeTabs[i]
    if (!nativeTab) continue

    const normUrl = nativeNormUrls[i]
    if (!normUrl || normUrl === 'about:blank' || normUrl === 'chrome://newtab/') continue
    const urlBucket = candidatesByNormUrl.get(normUrl)
    if (!urlBucket) continue

    const title = nativeTitles[i]
    const targetIdx = nativeTab.index ?? i
    let bestMatch: TabTreeAnchorRecord | undefined
    let bestWinDiff = Infinity
    let bestDist = Infinity

    for (let j = 0; j < urlBucket.length; j++) {
      const c = urlBucket[j]
      if (usedAnchors.has(c)) continue
      if (title && c.title && title !== nativeTab.url && title !== 'New Tab') continue
      const winDiff = c.windowId === nativeTab.windowId ? 0 : 1
      const dist = Math.abs(c.index - targetIdx)
      if (winDiff < bestWinDiff || (winDiff === bestWinDiff && dist < bestDist)) {
        bestWinDiff = winDiff
        bestDist = dist
        bestMatch = c
        if (winDiff === 0 && dist === 0) break
      }
    }

    if (bestMatch) {
      matchedAnchors[i] = bestMatch
      usedAnchors.add(bestMatch)
    }
  }

  // Pass 2e: Fallback to matchedCache from cachedWindows
  if (matchedCache) {
    for (let i = 0; i < nativeTabs.length; i++) {
      if (matchedAnchors[i]) continue
      const nativeTab = nativeTabs[i]
      if (!nativeTab) continue
      const cacheEntry = matchedCache[nativeTab.id]
      if (cacheEntry) matchedFromCache[i] = cacheEntry
    }
  }

  // Pass 3: Build oldId -> newId map across all matched tabs
  const oldIdToNewId = new Map<ID, ID>()
  const nativeIdSet = new Set<ID>()
  for (let i = 0; i < nativeTabs.length; i++) {
    const nativeTab = nativeTabs[i]
    if (!nativeTab) continue
    nativeIdSet.add(nativeTab.id)
    const anchor = matchedAnchors[i]
    if (anchor && anchor.id !== undefined) {
      oldIdToNewId.set(anchor.id, nativeTab.id)
    }
    const cached = matchedFromCache[i]
    if (cached && cached.id !== undefined && !oldIdToNewId.has(cached.id)) {
      oldIdToNewId.set(cached.id, nativeTab.id)
    }
  }

  // Build initial TabSessionData with remapped parentId
  const tabsSessionData: (T.TabSessionData | undefined)[] = new Array(nativeTabs.length)
  const sessionDataByNewId = new Map<ID, T.TabSessionData>()

  for (let i = 0; i < nativeTabs.length; i++) {
    const nativeTab = nativeTabs[i]
    if (!nativeTab) {
      tabsSessionData[i] = undefined
      continue
    }

    const anchor = matchedAnchors[i]
    const cached = matchedFromCache[i]

    if (!anchor && !cached) {
      tabsSessionData[i] = undefined
      continue
    }

    const oldParentId = anchor ? anchor.parentId : cached?.parentId ?? NOID
    let remappedParentId: ID = NOID
    if (oldParentId !== undefined && oldParentId !== NOID) {
      if (oldIdToNewId.has(oldParentId)) {
        remappedParentId = oldIdToNewId.get(oldParentId)!
      } else if (nativeIdSet.has(oldParentId)) {
        remappedParentId = oldParentId
      }
    }
    if (remappedParentId === nativeTab.id) remappedParentId = NOID

    const sd: T.TabSessionData = {
      id: nativeTab.id,
      panelId: (anchor ? anchor.panelId : cached?.panelId) ?? NOID,
      parentId: remappedParentId,
      folded: !!(anchor ? anchor.folded : cached?.folded),
    }

    const customTitle = anchor?.customTitle ?? cached?.customTitle
    const customColor = anchor?.customColor ?? cached?.customColor
    const containerId = anchor?.containerId ?? cached?.containerId ?? cached?.ctx
    const originalUrl = anchor?.originalUrl ?? cached?.originalUrl
    const chromeUrl = anchor?.chromeUrl ?? cached?.chromeUrl ?? nativeTab.url

    if (customTitle !== undefined) sd.customTitle = customTitle
    if (customColor !== undefined) sd.customColor = customColor
    if (containerId !== undefined) sd.containerId = containerId
    if (originalUrl !== undefined) sd.originalUrl = originalUrl
    if (chromeUrl !== undefined) sd.chromeUrl = chromeUrl

    tabsSessionData[i] = sd
    sessionDataByNewId.set(nativeTab.id, sd)
  }

  // Recompute lvl from the remapped parent chain
  for (const sd of tabsSessionData) {
    if (!sd) continue
    let lvl = 0
    let currParentId = sd.parentId
    const visited = new Set<ID>([sd.id])
    while (currParentId !== undefined && currParentId !== NOID && !visited.has(currParentId)) {
      visited.add(currParentId)
      const parentSd = sessionDataByNewId.get(currParentId)
      if (!parentSd) break
      lvl++
      currParentId = parentSd.parentId
    }
    sd.lvl = lvl
  }

  // Update hot runtime maps for tabs whose IDs changed so subsequent lookups by new tab.id succeed
  let runtimeMapsChanged = false
  const updatedRecordsToPersist: TabTreeAnchorRecord[] = []
  for (let i = 0; i < nativeTabs.length; i++) {
    const nativeTab = nativeTabs[i]
    const sd = tabsSessionData[i]
    if (!nativeTab || !sd) continue

    const newIdKey = String(nativeTab.id)
    if (sd.containerId) {
      containerByTabId.set(newIdKey, sd.containerId)
      runtimeMapsChanged = true
    }
    if (sd.originalUrl) {
      originalUrlByTabId.set(newIdKey, sd.originalUrl)
      runtimeMapsChanged = true
    }
    const existingTv = tabValues.get(newIdKey) ?? {}
    tabValues.set(newIdKey, { ...existingTv, data: toPlainData(sd) })

    const normUrl = nativeNormUrls[i]
    const title = nativeTitles[i]
    const fp = computeFingerprint({
      windowId: nativeTab.windowId,
      index: nativeTab.index ?? i,
      normalizedUrl: normUrl,
      title,
      openerTabId: nativeTab.openerTabId,
    })
    const updatedRecord: TabTreeAnchorRecord = {
      id: nativeTab.id,
      panelId: sd.panelId,
      parentId: sd.parentId,
      folded: sd.folded,
      lvl: sd.lvl,
      customTitle: sd.customTitle,
      customColor: sd.customColor,
      containerId: sd.containerId,
      originalUrl: sd.originalUrl,
      chromeUrl: sd.chromeUrl,
      fingerprint: fp,
      windowId: nativeTab.windowId,
      index: nativeTab.index ?? i,
      normalizedUrl: normUrl,
      title,
      openerTabId: nativeTab.openerTabId,
      pinned: nativeTab.pinned,
      updatedAt: Date.now(),
    }
    anchorsByTabId.set(newIdKey, updatedRecord)
    fingerprintMap.set(fp, updatedRecord)
    updatedRecordsToPersist.push(updatedRecord)
    runtimeMapsChanged = true
  }

  if (runtimeMapsChanged) {
    const pruneOps = pruneBoundedCaches()
    await enqueuePersist(async () => {
      await syncSessionLayer()
      const ops: IDBBatchOp[] = [...pruneOps]
      for (const rec of updatedRecordsToPersist) {
        ops.push({ store: STORE_TABS_BY_ID, type: 'put', value: rec })
        if (rec.fingerprint) {
          ops.push({ store: STORE_TABS_BY_FP, type: 'put', value: rec })
        }
      }
      ops.push({
        store: STORE_META,
        type: 'put',
        value: { key: 'tab_values', data: mapToRecord(tabValues) },
      })
      const allIdbOk = await idbRunBatch(ops)
      await syncDurableMirror(!allIdbOk)
    })
  }

  return {
    tabsSessionData,
    matchedCache,
  }
}

export const TabTreeAnchor = {
  init,
  clearInMemoryCacheForTest,
  normalizeUrlForFingerprint,
  computeFingerprint,
  setTabValue,
  getTabValue,
  setWindowValue,
  getWindowValue,
  getTabContainerId,
  setTabContainerId,
  getTabTitle,
  getTabOriginalUrl,
  setTabOriginalUrl,
  removeTabAnchor,
  anchorTabState,
  restoreOrMatchTabsState,
}

export const TabTreeAnchorEngine = TabTreeAnchor
