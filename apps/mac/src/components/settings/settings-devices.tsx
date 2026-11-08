import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Snapshot } from "../../types.js";
import { Button } from "../button.js";
import { LoadingRegion } from "../loading-region.js";
import { SettingsHeading } from "./settings-shared.js";
import { useSettingsQuery } from "./use-settings-query.js";

type Devices = NonNullable<Snapshot["devices"]>;
const samples: Devices = [
  {
    id: "sample-one",
    name: "Morgan’s MacBook Pro",
    seen_at: "2026-11-03T09:30:00Z",
    hardwareFamily: "laptop",
  },
  {
    id: "sample-two",
    name: "Studio Mac",
    seen_at: "2026-11-02T12:45:00Z",
    hardwareFamily: "mac-studio",
  },
];
const families = new Set([
  "laptop",
  "all-in-one",
  "mac-mini",
  "mac-studio",
  "mac-pro",
]);
export function DeviceRows({
  devices,
  deviceId,
  localHardwareFamily,
}: {
  devices: Devices;
  deviceId: string;
  localHardwareFamily?: string | null;
}) {
  return (
    <ul className="settings-group settings-device-list">
      {devices.map((device) => {
        const family =
          device.id === deviceId && families.has(localHardwareFamily ?? "")
            ? localHardwareFamily
            : device.hardwareFamily;
        return (
          <li className="settings-device-row" key={device.id}>
            <img
              src={`/devices/${families.has(family ?? "") ? family : "generic"}.png`}
              width={48}
              height={48}
              alt=""
              loading="lazy"
            />
            <div>
              <div className="settings-identity-name">
                <strong>{device.name?.trim() || "Unnamed Mac"}</strong>
                {device.id === deviceId && (
                  <span className="settings-device-label">This Mac</span>
                )}
              </div>
              <p>
                Last seen{" "}
                {device.seen_at && Number.isFinite(Date.parse(device.seen_at))
                  ? new Date(device.seen_at).toLocaleString()
                  : "unavailable"}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
export function SettingsDeviceScreen({ state }: { state: Snapshot }) {
  const user = state.user,
    service = state.config?.apiUrl;
  const load = useCallback(async () => {
    const devices = await invoke<Devices>("settings_command", {
      action: "devices",
      context: { user, service },
    });
    if (!Array.isArray(devices))
      throw new Error("The service returned an invalid device list.");
    return devices;
  }, [user, service]);
  const query = useSettingsQuery(
    load,
    Array.isArray(state.devices) ? state.devices : null,
    JSON.stringify(state.devices),
  );
  return (
    <>
      <SettingsHeading
        title="Devices"
        description="Macs registered to your account."
      />
      <LoadingRegion
        id="settings-devices"
        label="Loading registered Macs…"
        data={query.data}
        sample={samples}
        loading={!query.data && query.loading}
        empty={query.data?.length === 0}
        emptyMessage={<p>No Macs are registered to your account.</p>}
        error={
          !query.data && query.error ? (
            <p role="alert">
              Registered Macs are unavailable.{" "}
              <Button size="sm" onClick={() => void query.refresh()}>
                Retry
              </Button>
            </p>
          ) : undefined
        }
      >
        {(devices) => (
          <DeviceRows
            devices={devices}
            deviceId={state.deviceId}
            localHardwareFamily={state.localHardwareFamily}
          />
        )}
      </LoadingRegion>
      {query.error && query.data && (
        <p role="alert">
          Couldn’t refresh registered Macs.{" "}
          <Button size="sm" onClick={() => void query.refresh()}>
            Retry
          </Button>
        </p>
      )}
      {query.extended && (
        <p>Still checking registered Macs. You can use the other settings.</p>
      )}
    </>
  );
}
