import { startServer } from "@portable/server-core/runtime";
import { managedSettings } from "@portable/server-core/deployment";

await startServer(managedSettings());
