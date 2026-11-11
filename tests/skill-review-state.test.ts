import test from "node:test";
import assert from "node:assert/strict";
import type { LocalDraft, ProjectResource } from "../apps/mac/src/types.js";
import { skillDraft } from "../apps/mac/src/components/skill-review-state.js";

const resource = {
  resourceId: "skill",
  projectId: "project",
} as ProjectResource;
const draft = (
  id: string,
  createdAt: string,
  status = "local",
): LocalDraft => ({
  id,
  projectId: resource.projectId,
  resource,
  status,
  createdAt,
});

await test("skill review selects the newest capture independently of snapshot order", () => {
  const older = draft("older", "2026-11-10T10:00:00.000Z");
  const latest = draft("latest", "2026-11-11T10:00:00.000Z");
  for (const drafts of [
    [older, latest],
    [latest, older],
  ]) {
    const order = [...drafts];
    assert.equal(skillDraft({ drafts }, resource)?.id, latest.id);
    assert.deepEqual(drafts, order);
  }
});

await test("newer pending or completed captures do not expose older local edits", () => {
  const older = draft("older", "2026-11-10T10:00:00.000Z");
  for (const status of ["proposed", "published", "dismissed"]) {
    const latest = draft("latest", "2026-11-11T10:00:00.000Z", status);
    assert.equal(
      skillDraft({ drafts: [older, latest] }, resource)?.id,
      status === "proposed" ? latest.id : undefined,
    );
  }
});

await test("recapturing earlier content makes it current without changing its creation date", () => {
  const earlier = {
    ...draft("earlier", "2026-11-10T10:00:00.000Z"),
    updatedAt: "2026-11-11T11:00:00.000Z",
  };
  const later = draft("later", "2026-11-11T10:00:00.000Z");
  assert.equal(
    skillDraft({ drafts: [later, earlier] }, resource)?.id,
    earlier.id,
  );
});

await test("captures from other resources and projects do not supersede this skill", () => {
  const selected = draft("selected", "2026-11-10T10:00:00.000Z");
  const unrelated = draft("unrelated", "2026-11-11T10:00:00.000Z");
  assert.equal(
    skillDraft(
      {
        drafts: [
          selected,
          {
            ...unrelated,
            resource: { ...resource, resourceId: "another-skill" },
          },
          { ...unrelated, projectId: "another-project" },
        ],
      },
      resource,
    )?.id,
    selected.id,
  );
});
