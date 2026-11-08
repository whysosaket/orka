import type { Locator } from "@playwright/test";

export async function setSharingMode(control: Locator, automatic: boolean) {
  await control.click();
  await control
    .page()
    .getByRole("option", {
      name: automatic ? "Share automatically" : "Only when asked",
      exact: true,
    })
    .click();
}
