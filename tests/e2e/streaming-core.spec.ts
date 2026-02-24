import { expect, test } from "@playwright/test";

test("message can be sent and transcript updates", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "New Chat" }).click();
  const nonce = Date.now();
  const prompt = `Reply with exactly OK ${nonce}`;
  const textarea = page.getByPlaceholder("Type your message...");
  await textarea.fill(prompt);
  await page.locator(".composer").getByRole("button", { name: "Send", exact: true }).click();

  const transcript = page.locator(".chat-transcript-inner");
  const latestTurnBeforeIdle = transcript.locator(".turn-group").last();
  await expect(latestTurnBeforeIdle).toContainText(`OK ${nonce}`);
  await expect(page.locator(".chat-transcript-inner .turn-group")).not.toHaveCount(0);
});

test("active turn returns to idle and does not stay in working state", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "New Chat" }).click();
  const nonce = Date.now();
  const prompt = `Return exactly OK ${nonce}`;
  const textarea = page.getByPlaceholder("Type your message...");
  await textarea.fill(prompt);
  await page.locator(".composer").getByRole("button", { name: "Send", exact: true }).click();

  const transcript = page.locator(".chat-transcript-inner");
  const latestTurnBeforeIdle = transcript.locator(".turn-group").last();
  await expect(latestTurnBeforeIdle).toContainText(`OK ${nonce}`);
  await expect
    .poll(
      async () => {
        const state = (await page.locator(".state-pill").textContent())?.trim();
        const disconnectedOverlayVisible = await page.locator(".chat-disconnected-overlay").isVisible().catch(() => false);
        const hasStreamingCard = (await transcript.locator(".turn-group").last().locator(".response-card.streaming").count()) > 0;
        return {
          state,
          disconnectedOverlayVisible,
          hasStreamingCard
        };
      },
      {
        timeout: 120_000
      }
    )
    .toEqual(
      expect.objectContaining({
        hasStreamingCard: false
      })
    );

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
