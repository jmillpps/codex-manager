import { expect, test } from "@playwright/test";

test("sidebar renders projects and your chats sections", async ({ page }) => {
  await page.goto("/");

  const projectsToggle = page.locator(".session-section-toggle", { hasText: "Projects" }).first();
  const chatsToggle = page.locator(".session-section-toggle", { hasText: "Your chats" }).first();

  await expect(projectsToggle).toBeVisible();
  await expect(chatsToggle).toBeVisible();

  await expect(projectsToggle).toHaveAttribute("aria-expanded", "true");
  await projectsToggle.click();
  await expect(projectsToggle).toHaveAttribute("aria-expanded", "false");
  await projectsToggle.click();
  await expect(projectsToggle).toHaveAttribute("aria-expanded", "true");

  await expect(page.getByRole("button", { name: "New Chat", exact: true })).toBeVisible();
});
