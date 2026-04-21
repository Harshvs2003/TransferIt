const DB_NAME = "p2p-transfer-db";
const DB_VERSION = 1;
const CHUNKS_STORE = "chunks";

interface ChunkRecord {
  transferId: string;
  index: number;
  payload: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
        const store = db.createObjectStore(CHUNKS_STORE, {
          keyPath: ["transferId", "index"],
        });
        store.createIndex("byTransfer", "transferId", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  handler: (store: IDBObjectStore, tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();

  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(CHUNKS_STORE, mode);
    const store = tx.objectStore(CHUNKS_STORE);

    Promise.resolve(handler(store, tx))
      .then((value) => {
        tx.oncomplete = () => {
          db.close();
          resolve(value);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      })
      .catch((error) => {
        db.close();
        reject(error);
      });
  });
}

export async function storeChunk(transferId: string, index: number, payload: ArrayBuffer): Promise<void> {
  await withStore("readwrite", (store) => {
    const record: ChunkRecord = {
      transferId,
      index,
      payload: new Blob([payload]),
    };
    store.put(record);
  });
}

export async function clearTransferChunks(transferId: string): Promise<void> {
  await withStore("readwrite", (store) => {
    const range = IDBKeyRange.bound([transferId, 0], [transferId, Number.MAX_SAFE_INTEGER]);
    store.delete(range);
  });
}

export async function getTransferBlob(transferId: string, totalChunks: number): Promise<Blob> {
  return withStore("readonly", async (store) => {
    const chunks: Blob[] = [];

    for (let i = 0; i < totalChunks; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const chunk = await new Promise<Blob | null>((resolve, reject) => {
        const request = store.get([transferId, i]);
        request.onsuccess = () => {
          const value = request.result as ChunkRecord | undefined;
          resolve(value?.payload || null);
        };
        request.onerror = () => reject(request.error);
      });

      if (!chunk) {
        throw new Error(`Missing chunk ${i}`);
      }

      chunks.push(chunk);
    }

    return new Blob(chunks);
  });
}