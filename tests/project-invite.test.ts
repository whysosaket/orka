import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProjectInvite,
  sameServiceUrl,
} from "../apps/mac/src/components/project-invite.js";

const token = "ab".repeat(24);

await test("project invites accept browser, desktop and legacy token formats", () => {
  assert.deepEqual(parseProjectInvite(` ${token} `), { token });
  assert.deepEqual(parseProjectInvite(`orka://join/${token}`), { token });
  for (const serviceUrl of [
    "https://api.tryorka.ai",
    "https://team.example:8443",
    "http://127.0.0.1:8080",
  ]) {
    assert.deepEqual(parseProjectInvite(`${serviceUrl}/join/${token}`), {
      token,
      serviceUrl,
    });
    assert.deepEqual(
      parseProjectInvite(
        `orka://join/${token}?server=${encodeURIComponent(serviceUrl)}`,
      ),
      { token, serviceUrl },
    );
  }
  assert.deepEqual(
    parseProjectInvite(`https://TEAM.example:443/join/${token}`),
    { token, serviceUrl: "https://team.example" },
  );
});

await test("invite parsing rejects ambiguous links, unsafe services and malformed tokens", () => {
  for (const input of [
    "",
    "bad-token",
    token.toUpperCase(),
    token + "a",
    `http://team.example/join/${token}`,
    `https://user:secret@team.example/join/${token}`,
    `https://team.example/nested/join/${token}`,
    `https://team.example/join/${token}?server=https://other.example`,
    `https://team.example/join/${token}#secret`,
    `orka://join/${token}/extra`,
    `orka://join/${token}?server=`,
    `orka://join/${token}?server=https://team.example&server=https://other.example`,
    `orka://join/${token}?profile=other`,
    `orka://join/${token}?server=${encodeURIComponent("https://team.example/path")}`,
    `orka://join/${token}?server=${encodeURIComponent("javascript:alert(1)")}`,
    `orka://join/${token}?server=${encodeURIComponent("https://user:secret@team.example")}`,
  ])
    assert.throws(() => parseProjectInvite(input), /valid Orka invite/);
});

await test("service comparisons normalize origins while retaining service boundaries", () => {
  assert.equal(
    sameServiceUrl("https://TEAM.example:443/", "https://team.example"),
    true,
  );
  for (const service of [
    "https://other.example",
    "http://team.example",
    "https://team.example/path",
    "https://team.example:8443",
    "not a URL",
  ])
    assert.equal(sameServiceUrl(service, "https://team.example"), false);
});
