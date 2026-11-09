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

for (const mode of ["local", "public"])
  await test(`restore prepares an empty Docker image cache for ${mode} installations`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "orka-restore-cold-cache-"));
    try {
      for (const name of [
        "bin",
        "cache",
        "backup",
        "deploy/self-hosted",
        "deploy/ec2",
      ])
        await mkdir(join(directory, name), { recursive: true });
      for (const file of ["orka-server", "deploy/self-hosted/restore.sh"])
        await copyFile(file, join(directory, file));
      await writeFile(
        join(directory, "deploy/ec2/restore-check.sh"),
        "#!/bin/sh\nexit 0\n",
      );
      await writeFile(
        join(directory, "backup/operator.env"),
        `COMPOSE_PROJECT_NAME=orka-recovery-fixture\nORKA_SERVER_MODE=${mode}\nDOMAIN=${mode === "local" ? "localhost" : "sync.example.test"}\nORKA_IMAGE=fixture/server:1\n`,
      );
      await writeFile(
        join(directory, "backup/database.dump"),
        "fixture database",
      );
      await writeFile(join(directory, "backup/blobs.tar"), "fixture blobs");
      await writeFile(
        join(directory, "bin/docker"),
        `#!/bin/sh
set -eu
case "$1" in
  ps|volume|info) exit 0 ;;
  image) test -f "$ORKA_TEST_CACHE/api" ;;
  pull) touch "$ORKA_TEST_CACHE/api" ;;
  compose)
    shift
    case "$1" in
      pull) shift; [ "$1" != --policy ] || shift 2; for service in "$@"; do touch "$ORKA_TEST_CACHE/$service"; done ;;
      up)
        db_only=false
        for argument in "$@"; do if [ "$argument" = db ]; then db_only=true; fi; done
        required=db
        if [ "$db_only" = false ]; then required="db auth api"; if [ "$ORKA_TEST_MODE" = public ]; then required="$required caddy"; fi; fi
        for service in $required; do test -f "$ORKA_TEST_CACHE/$service" || { echo "Missing $service image on replacement host" >&2; exit 1; }; done ;;
      exec|run) cat >/dev/null ;;
      version|config) exit 0 ;;
    esac ;;
esac
`,
      );
      await chmod(join(directory, "bin/docker"), 0o755);
      const result = spawnSync(
        "sh",
        ["deploy/self-hosted/restore.sh", join(directory, "backup")],
        {
          cwd: directory,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${join(directory, "bin")}:${process.env.PATH}`,
            ORKA_TEST_CACHE: join(directory, "cache"),
            ORKA_TEST_MODE: mode,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Recovery completed/);
      assert.deepEqual(
        (await readdir(join(directory, "cache"))).sort(),
        mode === "local"
          ? ["api", "auth", "db"]
          : ["api", "auth", "caddy", "db"],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
