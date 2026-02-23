export function registerAgentEvents(registry) {
  registry.on("suggest_request.requested", async (event, tools) => {
    const payload = event && typeof event.payload === "object" && event.payload ? event.payload : {};
    const projectId = typeof payload.projectId === "string" && payload.projectId.length > 0 ? payload.projectId : "fixture-project";
    const sourceSessionId =
      typeof payload.sessionId === "string" && payload.sessionId.length > 0 ? payload.sessionId : "fixture-session";
    const requestKey = typeof payload.requestKey === "string" && payload.requestKey.length > 0 ? payload.requestKey : "fixture-request";

    return tools.enqueueJob({
      type: "suggest_request",
      projectId,
      sourceSessionId,
      payload: {
        requestKey,
        sessionId: sourceSessionId,
        projectId,
        sourceThreadId: sourceSessionId,
        sourceTurnId: "portable-turn",
        instructionText: "Suggest the next concrete user request."
      }
    });
  });
}
