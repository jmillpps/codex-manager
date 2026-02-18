import { expect, test } from "@playwright/test";

test("transcript filter bar is removed", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("tablist", { name: "Transcript filter" })).toHaveCount(0);
  await expect(page.locator(".filter-group")).toHaveCount(0);
});
