import { addProjectSources } from "@portable/protocol";
import type { Store } from "./store.js";

export const addSources = (store: Store, user: string, input: unknown) =>
  store.invoke("addSources", { user, input: addProjectSources.parse(input) });
