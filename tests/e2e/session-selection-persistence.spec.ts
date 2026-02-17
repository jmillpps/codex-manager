import { expect, test } from "@playwright/test";

test("selected chat persists across reload by session id when titles are duplicated", async ({ page, request }) => {
  const apiBase = "http://127.0.0.1:3001/api";
  const suffix = Date.now();
  const projectName = `selection-persist-${suffix}`;
  let projectId: string | null = null;
  let projectSessionId: string | null = null;
  let unassignedSessionId: string | null = null;

  const createSession = async (): Promise<string> => {
    const createResponse = await request.post(`${apiBase}/sessions`, {
      data: {}
    });
    expect(createResponse.ok()).toBeTruthy();
    const payload = (await createResponse.json()) as { session?: { sessionId?: string } };
    const sessionId = payload.session?.sessionId;
    expect(sessionId).toBeTruthy();
    return sessionId as string;
  };

  try {
    const createProjectResponse = await request.post(`${apiBase}/projects`, {
      data: { name: projectName }
    });
    expect(createProjectResponse.ok()).toBeTruthy();
    const projectPayload = (await createProjectResponse.json()) as { project?: { projectId?: string } };
    projectId = projectPayload.project?.projectId ?? null;
    expect(projectId).toBeTruthy();

    projectSessionId = await createSession();
    unassignedSessionId = await createSession();

    const assignResponse = await request.post(`${apiBase}/sessions/${encodeURIComponent(projectSessionId)}/project`, {
      data: { projectId }
    });
    expect(assignResponse.ok()).toBeTruthy();

    await page.goto("/");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();

    const targetRow = page.locator(`.session-row[data-session-id="${projectSessionId}"]`).first();
    await expect(targetRow).toBeVisible();
    await targetRow.locator(".session-btn").click();
    await expect(page.locator(`.session-row.selected[data-session-id="${projectSessionId}"]`)).toBeVisible();

    await page.reload();
    await expect(page.locator(`.session-row.selected[data-session-id="${projectSessionId}"]`)).toBeVisible();
  } finally {
    if (unassignedSessionId) {
      await request.delete(`${apiBase}/sessions/${encodeURIComponent(unassignedSessionId)}`);
    }

    if (projectId) {
      await request.post(`${apiBase}/projects/${encodeURIComponent(projectId)}/chats/delete-all`, {
        data: {}
      });
      await request.delete(`${apiBase}/projects/${encodeURIComponent(projectId)}`);
    } else if (projectSessionId) {
      await request.delete(`${apiBase}/sessions/${encodeURIComponent(projectSessionId)}`);
    }
  }
});
