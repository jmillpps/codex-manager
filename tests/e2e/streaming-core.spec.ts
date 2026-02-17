import { expect, test } from "@playwright/test";

test("message can be sent and transcript updates", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "New Chat" }).click();
  const prompt = `Reply with exactly OK ${Date.now()}`;
  const textarea = page.getByPlaceholder("Type your message...");
  await textarea.fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();

  const transcript = page.locator(".chat-transcript-inner");
  await expect(transcript.locator("article.bubble.user pre").last()).toHaveText(prompt);
  await expect(page.getByRole("button", { name: /Chat \(/ })).toBeVisible();
});

test("active turn returns to idle and does not stay in working state", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "New Chat" }).click();
  const prompt = `Return exactly OK ${Date.now()}`;
  const textarea = page.getByPlaceholder("Type your message...");
  await textarea.fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();

  const transcript = page.locator(".chat-transcript-inner");
  await expect(transcript.locator("article.bubble.user pre").last()).toHaveText(prompt);
  await expect(transcript.locator(".turn-group").last().locator(".response-body pre")).toContainText("OK", {
    timeout: 120_000
  });
  await expect(page.locator(".state-pill")).toHaveText("Idle", { timeout: 120_000 });

  const latestTurn = transcript.locator(".turn-group").last();
  await expect(latestTurn.locator(".response-card.streaming")).toHaveCount(0);
  const thoughtSummary = latestTurn.locator(".response-thought-summary");
  if ((await thoughtSummary.count()) > 0) {
    await expect(thoughtSummary.first()).not.toContainText("Working");
  }

  await page.reload();
  await expect(page.locator(".state-pill")).toHaveText("Idle", { timeout: 120_000 });
  const latestTurnAfterReload = page.locator(".chat-transcript-inner .turn-group").last();
  await expect(latestTurnAfterReload.locator(".response-card.streaming")).toHaveCount(0);
  const thoughtSummaryAfterReload = latestTurnAfterReload.locator(".response-thought-summary");
  if ((await thoughtSummaryAfterReload.count()) > 0) {
    await expect(thoughtSummaryAfterReload.first()).not.toContainText("Working");
  }
});
