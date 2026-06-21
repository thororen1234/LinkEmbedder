interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class LRUCache<T> {
  private readonly map: Map<string, CacheEntry<T>>;
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;

  constructor(maxSize = 512, defaultTtlMs = 60 * 60 * 1000) {
    this.map = new Map();
    this.maxSize = maxSize;
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    if (this.map.has(key)) this.map.delete(key);
    if (this.map.size >= this.maxSize) {
      this.map.delete(this.map.keys().next().value as string);
    }
    this.map.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export const twitterCache = new LRUCache<unknown>(256, 15 * 60 * 1000);
export const instagramCache = new LRUCache<unknown>(256, 5 * 60 * 1000);
export const redditCache = new LRUCache<unknown>(256, 30 * 60 * 1000);
export const tiktokCache = new LRUCache<unknown>(256, 5 * 60 * 1000);
export const blueskyCache = new LRUCache<unknown>(256, 15 * 60 * 1000);
export const pixivCache = new LRUCache<unknown>(512, 60 * 60 * 1000);
export const tumblrCache = new LRUCache<unknown>(256, 60 * 60 * 1000);
export const twitchCache = new LRUCache<unknown>(256, 30 * 60 * 1000);
export const bilibiliCache = new LRUCache<unknown>(256, 30 * 60 * 1000);
export const facebookCache = new LRUCache<unknown>(256, 30 * 60 * 1000);
export const furaffinityCache = new LRUCache<unknown>(256, 30 * 60 * 1000);
export const deviantartCache = new LRUCache<unknown>(256, 30 * 60 * 1000);
export const iwaraCache = new LRUCache<unknown>(256, 30 * 60 * 1000);
export const pttCache = new LRUCache<unknown>(256, 30 * 60 * 1000);
export const threadsCache = new LRUCache<unknown>(256, 30 * 60 * 1000);
