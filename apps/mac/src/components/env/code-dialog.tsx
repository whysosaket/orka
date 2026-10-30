import { Textarea } from "../textarea.js";
import { CopyLinkButton } from "../copy-link-button.js";
import { Button } from "../button.js";
import type { EnvController } from "./use-environments.js";
export function ApprovalCodeDialog({ c }: { c: EnvController }) {
  const { outputCode, modal, setError } = c;
  if (!(modal === "code")) return null;
  return (
    <>
      {outputCode.startsWith("ORKA-ENV-REQUEST") ? (
        <>
          <p>Request codes expire after 15 minutes.</p>
          <ol className="env-approval-steps">
            <li>Copy this request code.</li>
            <li>
              Send it directly to the set’s creator or your own trusted Mac.
              They choose “Approve a Mac” and verify your device.
            </li>
            <li>
              Return here and choose “Enter approval response” with the code
              they send back.
            </li>
          </ol>
        </>
      ) : (
        <p>
          Return this response through the same trusted channel. The recipient
          chooses “Enter approval response” to unlock their Mac. This response
          remains available here for 24 hours.
        </p>
      )}
      <Textarea aria-label="Approval code" readOnly value={outputCode} />
      <CopyLinkButton value={outputCode} label="Copy code" onError={setError} />
      {outputCode.startsWith("ORKA-ENV-REQUEST") && (
        <div className="dialog-actions">
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              c.setCode("");
              c.setOutputCode("");
              c.setModal("accept");
            }}
          >
            Enter approval response
          </Button>
        </div>
      )}
    </>
  );
}
