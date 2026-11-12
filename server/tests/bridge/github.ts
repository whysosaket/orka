import type { Store } from "./store.js";
import { command } from "./command.js";

type GitHubSettings = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  appSlug: string;
  encryptionKey: Buffer;
  webhookSecret: string;
};

export function githubSettings(environment: NodeJS.ProcessEnv): GitHubSettings {
  const settings = command<
    Omit<GitHubSettings, "encryptionKey"> & { encryptionKey: string | null }
  >("github-settings", { environment });
  return {
    ...settings,
    encryptionKey: Buffer.from(settings.encryptionKey ?? "", "base64"),
  };
}
export class GitHubRepositories {
  constructor(
    _store: Store,
    readonly settings: GitHubSettings,
    readonly fetcher: typeof fetch = fetch,
  ) {
    void _store;
  }
}
