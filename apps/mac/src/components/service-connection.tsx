import React from "react";
import type { ServiceMode } from "../types.js";
import { SegmentedControl } from "./segmented-control.js";
import { TextField } from "./text-field.js";

export function ServiceConnection({
  mode,
  url,
  busy,
  onModeChange,
  onUrlChange,
  showCloudUrl = true,
  showHelp = true,
}: {
  mode: ServiceMode;
  url: string;
  busy: boolean;
  onModeChange: (value: ServiceMode) => void;
  onUrlChange: (value: string) => void;
  showCloudUrl?: boolean;
  showHelp?: boolean;
}) {
  return (
    <div className="service-connection">
      <SegmentedControl
        label="Hosting mode"
        value={mode}
        options={[
          { value: "cloud", label: "Orka Cloud" },
          { value: "self-hosted", label: "Self-hosted" },
        ]}
        disabled={busy}
        onChange={onModeChange}
      />
      {showHelp && mode === "self-hosted" && (
        <p className="service-help">Connect to your own Orka server.</p>
      )}
      {(mode === "self-hosted" || showCloudUrl) && (
        <TextField
          label={
            mode === "cloud" ? "Cloud service URL" : "Self-hosted service URL"
          }
          required
          type="url"
          placeholder="https://orka.example.com"
          value={url}
          disabled={busy}
          onChange={(event) => onUrlChange(event.target.value)}
          autoCapitalize="none"
          spellCheck={false}
        />
      )}
    </div>
  );
}
