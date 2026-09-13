const DB_NAME = "c4-proven";
const DB_VERSION = 1;
const STORE = "blob";
const RECORD = "proven";
/** Bound so a blocked version upgrade cannot stall the solver. */
const OPEN_MS = 400;

let dbp: Promise<IDBDatabase | null> | undefined;

function openDb(): Promise<IDBDatabase | null> {
  if (!dbp) {
    dbp = new Promise((resolve) => {
      let settled = false;
      const finish = (db: IDBDatabase | null) => {
        if (settled) {
          db?.close();
          return;
        }
        settled = true;
        resolve(db);
      };

      if (typeof indexedDB === "undefined") {
        finish(null);
        return;
      }

      const timer = self.setTimeout(() => finish(null), OPEN_MS);
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onblocked = () => {
          self.clearTimeout(timer);
          finish(null);
        };
        req.onerror = () => {
          self.clearTimeout(timer);
          finish(null);
        };
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE);
          }
        };
        req.onsuccess = () => {
          self.clearTimeout(timer);
          const db = req.result;
          db.onversionchange = () => {
            db.close();
            dbp = undefined;
          };
          finish(db);
        };
      } catch {
        self.clearTimeout(timer);
        finish(null);
      }
    });
  }
  return dbp;
}

export async function cacheLoad(): Promise<Uint8Array | undefined> {
  try {
    const db = await openDb();
    if (!db) return undefined;
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(RECORD);
      req.onsuccess = () => {
        const v = req.result;
        if (v instanceof ArrayBuffer) resolve(new Uint8Array(v));
        else if (v instanceof Uint8Array) resolve(v);
        else resolve(undefined);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

export async function cacheSave(data: Uint8Array): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const copy = data.slice();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(copy, RECORD);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
