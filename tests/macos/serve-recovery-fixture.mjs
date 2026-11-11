import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";

const [work, port = "38477", firstVersion = "0.3.1", hotfixVersion = "0.3.2"] =
  process.argv.slice(2);
assert(work, "Pass the isolated signed-drill directory");
const downloads = join(work, "downloads");
const key = createPrivateKey(readFileSync(join(work, "feed-key.pem")));
const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
const makeRelease = (version) => {
  const filename = `Orka-${version}.zip`;
  const archive = readFileSync(join(downloads, filename));
  return {
    version,
    notes: "Recovery acceptance fixture",
    url: `https://127.0.0.1:${port}/${filename}`,
    sha256: createHash("sha256").update(archive).digest("hex"),
    size: archive.length,
    architectures: [architecture],
    minimumMacOS: "12.0.0",
    dataEpoch: 1,
  };
};
const first = makeRelease(firstVersion);
const hotfix = makeRelease(hotfixVersion);
const policy = (sequence, release, withdrawn = []) => {
  const payload = Buffer.from(
    JSON.stringify({
      schema: 1,
      sequence,
      expires: Math.floor(Date.now() / 1000) + 900,
      minimumVersion: "0.3.0",
      release,
      withdrawn,
    }),
  );
  return JSON.stringify({
    payload: payload.toString("base64"),
    signature: sign(null, payload, key).toString("base64"),
  });
};
const manifest = join(downloads, "macos.json");
writeFileSync(manifest, policy(1, first));
writeFileSync(
  join(downloads, "hotfix.json"),
  policy(3, hotfix, [first.version]),
);
const revoke = join(downloads, "revoke-after-download");
const corrupt = join(downloads, "corrupt-download");
const paths = new Set([
  "/macos.json",
  `/Orka-${firstVersion}.zip`,
  `/Orka-${hotfixVersion}.zip`,
]);
createServer(
  {
    key: readFileSync(join(work, "tls-key.pem")),
    cert: readFileSync(join(work, "tls.pem")),
  },
  (req, res) => {
    const pathname = new URL(req.url ?? "/", "https://127.0.0.1").pathname;
    const path = join(downloads, pathname);
    if (!paths.has(pathname) || !existsSync(path))
      return res.writeHead(404).end();
    const bytes = readFileSync(path);
    if (pathname === `/Orka-${firstVersion}.zip`) {
      if (existsSync(revoke)) {
        unlinkSync(revoke);
        writeFileSync(manifest, policy(2, null, [first.version]));
      }
      if (existsSync(corrupt)) {
        unlinkSync(corrupt);
        bytes[0] ^= 0xff;
      }
    }
    res.writeHead(200, { "Content-Length": bytes.length }).end(bytes);
  },
).listen(Number(port), "127.0.0.1", () =>
  console.log("Recovery HTTPS fixture ready"),
);
