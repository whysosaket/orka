import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export async function verifyDeployment(origin: string) {
  const get = async (path: string) => {
    const response = await fetch(new URL(path, origin), {
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      headers: { "Cache-Control": "no-cache" },
    });
    assert.ok(response.ok, `${path} returned ${response.status}`);
    return response.json();
  };
  await get("/health");
  const instance = await get("/v2/instance");
  assert.equal(instance.version, 1);
  assert.equal(instance.mode, "cloud");
  assert.equal(instance.auth?.github, true);
  assert.equal(instance.auth?.magicLink, true);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = parseEnv(readFileSync(process.argv[2], "utf8"));
  const origin = `https://${env.DOMAIN}`;
  for (let attempt = 1; ; attempt++) {
    try {
      await verifyDeployment(origin);
      console.log("Public HTTPS health and managed auth capabilities passed.");
      break;
    } catch (error) {
      if (attempt === 6) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
