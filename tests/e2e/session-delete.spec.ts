import { expect, test } from "@playwright/test";

test("new chat can be created and deleted from sidebar context menu", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "New Chat" }).click();

  const selectedRow = page.locator(".session-row.selected").first();
  await expect(selectedRow).toBeVisible();
  const sessionId = await selectedRow.getAttribute("data-session-id");
  expect(sessionId).toBeTruthy();

  await selectedRow.hover();
  await selectedRow.getByLabel(/Open actions for/).first().click({ force: true });
  await expect(page.getByRole("menuitem", { name: "Delete Permanently" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("menuitem", { name: "Delete Permanently" }).click();

  await expect(page.locator(`.session-row[data-session-id=\"${sessionId}\"]`)).toHaveCount(0);
});
