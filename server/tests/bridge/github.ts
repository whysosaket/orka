import type { Store } from "./store.js";
import type { GitHubSettings } from "../reference/github.js";
export { githubSettings } from "../reference/github.js";
export class GitHubRepositories {
  constructor(
    _store: Store,
    readonly settings: GitHubSettings,
    readonly fetcher: typeof fetch = fetch,
  ) {
    void _store;
  }
}
