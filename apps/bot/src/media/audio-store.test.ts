import { describe, expect, test } from "bun:test";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  type AudioStore,
  buildS3ClientConfig,
  LocalAudioStore,
  PRESIGN_EXPIRY_SECONDS,
  S3AudioStore,
  selectAudioStore,
} from "./audio-store.js";

class FakeS3Client {
  readonly commands: unknown[] = [];
  listKeys: string[] = [];
  batches: number[] = [];
  health = true;

  async send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    if (command instanceof ListObjectsV2Command) {
      return { Contents: this.listKeys.map((Key) => ({ Key })), IsTruncated: false };
    }
    if (command instanceof DeleteObjectsCommand) {
      const objects = command.input.Delete?.Objects ?? [];
      this.batches.push(objects.length);
      return { Deleted: objects };
    }
    if (command instanceof HeadBucketCommand) {
      if (!this.health) throw new Error("unhealthy");
      return {};
    }
    if (command instanceof PutObjectCommand) return {};
    throw new Error("unexpected command");
  }
}

function s3Options(client: FakeS3Client, presign?: unknown) {
  return {
    endpoint: "http://garage:3900",
    region: "garage",
    bucket: "music",
    accessKeyId: "key",
    secretAccessKey: "secret",
    forcePathStyle: true,
    client: client as unknown as S3Client,
    presign: presign as never,
  };
}

describe("S3 client configuration", () => {
  test("uses the endpoint and path-style addressing Garage needs", () => {
    const config = buildS3ClientConfig({
      endpoint: "http://garage:3900",
      region: "garage",
      bucket: "music",
      accessKeyId: "key",
      secretAccessKey: "secret",
      forcePathStyle: true,
    });
    expect(config.endpoint).toBe("http://garage:3900");
    expect(config.forcePathStyle).toBe(true);
    expect(config.region).toBe("garage");
    expect(config.credentials).toEqual({ accessKeyId: "key", secretAccessKey: "secret" });
  });
});

describe("S3AudioStore", () => {
  test("presigns a GET with a 6 hour expiry", async () => {
    const client = new FakeS3Client();
    let captured: { command: unknown; options: unknown } | null = null;
    const presign = async (_client: unknown, command: unknown, options: unknown) => {
      captured = { command, options };
      return "https://garage/signed";
    };

    const store = new S3AudioStore(s3Options(client, presign));
    const target = await store.playbackTarget("audio/s/a.audio");

    expect(target).toBe("https://garage/signed");
    expect(captured?.command).toBeInstanceOf(GetObjectCommand);
    if (!(captured?.command instanceof GetObjectCommand)) throw new Error("no command");
    expect(captured.command.input.Key).toBe("audio/s/a.audio");
    expect(captured?.options).toEqual({ expiresIn: PRESIGN_EXPIRY_SECONDS });
    expect(PRESIGN_EXPIRY_SECONDS).toBe(6 * 60 * 60);
  });

  test("deletes 1200 objects in batches of 1000 and 200", async () => {
    const client = new FakeS3Client();
    client.listKeys = Array.from({ length: 1200 }, (_, index) => `audio/s/${index}.audio`);
    const store = new S3AudioStore(s3Options(client));

    const deleted = await store.deletePrefix("audio/s/");

    expect(deleted).toBe(1200);
    expect(client.batches).toEqual([1000, 200]);
  });

  test("health reports a failed HeadBucket", async () => {
    const client = new FakeS3Client();
    client.health = false;
    const store = new S3AudioStore(s3Options(client));
    expect(await store.health()).toBe(false);
  });
});

describe("audio store selection", () => {
  function fakeStore(healthy: boolean): AudioStore {
    return {
      put: async () => undefined,
      playbackTarget: async () => "/x",
      deletePrefix: async () => 0,
      listPrefix: async () => [],
      health: async () => healthy,
    };
  }

  const base = {
    localDir: "/data/audio",
    s3: {
      endpoint: "http://garage:3900",
      region: "garage",
      bucket: "music",
      accessKeyId: "key",
      secretAccessKey: "secret",
      forcePathStyle: true,
    },
  };

  test("local is the default", async () => {
    const selection = await selectAudioStore({ ...base, mode: "local" });
    expect(selection.mode).toBe("local");
    expect(selection.store).toBeInstanceOf(LocalAudioStore);
  });

  test("a healthy s3 store is selected", async () => {
    const store = fakeStore(true);
    const selection = await selectAudioStore({
      ...base,
      mode: "s3",
      createS3: () => store,
    });
    expect(selection.mode).toBe("s3");
    expect(selection.store).toBe(store);
  });

  test("an unhealthy s3 store falls back to local", async () => {
    const selection = await selectAudioStore({
      ...base,
      mode: "s3",
      createS3: () => fakeStore(false),
    });
    expect(selection.mode).toBe("local");
    expect(selection.store).toBeInstanceOf(LocalAudioStore);
  });
});
