import { change } from "@portable/protocol";
import { governanceAction } from "./governance.js";
import { HttpError, type Store } from "./store.js";

// Automatic sharing is a device preference, not a grant of project access.
// Explicit snapshots use the same publication and review boundaries as sync.
export async function shareSelected(
  store: Store,
  user: string,
  input: unknown,
) {
  const selected = change.parse(input);
  if (selected.resource.deleted)
    throw new HttpError(400, "Select a snapshot to share, not a deletion");
  const review = async () => ({
    status: "approval_required" as const,
    request: await governanceAction(store, user, {
      action: "submit",
      input: { projectId: selected.projectId, change: selected },
    }),
  });
  // Keep retries on the review path even if publication access later changes.
  const pending = await store.pool.query(
    "select 1 from orka.review_requests where project_id=$1 and id=$2",
    [selected.projectId, selected.id],
  );
  if (pending.rowCount) return review();
  try {
    const receipt = await store.mutate(user, selected);
    return {
      status: receipt.conflict ? "conflict" : "published",
      receipt,
    };
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 403) throw error;
    return review();
  }
}
