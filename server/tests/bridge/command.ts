import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export function command<T>(method: string, input: unknown = {}): T {
  const output = execFileSync(
    process.env.ORKA_GO_TEST_BIN ?? resolve("artifacts/bin/orka-test-server"),
    [method],
    { input: JSON.stringify(input), encoding: "utf8" },
  );
  const value = JSON.parse(output) as { result: T; error?: string };
  if (value.error) throw new Error(value.error);
  return value.result;
}
