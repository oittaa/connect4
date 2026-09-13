const DB_NAME = "c4-cache";
const STORE = "positions";
const VERSION = 1;
const MAX_ENTRIES = 50_000;

export interface CachedPos {
  key: string;
  score: number;
  scores?: number[];
  ts: number;
  v: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheGet(key: string): Promise<CachedPos | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => {
      const v = req.result as CachedPos | undefined;
      resolve(v && v.v === VERSION ? v : undefined);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function cachePut(entry: Omit<CachedPos, "ts" | "v">): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ ...entry, ts: Date.now(), v: VERSION });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  void evictIfNeeded(db);
}

async function evictIfNeeded(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const count: number = await new Promise((resolve, reject) => {
    const r = store.count();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  if (count <= MAX_ENTRIES) return;
  const all: CachedPos[] = await new Promise((resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => resolve(r.result as CachedPos[]);
    r.onerror = () => reject(r.error);
  });
  all.sort((a, b) => a.ts - b.ts);
  const drop = all.slice(0, all.length - MAX_ENTRIES);
  for (const e of drop) store.delete(e.key);
}
