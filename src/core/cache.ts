import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface Entry<T> {
  key: string;
  t: number;
  data: T;
}

export function defaultCacheDir(): string {
  const base =
    process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "patchpath");
}

/** Small JSON file cache. A null directory disables caching. */
export class Cache {
  constructor(private readonly dir: string | null) {}

  /** False when caching is disabled (`--no-cache`). */
  get enabled(): boolean {
    return this.dir !== null;
  }

  private file(key: string): string {
    const hash = createHash("sha1").update(key).digest("hex").slice(0, 20);
    return join(this.dir as string, `${hash}.json`);
  }

  async get<T>(key: string, ttlMs: number): Promise<T | undefined> {
    if (!this.dir) return undefined;
    try {
      const entry = JSON.parse(await readFile(this.file(key), "utf8")) as Entry<T>;
      if (entry.key === key && Date.now() - entry.t < ttlMs) return entry.data;
    } catch {
      // missing or corrupt entry: treat as a miss
    }
    return undefined;
  }

  async set<T>(key: string, data: T): Promise<void> {
    if (!this.dir) return;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.file(key), JSON.stringify({ key, t: Date.now(), data }));
    } catch {
      // a cache that cannot be written must never break a scan
    }
  }
}
