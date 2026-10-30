import { defineConfig } from "vite";

export default defineConfig({
  // Match the declared macOS 12 WebView baseline.
  build: { target: "safari15" },
});
