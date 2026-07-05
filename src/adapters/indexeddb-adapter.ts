import type { IStorageAdapter } from '../types.js';

const DB_NAME = 'teincfood-chat';
const STORE_NAME = 'chat-store';
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDBStorageAdapter implements IStorageAdapter {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = openDB();
  }

  private async doTransaction<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const request = fn(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async get(key: string): Promise<string | null> {
    const result = await this.doTransaction('readonly', (store) =>
      store.get(key),
    );
    return (result as string) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.doTransaction('readwrite', (store) => store.put(value, key));
  }

  async remove(key: string): Promise<void> {
    await this.doTransaction('readwrite', (store) => store.delete(key));
  }

  async getAllKeys(): Promise<string[]> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () =>
        resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });
  }
}
