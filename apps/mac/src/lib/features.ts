import features from "../features.json" with { type: "json" };
import type { ManagementLog, ReviewRequest } from "@portable/protocol";

export const ENV_ENABLED = features.env;

export const visibleRequest = (
  request: Pick<ReviewRequest, "requestedClass">,
) => ENV_ENABLED || request.requestedClass !== "env";

export const visibleManagementLog = (
  entry: Pick<ManagementLog, "category" | "action">,
) =>
  ENV_ENABLED || (entry.category !== "env" && entry.action !== "env.replaced");
