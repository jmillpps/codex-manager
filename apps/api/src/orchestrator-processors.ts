import { z } from "zod";
import type { JobDefinition } from "./orchestrator-types.js";

export const suggestReplyJobPayloadSchema = z.object({
  requestKey: z.string().min(1),
  sessionId: z.string().min(1),
  projectId: z.string().min(1),
  model: z.string().min(1).optional(),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  draft: z.string().trim().min(1).max(4000).optional()
});

export const suggestReplyJobResultSchema = z.object({
  suggestion: z.string().min(1),
  requestKey: z.string().min(1)
});

export type SuggestReplyJobPayload = z.infer<typeof suggestReplyJobPayloadSchema>;
export type SuggestReplyJobResult = z.infer<typeof suggestReplyJobResultSchema>;

export const fileChangeExplainJobPayloadSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  projectId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  summary: z.string().min(1),
  details: z.string().min(1),
  anchorItemId: z.string().min(1)
});

export const fileChangeExplainJobResultSchema = z.object({
  messageId: z.string().min(1),
  explanation: z.string().min(1),
  anchorItemId: z.string().min(1)
});

export type FileChangeExplainJobPayload = z.infer<typeof fileChangeExplainJobPayloadSchema>;
export type FileChangeExplainJobResult = z.infer<typeof fileChangeExplainJobResultSchema>;

export type SuggestReplyJobDefinition = JobDefinition<SuggestReplyJobPayload, SuggestReplyJobResult>;
export type FileChangeExplainJobDefinition = JobDefinition<FileChangeExplainJobPayload, FileChangeExplainJobResult>;
