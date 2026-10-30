import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  availablePort,
  devConfig,
  validateProfile,
  worktreeProfile,
} from "../scripts/profile-launcher.js";

await test("worktree identities are stable and distinct even for identical folder names", () => {
  const first = worktreeProfile("/tmp/one/feature");
  assert.equal(first, worktreeProfile("/tmp/one/feature"));
  assert.notEqual(first, worktreeProfile("/tmp/two/feature"));
  assert.equal(validateProfile(first), first);
  assert.doesNotThrow(() =>
    validateProfile(worktreeProfile("/tmp/" + "🌿".repeat(100))),
  );
  for (const name of [
    "../default",
    "",
    "--flag",
    "Alice",
    "a b",
    "a".repeat(49),
  ])
    assert.throws(() => validateProfile(name));
});

await test("worktree launcher skips occupied ports and pins Vite and the native frontend together", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(availablePort(address.port, 1));
    const port = await availablePort(address.port, 10);
    assert.notEqual(port, address.port);
    const config = devConfig(port);
    assert.equal(config.build.devUrl, `http://127.0.0.1:${port}`);
    assert.match(
      config.build.beforeDevCommand,
      new RegExp(`--port ${port} --strictPort$`),
    );
    assert.throws(() => devConfig(Number.NaN));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
