/**
 * IStorageDriver.ts
 *
 * Generic provider-neutral asynchronous key-value storage contract.
 * Implementations may be backed by expo-file-system, AsyncStorage,
 * SQLite, in-memory, or any other persistence engine.
 *
 * ARCHITECTURAL RULE:
 * This interface belongs in src/core/storage/.
 * It must have ZERO imports from Expo, React Native, SQLite, or AsyncStorage.
 * All implementation-specific code lives in src/adapters/storage/.
 */

export interface IStorageDriver {
  /**
   * Reads the value associated with the given key.
   * Returns null if the key does not exist.
   */
  getItem(key: string): Promise<string | null>;

  /**
   * Writes (or overwrites) the value for the given key.
   */
  setItem(key: string, value: string): Promise<void>;

  /**
   * Removes the entry for the given key.
   * Is a no-op if the key does not exist.
   */
  removeItem(key: string): Promise<void>;

  /**
   * Returns all keys currently stored in this driver's namespace.
   * Returns an empty array if the store is empty.
   */
  getAllKeys(): Promise<string[]>;

  /**
   * Removes all entries from the store.
   * Use with caution — this is irreversible.
   */
  clear(): Promise<void>;
}
