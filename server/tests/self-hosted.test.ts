import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  rm,
  stat,
  writeFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "orka-compose-config-"));
  await mkdir(join(directory, "deploy/self-hosted"), { recursive: true });
  await copyFile(
    "deploy/self-hosted/.env.example",
    join(directory, "deploy/self-hosted/.env.example"),
  );
  return directory;
}

await test("self-hosted setup generates private independent credentials and preserves existing installations", async () => {
  const directory = await fixture();
  try {
    const configure = (domain: string) =>
      spawnSync("sh", [resolve("configure.sh"), domain], {
        cwd: directory,
        encoding: "utf8",
      });
    assert.notEqual(configure("https://invalid.example/path").status, 0);
    assert.equal(configure("orka.example.test").status, 0);
    const before = await readFile(join(directory, ".env"), "utf8");
    const env = parseEnv(before);
    const secrets = [
      env.POSTGRES_PASSWORD,
      env.AUTH_DB_PASSWORD,
      env.API_DB_PASSWORD,
      env.JWT_SECRET,
    ];
    assert.ok(
      secrets.every(
        (secret) => typeof secret === "string" && /^[a-f0-9]{64}$/.test(secret),
      ),
    );
    assert.equal(new Set(secrets).size, 4);
    assert.equal(env.DOMAIN, "orka.example.test");
    assert.equal(env.MEMORY_JEV_ENABLED, "false");
    assert.equal(env.ORKA_SERVER_MODE, "public");
    assert.equal(env.COMPOSE_FILE, "compose.yml");
    assert.match(env.COMPOSE_PROJECT_NAME ?? "", /^orka-[a-f0-9]{8}$/);
    assert.equal((await stat(join(directory, ".env"))).mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(directory, ".runtime/accounts"))).mode & 0o777,
      0o700,
    );
    assert.notEqual(configure("different.example.test").status, 0);
    assert.ok(
      (await readFile(join(directory, ".env"), "utf8")) === before,
      "Setup must not rotate existing credentials",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("setup stops before generating credentials when Docker is unavailable", async () => {
  const directory = await fixture();
  try {
    await copyFile("orka-server", join(directory, "orka-server"));
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "docker"),
      '#!/bin/sh\nif [ "$1" = info ]; then exit 1; fi\nexit 0\n',
    );
    await chmod(join(bin, "docker"), 0o755);
    const result = spawnSync(
      "sh",
      ["./orka-server", "setup", "--local", "--email", "owner@example.test"],
      {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Docker is not running/);
    await assert.rejects(stat(join(directory, ".env")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("a failed backup blocks upgrade before a rebuild or restart can apply new source", async () => {
  const directory = await fixture();
  try {
    await copyFile("orka-server", join(directory, "orka-server"));
    await mkdir(join(directory, "deploy/ec2"), { recursive: true });
    await copyFile(
      "deploy/ec2/backup.sh",
      join(directory, "deploy/ec2/backup.sh"),
    );
    assert.equal(
      spawnSync("sh", [resolve("configure.sh"), "localhost"], {
        cwd: directory,
        stdio: "ignore",
      }).status,
      0,
    );
    const bin = join(directory, "bin"),
      calls = join(directory, "calls");
    await mkdir(bin);
    await writeFile(
      join(bin, "docker"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ORKA_TEST_DOCKER_CALLS"\ncase "$*" in *pg_dump*) exit 1 ;; esac\nexit 0\n',
    );
    await chmod(join(bin, "docker"), 0o755);
    const result = spawnSync("sh", ["./orka-server", "upgrade"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ORKA_TEST_DOCKER_CALLS: calls,
      },
    });
    assert.notEqual(result.status, 0);
    const operations = await readFile(calls, "utf8");
    assert.match(operations, /pg_dump/);
    assert.doesNotMatch(operations, /up --build/);
    assert.match(operations, /start auth api/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const hasCompose =
  spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
await test(
  "public Compose builds the OSS source, retains private services and resolves production/local storage",
  { skip: !hasCompose },
  async () => {
    const directory = await fixture();
    try {
      assert.equal(
        spawnSync("sh", [resolve("configure.sh"), "localhost"], {
          cwd: directory,
          stdio: "ignore",
        }).status,
        0,
      );
      const config = (local: boolean) => {
        const result = spawnSync(
          "docker",
          [
            "compose",
            "--env-file",
            join(directory, ".env"),
            "--profile",
            "tools",
            "-f",
            "compose.yml",
            ...(local ? ["-f", "deploy/local/compose.yml"] : []),
            "config",
            "--format",
            "json",
          ],
          { encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
      };
      const production = config(false);
      assert.equal(production.services.api.build.context, process.cwd());
      assert.equal(production.services.api.build.target, "oss");
      assert.equal(
        production.services.api.image,
        `orka-server:${production.name}`,
      );
      assert.equal(production.services.api.pull_policy, "build");
      for (const service of ["api", "auth", "db", "admin"])
        assert.equal(production.services[service].ports, undefined);
      for (const [service, target] of [
        ["db", "/var/lib/postgresql/data"],
        ["api", "/data/blobs"],
        ["caddy", "/data"],
      ])
        assert.equal(
          production.services[service].volumes.find(
            (volume: { target: string }) => volume.target === target,
          ).type,
          "volume",
        );
      assert.equal(
        production.services.db.volumes.find(
          (volume: { target: string }) =>
            volume.target === "/docker-entrypoint-initdb.d/01-orka.sh",
        ).source,
        resolve("deploy/ec2/init-db.sh"),
      );
      assert.equal(
        production.services.caddy.volumes.find(
          (volume: { target: string }) =>
            volume.target === "/etc/caddy/Caddyfile",
        ).source,
        resolve("deploy/ec2/Caddyfile"),
      );
      assert.deepEqual(production.services.admin.profiles, ["tools"]);
      assert.equal(production.services.dashboard, undefined);
      assert.equal(
        production.services.auth.environment.GOTRUE_DISABLE_SIGNUP,
        "true",
      );
      assert.equal(
        production.services.auth.environment.GOTRUE_EXTERNAL_GITHUB_ENABLED,
        "false",
      );
      const local = config(true);
      assert.equal(local.services.api.ports[0].host_ip, "127.0.0.1");
      assert.equal(local.services.api.environment.TRUST_PROXY, "false");
      assert.equal(
        local.services.api.environment.PUBLIC_URL,
        "http://127.0.0.1:8080",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

await test("local setup saves a custom port and rejects invalid hostnames and ports before writing configuration", async () => {
  const directory = await fixture();
  try {
    for (const args of [
      ["bad-.example"],
      ["-bad.example"],
      ["a".repeat(64) + ".example"],
      ["localhost", "--port", "70000"],
      ["localhost", "--port", "99999999999999"],
      ["localhost", "--port", "0"],
    ])
      assert.notEqual(
        spawnSync("sh", [resolve("configure.sh"), ...args], {
          cwd: directory,
          stdio: "ignore",
        }).status,
        0,
      );
    assert.equal(
      spawnSync(
        "sh",
        [resolve("configure.sh"), "localhost", "--port", "8181"],
        { cwd: directory, stdio: "ignore" },
      ).status,
      0,
    );
    const env = parseEnv(await readFile(join(directory, ".env"), "utf8"));
    assert.equal(env.ORKA_SERVER_MODE, "local");
    assert.equal(env.ORKA_LOCAL_PORT, "8181");
    assert.equal(env.COMPOSE_FILE, "compose.yml:deploy/local/compose.yml");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("the helper explains missing setup and gives help without Docker or credentials", async () => {
  const directory = await fixture();
  try {
    await copyFile("orka-server", join(directory, "orka-server"));
    const help = spawnSync("sh", ["./orka-server", "help"], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /setup --local --email/);
    const credentials = spawnSync("sh", ["./orka-server", "credentials"], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.notEqual(credentials.status, 0);
    assert.match(credentials.stderr, /No saved owner login/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
