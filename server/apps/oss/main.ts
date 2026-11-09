import { startServer } from "@portable/server-core/runtime";
import { ossSettings } from "@portable/server-core/deployment";

await startServer(ossSettings());
