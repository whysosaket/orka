import { invoke } from "@tauri-apps/api/core";
import { ENV_ENABLED } from "../../lib/features.js";
import type {
  EnvDevice,
  EnvManifest,
  EnvMember,
  EnvSet,
} from "@portable/protocol";
export interface Draft {
  draftId: string;
  projectId: string;
  sourceId?: string | null;
  setId: string;
  keys: string[];
  revision: number | null;
  manifest: EnvManifest | null;
}
export interface Listing {
  canCreate?: boolean;
  sets: (EnvSet & { trusted?: boolean })[];
  members: EnvMember[];
  device: EnvDevice;
  pending: { id: string; setId: string; name: string }[];
  responses?: { code: string; device: string }[];
}
export interface Preview {
  path: string;
  ignored: boolean;
  keys: { key: string; change: string }[];
}
export interface Comparison {
  key: string;
  local: boolean;
  remote: boolean;
  changed: boolean;
}
export interface ApprovalInfo {
  device: EnvDevice;
  projectId: string;
  setId: string;
}

let queue: Promise<unknown> = Promise.resolve();
export function envCommand<T>(
  action: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  if (!ENV_ENABLED && action !== "clear")
    return Promise.reject(new Error("ENV support is disabled"));
  const result = queue.then(() => invoke<T>("env_command", { action, input }));
  queue = result.catch(() => {});
  return result;
}
