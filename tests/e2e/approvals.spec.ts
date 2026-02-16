import { expect, test } from "@playwright/test";

test("transcript filter bar renders approvals tab", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: /All \(/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Chat \(/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Tools \(/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Approvals \(/ })).toBeVisible();
});
