import type { ProjectResource } from "../types.js";

const states = {
  local: {
    label: "On this Mac",
    message: "This skill is on this Mac and hasn’t been shared.",
    reviewable: true,
  },
  queued: {
    label: "Sharing queued",
    message:
      "This skill will share automatically when permissions allow. Sync retries while offline.",
    reviewable: false,
  },
  approval: {
    label: "Awaiting approval",
    message:
      "Project permissions require approval before this skill can be shared.",
    reviewable: true,
  },
  paused: {
    label: "Sharing paused",
    message:
      "Skills sharing is off on this Mac. The import will resume when sharing is enabled.",
    reviewable: false,
  },
  blocked: {
    label: "Sharing blocked",
    message:
      "This skill is on this Mac. Check the sync issue before retrying sharing.",
    reviewable: true,
  },
};

export const skillSharing = (resource: ProjectResource) =>
  states[resource.sharing ?? "local"];
