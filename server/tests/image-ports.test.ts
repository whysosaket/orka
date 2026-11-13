import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { reserveImagePorts } from "./acceptance/image-ports.js";

const listen = (server: Server, port: number) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
const close = (server: Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

await test("image port allocation skips occupied API/mail ports and parallel leases", async () => {
  const initial = await reserveImagePorts();
  const api = createServer(),
    mail = createServer();
  const leases: Awaited<ReturnType<typeof reserveImagePorts>>[] = [initial];
  try {
    await listen(api, initial.port);
    initial.release();
    const apiBlocked = await reserveImagePorts(initial.port);
    leases.push(apiBlocked);
    assert.notEqual(apiBlocked.port, initial.port);
    await close(api);
    await listen(mail, initial.mailPort);
    const mailBlocked = await reserveImagePorts(initial.port);
    leases.push(mailBlocked);
    assert.notEqual(mailBlocked.port, initial.port);
    const parallel = await Promise.all([
      reserveImagePorts(initial.port),
      reserveImagePorts(initial.port),
    ]);
    leases.push(...parallel);
    assert.notEqual(parallel[0].port, parallel[1].port);
  } finally {
    if (api.listening) await close(api);
    if (mail.listening) await close(mail);
    for (const lease of leases) lease.release();
  }
});
