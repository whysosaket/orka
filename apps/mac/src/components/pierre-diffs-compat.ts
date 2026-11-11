type PierreRuntime = Pick<
  typeof globalThis,
  "CSS" | "CSSStyleSheet" | "ShadowRoot" | "RegExp"
>;

/**
 * Pierre 1.6.4 requires modern WebKit even though Orka supports macOS 12.
 * Detect the renderer's actual features, not the OS or browser user agent, so
 * older WebViews can offer Open in editor instead of mounting a broken diff.
 */
export function supportsPierreDiffs(
  runtime: PierreRuntime = globalThis,
): boolean {
  try {
    if (
      !runtime.CSS?.supports ||
      !runtime.ShadowRoot ||
      !("adoptedStyleSheets" in runtime.ShadowRoot.prototype)
    ) {
      return false;
    }

    const sheet = new runtime.CSSStyleSheet();
    sheet.replaceSync("");

    return (
      runtime.CSS.supports("grid-template-columns", "subgrid") &&
      runtime.CSS.supports("color", "light-dark(white, black)") &&
      runtime.CSS.supports("color", "color-mix(in lab, white, black)") &&
      runtime.CSS.supports("color", "rgb(from #000 r g b / 0.2)") &&
      runtime.CSS.supports("min-height", "1lh") &&
      new runtime.RegExp("(?<=a)b", "d").test("ab")
    );
  } catch {
    return false;
  }
}
