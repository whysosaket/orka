import { command } from "./command.js";

export type AuthSettings = {
  mode: "cloud" | "self-hosted";
  password: boolean;
  github: boolean;
  magicLink: boolean;
  emailProvider: "smtp" | "resend";
  publicUrl: string;
  trustProxy: boolean;
};

export const authSettings = (environment: NodeJS.ProcessEnv = process.env) =>
  command<AuthSettings>("auth-settings", { environment });
