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
