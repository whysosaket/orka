import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Store } from "../packages/server-core/src/store.js";
import { Blobs } from "../packages/server-core/src/blobs.js";
import { createApi } from "../packages/server-core/src/main.js";
import { acceptingMemoryResolver } from "../packages/server-core/src/testing/memory-fixtures.js";

const families = [
  "laptop",
  "all-in-one",
  "mac-mini",
  "mac-studio",
  "mac-pro",
  "generic",
] as const;
async function fixture() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const home = await mkdtemp(join(tmpdir(), "orka-devices-"));
  const owner = randomUUID(),
    outsider = randomUUID();
  const store = new Store(pool, new Blobs(home), acceptingMemoryResolver());
  const server = createApi(store, async (token) => token);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const api = async (path: string, input?: unknown, user = owner) => {
    const response = await fetch(url + path, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${user}`,
        "Content-Type": "application/json",
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, value: await response.json() };
  };
  return {
    pool,
    home,
    owner,
    outsider,
    store,
    url,
    api,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.query("delete from orka.projects where created_by=$1", [
        owner,
      ]);
      await pool.query("delete from orka.devices where owner=any($1::uuid[])", [
        [owner, outsider],
      ]);
      await pool.end();
      await rm(home, { recursive: true, force: true });
    },
  };
}

await test("device registration persists all six families and never downgrades known hardware on missing/Generic reports", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.api("/v2/projects/capabilities")).value.deviceHardware,
      1,
    );
    const ids = families.map(() => randomUUID());
    for (const [index, family] of families.entries()) {
      assert.equal(
        (
          await f.api("/v2/devices", {
            id: ids[index],
            name: `Renamed computer ${index}`,
            hardwareFamily: family,
          })
        ).status,
        200,
      );
    }
    const listed = (await f.api("/v2/devices")).value as {
      id: string;
      hardwareFamily: string;
    }[];
    assert.equal(listed.length, 6);
    for (const [index, family] of families.entries()) {
      assert.equal(
        listed.find((row) => row.id === ids[index])?.hardwareFamily,
        family,
      );
      const stored = await f.pool.query(
        "select hardware_family from orka.devices where id=$1",
        [ids[index]],
      );
      assert.equal(stored.rows[0].hardware_family, family);
    }
    for (const report of [{}, { hardwareFamily: "generic" }]) {
      assert.equal(
        (
          await f.api("/v2/devices", {
            id: ids[0],
            name: "Misleading Mac Pro name",
            ...report,
          })
        ).status,
        200,
      );
      assert.equal(
        (await f.api("/v2/devices")).value.find(
          (row: { id: string }) => row.id === ids[0],
        ).hardwareFamily,
        "laptop",
      );
    }
    // An initially unknown remote Mac updates when it reports real metadata.
    assert.equal(
      (
        await f.api("/v2/devices", {
          id: ids[5],
          name: "MacBook Air",
          hardwareFamily: "mac-studio",
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.api("/v2/devices")).value.find(
        (row: { id: string }) => row.id === ids[5],
      ).hardwareFamily,
      "mac-studio",
    );
    const legacy = randomUUID();
    assert.equal(
      (await f.api("/v2/devices", { id: legacy, name: "Mac Studio" })).status,
      200,
    );
    assert.equal(
      (await f.api("/v2/devices")).value.find(
        (row: { id: string }) => row.id === legacy,
      ).hardwareFamily,
      null,
    );
    for (const hardwareFamily of [
      "future-family",
      "MacBook Pro",
      "",
      null,
      42,
    ]) {
      assert.equal(
        (
          await f.api("/v2/devices", {
            id: ids[0],
            name: "Office",
            hardwareFamily,
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await f.api(
          "/v2/devices",
          { id: ids[0], name: "Stolen", hardwareFamily: "mac-pro" },
          f.outsider,
        )
      ).status,
      403,
    );
    assert.deepEqual(
      (await f.api("/v2/devices", undefined, f.outsider)).value,
      [],
    );
    assert.equal(
      (await f.api("/v2/devices")).value.find(
        (row: { id: string }) => row.id === ids[0],
      ).hardwareFamily,
      "laptop",
    );
  } finally {
    await f.close();
  }
});

await test(
  "native registration, Settings query, and snapshot retain This Mac hardware with older-service responses",
  { skip: !process.env.ORKA_ENV_NATIVE_BIN },
  async () => {
    const f = await fixture();
    const { startEnvMac } =
      await import("../packages/server-core/src/testing/env-native.js");
    let older = false;
    const proxy = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const upstream = await fetch(f.url + request.url, {
          method: request.method,
          headers: {
            Authorization: request.headers.authorization ?? "",
            "Content-Type": "application/json",
            "X-Orka-Governance": "1",
          },
          ...(body.length ? { body } : {}),
        });
        const value = await upstream.json();
        if (older && request.method === "GET") {
          if (request.url === "/v2/projects/capabilities")
            delete value.deviceHardware;
          if (request.url === "/v2/devices")
            for (const row of value) delete row.hardwareFamily;
        }
        response.writeHead(upstream.status, {
          "Content-Type": "application/json",
        });
        response.end(JSON.stringify(value));
      })().catch((error: Error) => {
        response.writeHead(500);
        response.end(JSON.stringify({ error: error.message }));
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    let mac: Awaited<ReturnType<typeof startEnvMac>> | undefined;
    try {
      const project = await f.store.createProject(
        f.owner,
        "Device hardware native acceptance",
      );
      mac = await startEnvMac({
        home: f.home,
        name: "native",
        user: f.owner,
        project,
        url,
        enable: false,
      });
      await mac.request({ action: "sync" });
      const snapshot = await mac.request<{
        deviceId: string;
        localHardwareFamily: string;
        devices: { id: string; hardwareFamily: string }[];
      }>({ action: "snapshot" });
      assert.ok(
        families
          .slice(0, 5)
          .includes(snapshot.localHardwareFamily as (typeof families)[0]),
      );
      assert.equal(
        snapshot.devices.find((row) => row.id === snapshot.deviceId)
          ?.hardwareFamily,
        snapshot.localHardwareFamily,
      );
      const persisted = await f.pool.query(
        "select hardware_family from orka.devices where id=$1",
        [snapshot.deviceId],
      );
      assert.equal(
        persisted.rows[0].hardware_family,
        snapshot.localHardwareFamily,
      );
      const remote = randomUUID(),
        unknown = randomUUID();
      await f.api("/v2/devices", {
        id: remote,
        name: "Misleading MacBook Air",
        hardwareFamily: "mac-pro",
      });
      await f.api("/v2/devices", {
        id: unknown,
        name: "Misleading Mac Studio",
      });
      const context = { user: f.owner, service: url };
      const before = await mac.request<
        { id: string; hardwareFamily: string }[]
      >({ action: "settings", operation: "devices", context });
      assert.equal(
        before.find((row) => row.id === remote)?.hardwareFamily,
        "mac-pro",
      );
      assert.equal(
        before.find((row) => row.id === unknown)?.hardwareFamily,
        "generic",
      );
      older = true;
      const after = await mac.request<typeof before>({
        action: "settings",
        operation: "devices",
        context,
      });
      assert.equal(
        after.find((row) => row.id === snapshot.deviceId)?.hardwareFamily,
        snapshot.localHardwareFamily,
      );
      assert.equal(
        after.find((row) => row.id === remote)?.hardwareFamily,
        "mac-pro",
      );
      assert.equal(
        after.find((row) => row.id === unknown)?.hardwareFamily,
        "generic",
      );
      assert.equal(after.length, 3);
      await mac.request({ action: "sync" });
      const refreshed = await mac.request<typeof snapshot>({
        action: "snapshot",
      });
      assert.equal(
        refreshed.devices.find((row) => row.id === snapshot.deviceId)
          ?.hardwareFamily,
        snapshot.localHardwareFamily,
      );
      assert.equal(
        refreshed.devices.find((row) => row.id === remote)?.hardwareFamily,
        "mac-pro",
      );
      older = false;
      await f.api("/v2/devices", {
        id: unknown,
        name: "Misleading Mac Studio",
        hardwareFamily: "mac-mini",
      });
      const updated = await mac.request<typeof before>({
        action: "settings",
        operation: "devices",
        context,
      });
      assert.equal(
        updated.find((row) => row.id === unknown)?.hardwareFamily,
        "mac-mini",
      );
    } finally {
      await mac?.close();
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await f.close();
    }
  },
);
