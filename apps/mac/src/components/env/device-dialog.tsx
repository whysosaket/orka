import type { Draft, ApprovalInfo } from "./api.js";
import { Button } from "../button.js";
import { Textarea } from "../textarea.js";
import type { EnvController } from "./use-environments.js";
export function DeviceApprovalDialog({ c }: { c: EnvController }) {
  const {
    project,
    setSelected,
    code,
    setCode,
    approvalInfo,
    setApprovalInfo,
    modal,
    setModal,
    busy,
    label,
    load,
    run,
    close,
    replaceDraft,
    published,
    env,
    setOrigin,
  } = c;
  if (!(modal === "approve" || modal === "accept")) return null;
  return (
    <>
      <p>
        {modal === "approve"
          ? "Paste the request received directly from your teammate or your other Mac. Confirm the account and device before approving."
          : "Paste the response returned by the trusted Mac that approved your request."}
      </p>
      <label>
        {modal === "approve" ? "Request code" : "Response code"}
        <Textarea
          autoFocus
          value={code}
          disabled={Boolean(busy)}
          onChange={(e) => {
            setCode(e.target.value);
            setApprovalInfo(null);
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {approvalInfo && (
        <div className="env-approval-review">
          <strong>{approvalInfo.device.name}</strong>
          <p>{label(approvalInfo.device.owner)}</p>
          <p>Only approve if this matches the person who sent you the code.</p>
        </div>
      )}
      <div className="dialog-actions">
        <Button size="sm" disabled={Boolean(busy)} onClick={close}>
          Cancel
        </Button>
        {modal === "approve" ? (
          approvalInfo ? (
            <Button
              size="sm"
              variant="primary"
              disabled={Boolean(busy)}
              onClick={() =>
                void run("Approving and re-encrypting…", async () => {
                  try {
                    await published(
                      await env("approve", { code: approvalInfo.code }),
                      "Device approved",
                    );
                  } finally {
                    await load();
                  }
                })
              }
            >
              Approve this device
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={Boolean(busy) || !code.trim()}
              onClick={() =>
                void run("Verifying request…", async () => {
                  const info = await env<ApprovalInfo>("approval_info", {
                    code,
                  });
                  if (info?.projectId !== project.id)
                    throw new Error(
                      "This request belongs to another project. Open that project first.",
                    );
                  setApprovalInfo({ ...info, code });
                })
              }
            >
              Review device
            </Button>
          )
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={Boolean(busy) || !code.trim()}
            onClick={() =>
              void run("Verifying trusted-device approval…", async () => {
                const d = await env<Draft>("accept", { code });
                if (d.projectId !== project.id) {
                  await env("discard", { draftId: d.draftId });
                  throw new Error(
                    "This approval belongs to another project. Open it there.",
                  );
                }
                setOrigin("pulled");
                await replaceDraft(d);
                setSelected(d.setId);
                setCode("");
                setModal(null);
                await load();
              })
            }
          >
            Verify and unlock
          </Button>
        )}
      </div>
    </>
  );
}
