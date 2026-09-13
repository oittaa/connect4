const DB_NAME = "c4-cache";
const DB_VERSION = 2;
const STORE = "blob";
const RECORD = "proven";

let dbp: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (db.objectStoreNames.contains("positions")) {
          db.deleteObjectStore("positions");
        }
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbp = undefined;
        reject(req.error);
      };
    });
  }
  return dbp;
}

export async function cacheLoad(): Promise<Uint8Array | undefined> {
  try {
    const db = await openDb();
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
  const copy = data.slice();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(copy, RECORD);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
