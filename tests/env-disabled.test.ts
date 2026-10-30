import test from "node:test";
import assert from "node:assert/strict";
import {
  ENV_ENABLED,
  visibleManagementLog,
  visibleRequest,
} from "../apps/mac/src/lib/features.js";
import { envCommand } from "../apps/mac/src/components/env/api.js";
import { permissionSections } from "../apps/mac/src/components/project-permissions.js";
import { sharingChoices } from "../apps/mac/src/components/project-sharing.js";

await test(
  "disabled ENV commands stop before the native bridge",
  { skip: ENV_ENABLED },
  async () => {
    for (const action of [
      "capabilities",
      "enable",
      "list",
      "import",
      "pull",
      "publish",
      "reveal",
      "preview",
      "apply",
      "approve",
      "request",
      "access",
      "retry",
      "discard",
    ])
      await assert.rejects(envCommand(action), /ENV support is disabled/);
  },
);

await test(
  "disabled ENV content is omitted without removing other sharing and permissions",
  { skip: ENV_ENABLED },
  () => {
    assert.deepEqual(
      sharingChoices.map(({ key }) => key),
      ["memory", "session", "plan", "skill"],
    );
    assert.deepEqual(
      permissionSections.map(({ id }) => id),
      ["memory", "skill", "plan", "session"],
    );
    assert.equal(visibleRequest({ requestedClass: "env" }), false);
    assert.equal(visibleRequest({ requestedClass: "skill" }), true);
    assert.equal(visibleRequest({}), true);
    assert.equal(visibleManagementLog({ action: "env.replaced" }), false);
    assert.equal(
      visibleManagementLog({ action: "permissions.updated", category: "env" }),
      false,
    );
    assert.equal(
      visibleManagementLog({ action: "request.approved", category: "skill" }),
      true,
    );
  },
);
