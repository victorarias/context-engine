import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SQLiteMetadataStore } from "../../src/storage/metadata-store.js";
import { WriteAheadLog } from "../../src/storage/write-log.js";
import { TempDir } from "../harness/temp-dir.js";

describe("WriteAheadLog", () => {
  const dirs: TempDir[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0, dirs.length)) {
      dir.cleanup();
    }
  });

  function createWal() {
    const dir = TempDir.create("ce-wal");
    dirs.push(dir);
    const store = new SQLiteMetadataStore({ path: join(dir.path, "metadata.db") });
    const wal = new WriteAheadLog(store.getDatabase());
    return { wal, store };
  }

  it("tracks write lifecycle", async () => {
    const { wal, store } = createWal();

    const id = await wal.beginIntent("upsert", ["c1", "c2"]);
    let pending = await wal.listPending();

    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(id);
    expect(pending[0].lanceOk).toBe(false);
    expect(pending[0].sqliteOk).toBe(false);

    await wal.markLanceOk(id);
    pending = await wal.listPending();
    expect(pending[0].lanceOk).toBe(true);
    expect(pending[0].sqliteOk).toBe(false);

    await wal.markSqliteOk(id);
    pending = await wal.listPending();
    expect(pending.length).toBe(0);

    await store.close();
  });

  it("reconciles pending entries", async () => {
    const { wal, store } = createWal();

    const id1 = await wal.beginIntent("upsert", ["a"]);
    const id2 = await wal.beginIntent("delete", ["b"]);
    await wal.markLanceOk(id2); // simulate partial completion

    const seen: number[] = [];
    await wal.reconcile(async ({ entry, markRecovered }) => {
      seen.push(entry.id);
      markRecovered();
    });

    expect(seen).toEqual([id1, id2]);
    expect((await wal.listPending()).length).toBe(0);

    await store.close();
  });
});
