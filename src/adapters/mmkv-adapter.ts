import type { IStorageAdapter } from '../types.js';

export function createMMKVStorageAdapter(mmkv: {
  getString: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
  delete: (key: string) => void;
  getAllKeys: () => string[];
}): IStorageAdapter {
  return {
    async get(key: string): Promise<string | null> {
      const val = mmkv.getString(key);
      return val ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      mmkv.set(key, value);
    },
    async remove(key: string): Promise<void> {
      mmkv.delete(key);
    },
    async getAllKeys(): Promise<string[]> {
      return mmkv.getAllKeys();
    },
  };
}
