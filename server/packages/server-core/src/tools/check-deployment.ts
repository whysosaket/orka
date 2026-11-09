import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { authSettings } from "../auth.js";
import { memorySettings } from "../jev.js";

const [file, edition] = process.argv.slice(2);
if (!file)
  throw new Error("Usage: npm run deploy:check -- deploy/ec2/.env [--cloud]");
const env = parseEnv(await readFile(file, "utf8"));
const cloud = edition === "--cloud" || env.DEPLOYMENT_MODE === "cloud";
const fail = (message: string): never => {
  throw new Error(message);
};
const domain = env.DOMAIN ?? "";
if (
  !/^[a-zA-Z0-9.-]+$/.test(domain) ||
  domain.includes("example.") ||
  domain === "localhost"
)
  fail("Set DOMAIN to the public hostname or stable public IP");
const passwords = [
  "POSTGRES_PASSWORD",
  "AUTH_DB_PASSWORD",
  "API_DB_PASSWORD",
].map((key) => {
  const value = env[key] ?? "";
  if (!/^[a-f0-9]{48,}$/i.test(value))
    fail(`${key} must contain at least 24 random hex bytes`);
  return value;
});
if (new Set(passwords).size !== passwords.length)
  fail("Use separate database passwords for each role");
if (!/^[a-f0-9]{64,}$/i.test(env.JWT_SECRET ?? ""))
  fail("JWT_SECRET must contain at least 32 random hex bytes");
if (cloud)
  Object.assign(env, {
    DEPLOYMENT_MODE: "cloud",
    GITHUB_ENABLED: "true",
    MAGIC_LINK_ENABLED: "true",
    EMAIL_PROVIDER: "resend",
    RESEND_ENABLED: "true",
  });
const settings = authSettings({ ...env, PUBLIC_URL: `https://${domain}` });
const memory = memorySettings(env);
if (memory.enabled && !memory.apiKey)
  fail(
    "Set JEV_API_KEY (or TYPESAFE_API_KEY), or MEMORY_JEV_ENABLED=false to defer memory replacements",
  );
if (settings.github && (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET))
  fail("Configure the GitHub OAuth App client ID and secret");
if ((env.RESEND_ENABLED === "true") !== (settings.emailProvider === "resend"))
  fail("EMAIL_PROVIDER=resend and RESEND_ENABLED=true must be set together");
if (settings.emailProvider === "resend") {
  if (!/^v1,whsec_[A-Za-z0-9+/]{43}=$/.test(env.SEND_EMAIL_HOOK_SECRET ?? ""))
    fail(
      "Generate SEND_EMAIL_HOOK_SECRET as v1,whsec_ followed by 32 base64-encoded random bytes",
    );
  if (!env.RESEND_API_KEY?.startsWith("re_"))
    fail("Set a Resend API key with sending permission");
  if (!env.RESEND_FROM?.includes("@"))
    fail("Set RESEND_FROM to a verified sender");
}
if (
  settings.magicLink &&
  settings.emailProvider === "smtp" &&
  (!env.SMTP_HOST || !env.SMTP_FROM)
)
  fail("Magic links need SMTP configuration or Resend");
console.log(
  `Configuration valid for ${settings.mode}. Provider credentials and sender verification still require a live sign-in smoke test.`,
);
console.log(`GitHub callback: https://${domain}/auth/callback`);
console.log("Desktop redirect: orka://auth/callback");
