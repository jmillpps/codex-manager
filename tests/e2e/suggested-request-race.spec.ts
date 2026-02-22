import { expect, test } from "@playwright/test";

test("suggested request response does not overwrite draft after switching sessions", async ({ page, request }) => {
  const apiBase = "http://127.0.0.1:3001/api";
  const suffix = Date.now();
  const firstTitle = `race-a-${suffix}`;
  const secondTitle = `race-b-${suffix}`;
  let firstSessionId: string | null = null;
  let secondSessionId: string | null = null;

  const createNamedSession = async (title: string): Promise<string> => {
    const createResponse = await request.post(`${apiBase}/sessions`, {
      data: {}
    });
    expect(createResponse.ok()).toBeTruthy();
    const createPayload = (await createResponse.json()) as { session?: { sessionId?: string } };
    const sessionId = createPayload.session?.sessionId;
    expect(sessionId).toBeTruthy();

    const renameResponse = await request.post(`${apiBase}/sessions/${encodeURIComponent(sessionId as string)}/rename`, {
      data: { title }
    });
    expect(renameResponse.ok()).toBeTruthy();
    return sessionId as string;
  };

  firstSessionId = await createNamedSession(firstTitle);
  secondSessionId = await createNamedSession(secondTitle);

  await page.goto("/");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();

  await page.getByRole("button", { name: firstTitle, exact: true }).click();
  const textarea = page.locator(".composer textarea");
  await textarea.fill("draft for session A");

  await page.route("**/api/sessions/*/suggested-request/jobs", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        status: "queued",
        jobId: "race-job-1",
        sessionId: firstSessionId,
        projectId: `session:${firstSessionId ?? "unknown"}`,
        dedupe: "enqueued"
      })
    });
  });

  await page.getByRole("button", { name: "Suggest Request" }).click();
  await page.getByRole("button", { name: secondTitle, exact: true }).click();
  await textarea.fill("draft for session B");

  await expect(textarea).toHaveValue("draft for session B");
  await page.waitForTimeout(1200);
  await expect(textarea).toHaveValue("draft for session B");

  if (firstSessionId) {
    await request.delete(`${apiBase}/sessions/${encodeURIComponent(firstSessionId)}`);
  }
  if (secondSessionId) {
    await request.delete(`${apiBase}/sessions/${encodeURIComponent(secondSessionId)}`);
  }
});
