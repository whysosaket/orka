// Development-only preview of the actual app screens. Never connects to Tauri or a service.
if (import.meta.env.DEV) {
  const step = new URLSearchParams(location.search).get("step") || "setup";
  const style = document.createElement("style");
  style.textContent = `
    .onboarding-preview-bar { height: 64px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 8px 16px; background: var(--surface-tertiary); font: 12px/18px 'Inter Variable', sans-serif; color: var(--text-secondary); }
    .onboarding-preview-bar strong { color: var(--text-primary); margin-right: 8px; }
    .onboarding-preview-bar a { padding: 6px 10px; border-radius: 8px; color: inherit; text-decoration: none; }
    .onboarding-preview-bar a:hover, .onboarding-preview-bar a[aria-current] { background: var(--interaction-hover); color: var(--text-primary); }
    .onboarding-preview-bar span { margin-left: auto; }
    #root { height: calc(100vh - 64px); }
    #root .sign-in, #root .app { height: 100%; min-height: 0; }
  `;
  document.head.append(style);
  const bar = document.createElement("nav");
  bar.className = "onboarding-preview-bar";
  bar.setAttribute("aria-label", "Onboarding preview screens");
  bar.innerHTML = `<strong>Onboarding preview</strong><a href="?step=setup">Service setup</a><a href="?step=signin">Sign in</a><a href="?step=project">First project</a><span>Preview only · No account or project changes</span>`;
  const links = bar.querySelectorAll("a");
  links[step === "signin" ? 1 : step === "project" ? 2 : 0].setAttribute(
    "aria-current",
    "page",
  );
  document.body.append(bar);
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  const snapshot = {
    user: step === "project" ? "preview" : null,
    config:
      step === "setup"
        ? null
        : { apiUrl: "https://preview.invalid", syncMinutes: 15 },
    projects: [],
    resources: [],
    bindings: [],
    conflicts: [],
    activity: [],
    outbox: [],
    errors: [],
    sync: null,
    daemon: null,
    devices: [],
    deviceId: "preview",
    background: null,
  };
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string) => {
        if (command === "snapshot") return snapshot;
        if (command === "plugin:deep-link|get_current") return [];
        if (command === "plugin:event|listen") return 1;
        if (command === "plugin:event|unlisten") return;
        throw new Error(
          "This is a visual preview. Use the screen tabs above to explore onboarding; no changes are saved.",
        );
      },
    },
  });
  void import("./main.js");
} else {
  document.body.textContent =
    "Onboarding preview is available in development only.";
}
export {};
