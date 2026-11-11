import test from "node:test";
import assert from "node:assert/strict";
import { supportsPierreDiffs } from "../apps/mac/src/components/pierre-diffs-compat.js";

type Runtime = NonNullable<Parameters<typeof supportsPierreDiffs>[0]>;

function modernRuntime(): Runtime {
  class StyleSheet {
    replaceSync() {}
  }
  class ShadowRoot {}
  Object.defineProperty(ShadowRoot.prototype, "adoptedStyleSheets", {
    get: () => [],
  });
  return {
    CSS: { supports: () => true },
    CSSStyleSheet: StyleSheet,
    ShadowRoot,
    RegExp,
  } as unknown as Runtime;
}

await test("Pierre supports a runtime with all required features", () => {
  assert.equal(supportsPierreDiffs(modernRuntime()), true);
});

await test("Pierre is unavailable without browser APIs", () => {
  assert.equal(supportsPierreDiffs({} as Runtime), false);
});

await test("Pierre requires adopted stylesheets", () => {
  const runtime = modernRuntime();
  runtime.ShadowRoot = class {} as unknown as Runtime["ShadowRoot"];
  assert.equal(supportsPierreDiffs(runtime), false);
});

await test("Pierre checks stylesheet construction rather than just API presence", () => {
  const runtime = modernRuntime();
  runtime.CSSStyleSheet = class {
    constructor() {
      throw new TypeError("Illegal constructor");
    }
  } as unknown as Runtime["CSSStyleSheet"];
  assert.equal(supportsPierreDiffs(runtime), false);
});

await test("Pierre requires synchronous stylesheet replacement", () => {
  const runtime = modernRuntime();
  runtime.CSSStyleSheet = class {} as unknown as Runtime["CSSStyleSheet"];
  assert.equal(supportsPierreDiffs(runtime), false);
});

await test("Pierre rejects each unsupported layout or color feature", () => {
  const requiredValues = [
    "subgrid",
    "light-dark(white, black)",
    "color-mix(in lab, white, black)",
    "rgb(from #000 r g b / 0.2)",
    "1lh",
  ];
  for (const missing of requiredValues) {
    const runtime = modernRuntime();
    runtime.CSS = {
      supports: (_property: string, value: string) => value !== missing,
    } as Runtime["CSS"];
    assert.equal(supportsPierreDiffs(runtime), false, missing);
  }
});

await test("Pierre requires the default JavaScript regex engine features", () => {
  const runtime = modernRuntime();
  runtime.RegExp = class {
    constructor() {
      throw new SyntaxError("Unsupported regular expression");
    }
  } as unknown as Runtime["RegExp"];
  assert.equal(supportsPierreDiffs(runtime), false);
});
