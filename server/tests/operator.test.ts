import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";

const composeAvailable =
  spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

await test(
  "operator archive installs a pinned image with isolated volumes and no source workspace",
  { skip: !composeAvailable },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "orka-operator-test-"));
    try {
      const archive = join(directory, "release.tar.gz");
      const packaged = spawnSync(
        process.execPath,
        ["scripts/release/package-operator.mjs", "orka-test:operator", archive],
        { encoding: "utf8" },
      );
      assert.equal(packaged.status, 0, packaged.stderr);
      assert.equal(
        spawnSync("tar", ["-xzf", archive, "-C", directory]).status,
        0,
      );
      const root = await realpath(join(directory, "orka-server"));
      const files = await readdir(root);
      for (const excluded of [
        "package.json",
        "package-lock.json",
        "packages",
        "node_modules",
        "tests",
        "scripts",
        "apps",
      ])
        assert.ok(
          !files.includes(excluded),
          `${excluded} must not ship to operators`,
        );
      const configured = spawnSync(
        "sh",
        ["./configure.sh", "localhost", "--port", "8181"],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(configured.status, 0, configured.stderr);
      const env = parseEnv(await readFile(join(root, ".env"), "utf8"));
      assert.equal(env.ORKA_IMAGE, "orka-test:operator");
      const rendered = spawnSync(
        "docker",
        ["compose", "--profile", "tools", "config", "--format", "json"],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(rendered.status, 0, rendered.stderr);
      const config = JSON.parse(rendered.stdout);
      assert.equal(config.services.api.build, undefined);
      assert.equal(config.services.api.image, env.ORKA_IMAGE);
      assert.equal(config.services.admin.image, env.ORKA_IMAGE);
      assert.equal(config.services.api.ports[0].host_ip, "127.0.0.1");
      assert.equal(config.services.api.ports[0].published, "8181");
      for (const volume of Object.values(config.volumes) as { name: string }[])
        assert.ok(volume.name.startsWith(env.COMPOSE_PROJECT_NAME + "_"));
      assert.ok(
        config.services.db.volumes.some(
          (v: { source: string }) =>
            v.source === join(root, "deploy/ec2/init-db.sh"),
        ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

await test("ordinary start never builds or pulls, and restore refuses an existing installation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orka-operator-lifecycle-"));
  try {
    await mkdir(join(directory, "deploy/self-hosted"), { recursive: true });
    for (const file of [
      "orka-server",
      "configure.sh",
      "deploy/self-hosted/.env.example",
      "deploy/self-hosted/restore.sh",
    ])
      await copyFile(file, join(directory, file));
    assert.equal(
      spawnSync("sh", ["./configure.sh", "localhost"], {
        cwd: directory,
        stdio: "ignore",
      }).status,
      0,
    );
    const before = await readFile(join(directory, ".env"), "utf8");
    const bin = join(directory, "bin"),
      calls = join(directory, "calls");
    await mkdir(bin);
    await writeFile(
      join(bin, "docker"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ORKA_TEST_DOCKER_CALLS"\nexit 0\n',
    );
    await chmod(join(bin, "docker"), 0o755);
    const run = (...args: string[]) =>
      spawnSync("sh", ["./orka-server", ...args], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ORKA_TEST_DOCKER_CALLS: calls,
        },
      });
    assert.equal(run("start").status, 0);
    const operations = await readFile(calls, "utf8");
    assert.match(operations, /up --no-build --pull never/);
    assert.doesNotMatch(
      operations,
      /(?:^|\n).* compose .* (?:build api|pull --policy)/,
    );
    const restored = run("restore", resolve(directory, "backup"));
    assert.notEqual(restored.status, 0);
    assert.match(restored.stderr, /fresh installation/);
    assert.equal(await readFile(join(directory, ".env"), "utf8"), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
