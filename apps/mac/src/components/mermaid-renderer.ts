import type { Mermaid } from "mermaid";

let runtime: Promise<Mermaid> | undefined;
let pending: Promise<unknown> = Promise.resolve();
let nextId = 0;
const MAX_SOURCE_LENGTH = 50_000;

function loadMermaid() {
  runtime ??= import("mermaid")
    .then(({ default: mermaid }) => {
      const styles = getComputedStyle(document.documentElement);
      const token = (name: string) => styles.getPropertyValue(name).trim();
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        maxTextSize: MAX_SOURCE_LENGTH,
        maxEdges: 500,
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        theme: "base",
        look: "classic",
        fontFamily: getComputedStyle(document.body).fontFamily,
        themeVariables: {
          darkMode: true,
          dropShadow: "none",
          background: token("--surface-secondary"),
          primaryColor: token("--surface-tertiary"),
          primaryTextColor: token("--text-primary"),
          primaryBorderColor: token("--surface-stroke"),
          secondaryColor: token("--surface-secondary"),
          tertiaryColor: token("--surface-tertiary"),
          lineColor: token("--text-secondary"),
          textColor: token("--text-primary"),
        },
        // Synced document directives cannot weaken the host's rendering policy.
        secure: [
          "secure",
          "securityLevel",
          "startOnLoad",
          "suppressErrorRendering",
          "maxTextSize",
          "maxEdges",
          "htmlLabels",
          "flowchart",
          "theme",
          "themeVariables",
          "themeCSS",
          "fontFamily",
          "look",
        ],
      });
      return mermaid;
    })
    .catch((error: unknown) => {
      runtime = undefined;
      throw error;
    });
  return runtime;
}

/** Mermaid has shared configuration and temporary DOM, so render one graph at a time. */
export function renderMermaid(source: string): Promise<string> {
  if (source.length > MAX_SOURCE_LENGTH)
    return Promise.reject(new Error("Diagram is too large"));
  const result = pending.then(async () => {
    const mermaid = await loadMermaid();
    const container = document.createElement("div");
    container.className = "mermaid-measure";
    container.setAttribute("aria-hidden", "true");
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(
        `orka-diagram-${++nextId}`,
        source,
        container,
      );
      // Strict-mode rendering sanitizes SVG, but can still emit link markup.
      // Keep diagrams read-only and retain the reader's no-embedded-images rule.
      const document = new DOMParser().parseFromString(svg, "image/svg+xml");
      if (document.querySelector("parsererror"))
        throw new Error("Invalid diagram SVG");
      document.querySelectorAll("a").forEach((link) => {
        link.replaceWith(...Array.from(link.childNodes));
      });
      document
        .querySelectorAll("script, foreignObject, image")
        .forEach((node) => node.remove());
      document.querySelectorAll("*").forEach((node) => {
        node.classList.remove("clickable");
        for (const attribute of Array.from(node.attributes)) {
          if (/^on/i.test(attribute.name) || attribute.name === "tabindex")
            node.removeAttribute(attribute.name);
        }
      });
      // Do not install Mermaid's optional diagram click handlers.
      return new XMLSerializer().serializeToString(document.documentElement);
    } finally {
      container.remove();
    }
  });
  pending = result.catch(() => {});
  return result;
}
