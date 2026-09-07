/**
 * FileStorageDriver.ts
 *
 * Persistent file-based key-value storage driver for React Native / Expo apps.
 * Backed by expo-file-system, writing one JSON file per namespace to the
 * application document directory (survives app restarts and process kills).
 *
 * ARCHITECTURAL RULE:
 * This file belongs in src/adapters/storage/.
 * The IStorageDriver interface in src/core/storage/ must never import this file.
 */

import { IStorageDriver } from '../../core/storage/IStorageDriver';

// Minimal expo-file-system interface (avoids hard import breaking Node.js compilation)
interface ExpoFileSystem {
  documentDirectory: string | null;
  readAsStringAsync(fileUri: string, options?: { encoding?: string }): Promise<string>;
  writeAsStringAsync(fileUri: string, contents: string, options?: { encoding?: string }): Promise<void>;
  getInfoAsync(fileUri: string): Promise<{ exists: boolean; isDirectory?: boolean }>;
  deleteAsync(fileUri: string, options?: { idempotent?: boolean }): Promise<void>;
}

type StoreData = Record<string, string>;

export class FileStorageDriver implements IStorageDriver {
  private readonly namespace: string;
  private cache: StoreData | null = null;
  private fs: ExpoFileSystem | null = null;

  constructor(namespace: string) {
    this.namespace = namespace;
  }

  public async getItem(key: string): Promise<string | null> {
    const store = await this.loadStore();
    return store[key] ?? null;
  }

  public async setItem(key: string, value: string): Promise<void> {
    const store = await this.loadStore();
    store[key] = value;
    await this.persistStore(store);
  }

  public async removeItem(key: string): Promise<void> {
    const store = await this.loadStore();
    if (key in store) {
      delete store[key];
      await this.persistStore(store);
    }
  }

  public async getAllKeys(): Promise<string[]> {
    const store = await this.loadStore();
    return Object.keys(store);
  }

  public async clear(): Promise<void> {
    this.cache = {};
    await this.persistStore({});
  }

  private async getFs(): Promise<ExpoFileSystem> {
    if (this.fs) return this.fs;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.fs = require('expo-file-system') as ExpoFileSystem;
    return this.fs;
  }

  private getFileUri(fs: ExpoFileSystem): string {
    const base = fs.documentDirectory ?? 'file:///data/data/com.bettermaps/files/';
    return `${base}bettermaps_${this.namespace}.json`;
  }

  private async loadStore(): Promise<StoreData> {
    if (this.cache !== null) return this.cache;
    try {
      const fs = await this.getFs();
      const uri = this.getFileUri(fs);
      const info = await fs.getInfoAsync(uri);
      if (!info.exists) {
        this.cache = {};
        return this.cache;
      }
      const raw = await fs.readAsStringAsync(uri, { encoding: 'utf8' });
      this.cache = JSON.parse(raw) as StoreData;
    } catch (err) {
      console.warn(`[FileStorageDriver:${this.namespace}] Failed to load store:`, err);
      this.cache = {};
    }
    return this.cache!;
  }

  private async persistStore(store: StoreData): Promise<void> {
    this.cache = store;
    try {
      const fs = await this.getFs();
      const uri = this.getFileUri(fs);
      await fs.writeAsStringAsync(uri, JSON.stringify(store), { encoding: 'utf8' });
    } catch (err) {
      console.warn(`[FileStorageDriver:${this.namespace}] Failed to persist store:`, err);
    }
  }
}
