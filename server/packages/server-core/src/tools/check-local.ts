import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";

const directory = pathToFileURL(resolve(".runtime/local") + "/");
const paths = (await readdir(directory)).filter((name) =>
  /^account-.*\.json$/.test(name),
);
let account: { service: string; email: string; password: string } | undefined;
for (const name of paths) {
  const path = new URL(name, directory);
  const candidate = JSON.parse(await readFile(path, "utf8")) as NonNullable<
    typeof account
  >;
  if (candidate.email === "contributor@example.test") {
    account = candidate;
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    break;
  }
}
assert.ok(
  account,
  "Create contributor@example.test with npm run local:user first.",
);
assert.equal(account.service, "http://127.0.0.1:8080");
assert.equal(
  (await stat(pathToFileURL(resolve(".env.local")))).mode & 0o777,
  0o600,
);

const config = JSON.parse(
  execFileSync(
    "docker",
    [
      "compose",
      "--project-name",
      process.env.ORKA_LOCAL_PROJECT ?? "orka-local",
      "--env-file",
      ".env.local",
      "-f",
      fileURLToPath(new URL("../../deploy/ec2/compose.yml", import.meta.url)),
      "-f",
      fileURLToPath(new URL("../../deploy/local/compose.yml", import.meta.url)),
      "config",
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  ),
) as {
  services: Record<
    string,
    {
      ports?: { host_ip?: string }[];
      volumes: { type: string; target: string }[];
    }
  >;
};
assert.equal(config.services.db.ports, undefined);
assert.equal(config.services.auth.ports, undefined);
assert.ok(
  config.services.api.ports?.every((port) => port.host_ip === "127.0.0.1"),
);
assert.ok(
  config.services.api.volumes.some(
    (volume) => volume.target === "/data/blobs" && volume.type === "volume",
  ),
);

const base = account.service;
assert.equal((await fetch(base + "/health")).status, 200);
assert.equal((await fetch(base + "/v2/projects")).status, 401);
for (const path of ["/auth/signup", "/auth/admin/users"])
  assert.equal((await fetch(base + path, { method: "POST" })).status, 404);

const login = await fetch(base + "/auth/token?grant_type=password", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: account.email, password: account.password }),
});
assert.equal(
  login.status,
  200,
  "The documented local account must be able to sign in.",
);
const session = (await login.json()) as {
  access_token: string;
  refresh_token: string;
};
assert.equal(
  (
    await fetch(base + "/v2/projects", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
  ).status,
  200,
);
const wrongPassword = await fetch(base + "/auth/token?grant_type=password", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: account.email,
    password: "intentionally-wrong",
  }),
});
assert.equal(wrongPassword.status, 400);
const refreshed = await fetch(base + "/auth/token?grant_type=refresh_token", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ refresh_token: session.refresh_token }),
});
assert.equal(refreshed.status, 200);
console.log(
  "Local onboarding passed: private files, loopback binding, sign-in, refresh, and authentication boundaries.",
);
