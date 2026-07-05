import type { IStorageAdapter } from '../types.js';

export function createInMemoryStorage(): IStorageAdapter {
  const store = new Map<string, string>();

  return {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async remove(key: string): Promise<void> {
      store.delete(key);
    },
    async getAllKeys(): Promise<string[]> {
      return Array.from(store.keys());
    },
  };
}

export function storageKey(...parts: string[]): string {
  return parts.join(':');
}
