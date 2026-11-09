import { authSettings } from "./auth.js";

export function ossSettings(env: NodeJS.ProcessEnv = process.env) {
  return authSettings({ ...env, DEPLOYMENT_MODE: "self-hosted" });
}

export function managedSettings(env: NodeJS.ProcessEnv = process.env) {
  return authSettings({
    ...env,
    DEPLOYMENT_MODE: "cloud",
    GITHUB_ENABLED: "true",
    MAGIC_LINK_ENABLED: "true",
    EMAIL_PROVIDER: "resend",
  });
}
