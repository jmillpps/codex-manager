import { expect, test } from "@playwright/test";

test("suggested reply response does not overwrite draft after switching sessions", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "New Chat", exact: true }).click();
  const firstSessionId = await page.locator(".session-row.selected").first().getAttribute("data-session-id");
  expect(firstSessionId).toBeTruthy();

  await page.getByRole("button", { name: "New Chat", exact: true }).click();
  await expect
    .poll(async () => page.locator(".session-row.selected").first().getAttribute("data-session-id"))
    .not.toBe(firstSessionId);
  const secondSessionId = await page.locator(".session-row.selected").first().getAttribute("data-session-id");
  expect(secondSessionId).toBeTruthy();
  expect(secondSessionId).not.toBe(firstSessionId);

  const textarea = page.locator(".composer textarea");
  await page.locator(`.session-row[data-session-id="${firstSessionId}"]`).first().click();
  await textarea.fill("draft for session A");

  await page.route("**/api/sessions/*/suggested-reply", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        sessionId: firstSessionId,
        suggestion: "SUGGESTED REPLY SHOULD NOT OVERWRITE SESSION B"
      })
    });
  });

  await page.getByRole("button", { name: "Suggest Reply" }).click();
  await page.locator(`.session-row[data-session-id="${secondSessionId}"]`).first().click();
  await textarea.fill("draft for session B");

  await expect(textarea).toHaveValue("draft for session B");
  await page.waitForTimeout(1200);
  await expect(textarea).toHaveValue("draft for session B");
});
