import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { validateDeployment } from "../scripts/prepare-deployment.js";
import { verifyDeployment } from "../scripts/verify-deployment.js";

const commit = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const release = { tagName: "v0.2.1", isDraft: false, isPrerelease: false };
const manifest = {
  commit,
  repository: "https://github.com/whysosaket/orka-api",
};
const metadata = { "containerimage.digest": digest };

await test("deployment binds a stable published release to its commit and managed digest", () => {
  const validate = (
    changes: Partial<{
      tag: string;
      commit: string;
      version: string;
      release: typeof release;
      manifest: typeof manifest;
      metadata: typeof metadata;
    }> = {},
  ) =>
    validateDeployment(
      changes.tag ?? "v0.2.1",
      changes.commit ?? commit,
      changes.version ?? "0.2.1",
      changes.release ?? release,
      changes.manifest ?? manifest,
      changes.metadata ?? metadata,
      "whysosaket/orka-api",
    );
  assert.equal(validate(), `ghcr.io/whysosaket/orka-api@${digest}`);
  for (const changes of [
    { tag: "--help" },
    { tag: "v0.2.1; echo bad" },
    { version: "0.2.0" },
    { release: { ...release, isDraft: true } },
    { release: { ...release, isPrerelease: true } },
    { release: { ...release, tagName: "v0.2.0" } },
    { manifest: { ...manifest, commit: "c".repeat(40) } },
    { manifest: { ...manifest, repository: "https://github.com/other/repo" } },
    { metadata: { "containerimage.digest": "latest" } },
  ])
    assert.throws(() => validate(changes));
});

await test("deployment health rejects failed health, redirects and wrong auth capabilities", async () => {
  let scenario = "healthy";
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (scenario === "unhealthy") {
      response.writeHead(503).end("{}");
    } else if (scenario === "redirect") {
      response.writeHead(302, { Location: "/elsewhere" }).end();
    } else if (request.url === "/health") {
      response.end('{"ok":true}');
    } else {
      response.end(
        JSON.stringify({
          version: 1,
          mode: scenario === "oss" ? "self-hosted" : "cloud",
          auth: { github: true, magicLink: scenario !== "missing-email" },
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await verifyDeployment(origin);
    for (scenario of ["unhealthy", "redirect", "oss", "missing-email"])
      await assert.rejects(verifyDeployment(origin));
  } finally {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
});
