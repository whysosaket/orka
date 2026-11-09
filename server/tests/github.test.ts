import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Store } from "./bridge/store.js";
import { Blobs } from "./reference/blobs.js";
import { createApi } from "./bridge/main.js";

await test("disabled GitHub integration rejects actions on the server", async () => {
  const pool = new Pool();
  const user = randomUUID();
  const server = createApi(
    new Store(pool, new Blobs("unused-disabled-fixture")),
    async () => user,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal(
      (await fetch(base + "/v2/instance").then((response) => response.json()))
        .repositories.github,
      0,
    );
    for (const action of [
      "status",
      "begin",
      "clone-credentials",
      "bind",
      "request-access",
    ]) {
      const response = await fetch(base + "/v2/github/action", {
        method: "POST",
        headers: {
          Authorization: "Bearer fixture",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action, input: {} }),
      });
      assert.equal(response.status, 404, action);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});
