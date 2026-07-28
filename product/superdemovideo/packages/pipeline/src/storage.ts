import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createReadStream } from "node:fs";

/**
 * Artifact storage.
 *
 * Paths are always logical ("runs/run_x/video-169.mp4"); the driver decides
 * where that lives. Publishing swaps a directory atomically, which is what
 * makes "same URL, new content" cheap and reversible.
 */
export interface Storage {
  put(path: string, data: Buffer | string): Promise<void>;
  get(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  /** Copy a local directory tree into storage under `path`. */
  putDir(path: string, localDir: string): Promise<void>;
  /** Replace `path` with the contents of `localDir` in one visible step. */
  swapDir(path: string, localDir: string): Promise<void>;
  remove(path: string): Promise<void>;
  size(path: string): Promise<number>;
  /** Absolute filesystem location, when the driver has one. */
  localPath(path: string): string | null;
  stream(path: string): NodeJS.ReadableStream;
}

export function createStorage(opts: { driver: "fs" | "s3"; root: string }): Storage {
  if (opts.driver === "s3") {
    throw new Error(
      "The S3 storage driver is not implemented in M1. Use SDV_STORAGE_DRIVER=fs.",
    );
  }
  return fsStorage(opts.root);
}

function fsStorage(root: string): Storage {
  const abs = (p: string) => {
    const full = resolve(root, p);
    // Refuse to escape the storage root, whatever the caller passed.
    if (full !== root && !full.startsWith(root + sep)) {
      throw new Error(`storage path escapes root: ${p}`);
    }
    return full;
  };

  return {
    async put(path, data) {
      const target = abs(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    },
    async get(path) {
      return readFile(abs(path));
    },
    async exists(path) {
      try {
        await stat(abs(path));
        return true;
      } catch {
        return false;
      }
    },
    async list(prefix) {
      const base = abs(prefix);
      const out: string[] = [];
      const walk = async (dir: string) => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else out.push(relative(root, p));
        }
      };
      await walk(base);
      return out.sort();
    },
    async putDir(path, localDir) {
      const target = abs(path);
      await mkdir(dirname(target), { recursive: true });
      await cp(localDir, target, { recursive: true });
    },
    async swapDir(path, localDir) {
      const target = abs(path);
      const staging = `${target}.staging-${process.pid}`;
      const retired = `${target}.retired-${process.pid}`;
      await rm(staging, { recursive: true, force: true });
      await mkdir(dirname(target), { recursive: true });
      await cp(localDir, staging, { recursive: true });
      let hadPrevious = false;
      try {
        await rename(target, retired);
        hadPrevious = true;
      } catch {
        /* nothing published here yet */
      }
      await rename(staging, target);
      if (hadPrevious) await rm(retired, { recursive: true, force: true });
    },
    async remove(path) {
      await rm(abs(path), { recursive: true, force: true });
    },
    async size(path) {
      const s = await stat(abs(path));
      if (!s.isDirectory()) return s.size;
      let total = 0;
      const walk = async (dir: string) => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          const p = join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else total += (await stat(p)).size;
        }
      };
      await walk(abs(path));
      return total;
    },
    localPath(path) {
      return abs(path);
    },
    stream(path) {
      return createReadStream(abs(path));
    },
  };
}
