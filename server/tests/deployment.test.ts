import test from "node:test";
import assert from "node:assert/strict";
import {
  ossSettings,
  managedSettings,
} from "../packages/server-core/src/deployment.js";

await test("OSS starts without cloud secrets; managed composition requires its email configuration", () => {
  const oss = ossSettings({ DEPLOYMENT_MODE: "cloud" });
  assert.equal(oss.mode, "self-hosted");
  assert.equal(oss.github, false);
  assert.equal(oss.password, true);
  assert.throws(() => managedSettings({}), /PUBLIC_URL|Resend/);
  const managed = managedSettings({
    PUBLIC_URL: "https://api.tryorka.ai",
    RESEND_API_KEY: "re_fixture",
    RESEND_FROM: "Orka <login@example.test>",
    SEND_EMAIL_HOOK_SECRET: "fixture",
    PASSWORD_ENABLED: "false",
    GITHUB_ENABLED: "false",
  });
  assert.equal(managed.mode, "cloud");
  assert.equal(managed.github, true);
  assert.equal(managed.magicLink, true);
  assert.equal(managed.password, false);
});
