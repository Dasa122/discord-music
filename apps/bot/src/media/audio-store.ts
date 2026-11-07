import { createReadStream, type Dirent } from "node:fs";
import { mkdir, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { logger } from "../logger.js";

/** Files are downloadable for longer than any realistic voice session. */
export const PRESIGN_EXPIRY_SECONDS = 6 * 60 * 60;

/**
 * Low-level audio object storage. Keys are opaque strings; the cache owns the
 * key layout and the session semantics.
 */
export interface AudioStore {
  put(key: string, filePath: string): Promise<void>;
  /** URL/path ffmpeg can read directly. */
  playbackTarget(key: string): Promise<string>;
  deletePrefix(prefix: string): Promise<number>;
  listPrefix(prefix: string): Promise<string[]>;
  health(): Promise<boolean>;
}

// --------------------------------------------------------------------- local

export class LocalAudioStore implements AudioStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async put(key: string, filePath: string): Promise<void> {
    const target = join(this.dir, key);
    await mkdir(dirname(target), { recursive: true });
    await rename(filePath, target);
  }

  async playbackTarget(key: string): Promise<string> {
    return join(this.dir, key);
  }

  async listPrefix(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.isFile()) {
          const key = relative(this.dir, path).split("\\").join("/");
          if (key.startsWith(prefix)) keys.push(key);
        }
      }
    };
    await walk(this.dir);
    return keys.sort();
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.listPrefix(prefix);
    let deleted = 0;
    for (const key of keys) {
      try {
        await unlink(join(this.dir, key));
        deleted += 1;
      } catch (error) {
        logger.debug("audio store: delete failed", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return deleted;
  }

  async health(): Promise<boolean> {
    try {
      await mkdir(this.dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
}

// ------------------------------------------------------------------------ s3

export interface S3AudioStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Test injection points. */
  client?: S3Client;
  presign?: typeof getSignedUrl;
}

export function buildS3ClientConfig(options: S3AudioStoreOptions): S3ClientConfig {
  return {
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: options.forcePathStyle,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
  };
}

export class S3AudioStore implements AudioStore {
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly presign: typeof getSignedUrl;

  constructor(options: S3AudioStoreOptions) {
    this.bucket = options.bucket;
    this.client = options.client ?? new S3Client(buildS3ClientConfig(options));
    this.presign = options.presign ?? getSignedUrl;
  }

  async put(key: string, filePath: string): Promise<void> {
    const info = await stat(filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(filePath),
        ContentLength: info.size,
      }),
    );
  }

  async playbackTarget(key: string): Promise<string> {
    return this.presign(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    });
  }

  async listPrefix(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key) keys.push(object.Key);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.listPrefix(prefix);
    let deleted = 0;
    for (let index = 0; index < keys.length; index += 1000) {
      const batch = keys.slice(index, index + 1000);
      if (batch.length === 0) continue;
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: batch.map((key) => ({ Key: key })),
            Quiet: true,
          },
        }),
      );
      deleted += batch.length;
    }
    return deleted;
  }

  async health(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }
}

// ------------------------------------------------------------------ selection

export type AudioStoreMode = "local" | "s3";

export interface AudioStoreSelection {
  store: AudioStore;
  mode: AudioStoreMode;
}

export interface SelectAudioStoreOptions {
  mode: AudioStoreMode;
  localDir: string;
  s3?: Omit<S3AudioStoreOptions, "client" | "presign">;
  /** Test injection: build the S3 store (healthy or not) without the SDK. */
  createS3?: () => AudioStore;
}

/**
 * Pick the configured backend. A broken S3 setup degrades to local storage
 * instead of taking the bot down.
 */
export async function selectAudioStore(
  options: SelectAudioStoreOptions,
): Promise<AudioStoreSelection> {
  if (options.mode === "s3" && options.s3) {
    let store: AudioStore | null = null;
    try {
      store = options.createS3 ? options.createS3() : new S3AudioStore(options.s3);
      if (await store.health()) return { store, mode: "s3" };
    } catch (error) {
      logger.warn("audio_store_unavailable", {
        store: "s3",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    logger.warn("audio_store_unavailable", { store: "s3", fallback: "local" });
  }

  return { store: new LocalAudioStore(options.localDir), mode: "local" };
}

/** Remove a temp directory tree, ignoring a missing path. */
export async function removeTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
