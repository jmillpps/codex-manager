import { z } from "zod";
import type { JobDefinition } from "./orchestrator-types.js";

export const suggestRequestJobPayloadSchema = z.object({
  requestKey: z.string().min(1),
  sessionId: z.string().min(1),
  projectId: z.string().min(1),
  agent: z.string().min(1).default("default"),
  sourceThreadId: z.string().min(1),
  sourceTurnId: z.string().min(1),
  instructionText: z.string().min(1),
  bootstrapInstruction: z
    .object({
      key: z.string().min(1),
      instructionText: z.string().min(1)
    })
    .optional(),
  model: z.string().min(1).optional(),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  draft: z.string().trim().min(1).max(4000).optional()
});

export const suggestRequestJobResultSchema = z.object({
  suggestion: z.string().min(1),
  requestKey: z.string().min(1)
});

export type SuggestRequestJobPayload = z.infer<typeof suggestRequestJobPayloadSchema>;
export type SuggestRequestJobResult = z.infer<typeof suggestRequestJobResultSchema>;

export const agentInstructionSupplementalTargetSchema = z.object({
  messageId: z.string().min(1),
  type: z.string().min(1),
  placeholderTexts: z.array(z.string().min(1)).max(12).optional(),
  completeFallback: z.string().min(1).optional(),
  errorFallback: z.string().min(1).optional(),
  canceledFallback: z.string().min(1).optional()
});

export const agentInstructionCompletionSignalSchema = z.object({
  kind: z.literal("suggested_request"),
  requestKey: z.string().min(1)
});

export const agentInstructionJobPayloadSchema = z.object({
  agent: z.string().min(1),
  jobKind: z.string().min(1),
  projectId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1).optional(),
  approvalId: z.string().min(1).optional(),
  anchorItemId: z.string().min(1).optional(),
  bootstrapInstruction: z
    .object({
      key: z.string().min(1),
      instructionText: z.string().min(1)
    })
    .optional(),
  instructionText: z.string().min(1),
  dedupeKey: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  fallbackSuggestionDraft: z.string().trim().min(1).max(4000).optional(),
  expectResponse: z.enum(["none", "assistant_text", "action_intents"]).optional(),
  supplementalTargets: z.array(agentInstructionSupplementalTargetSchema).max(8).optional(),
  completionSignal: agentInstructionCompletionSignalSchema.optional()
});

export const agentInstructionActionIntentSchema = z.object({
  kind: z.literal("action_request"),
  actionType: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  requestId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional()
});

export const agentInstructionActionIntentBatchSchema = z.object({
  kind: z.literal("action_intents"),
  intents: z.array(agentInstructionActionIntentSchema).min(1).max(32)
});

export const agentInstructionActionResultSchema = z.object({
  actionType: z.string().min(1),
  status: z.enum(["performed", "already_resolved", "not_eligible", "conflict", "forbidden", "invalid", "failed"]),
  requestId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
  details: z.record(z.string(), z.unknown()).optional()
});

export const agentInstructionJobResultSchema = z.object({
  status: z.literal("ok"),
  outputText: z.string().min(1).optional(),
  actionIntents: z.array(agentInstructionActionIntentSchema).min(1).optional(),
  actionResults: z.array(agentInstructionActionResultSchema).optional()
});

export type AgentInstructionJobPayload = z.infer<typeof agentInstructionJobPayloadSchema>;
export type AgentInstructionJobResult = z.infer<typeof agentInstructionJobResultSchema>;
export type AgentInstructionActionIntent = z.infer<typeof agentInstructionActionIntentSchema>;
export type AgentInstructionActionIntentBatch = z.infer<typeof agentInstructionActionIntentBatchSchema>;
export type AgentInstructionActionResult = z.infer<typeof agentInstructionActionResultSchema>;

export type SuggestRequestJobDefinition = JobDefinition<SuggestRequestJobPayload, SuggestRequestJobResult>;
export type AgentInstructionJobDefinition = JobDefinition<AgentInstructionJobPayload, AgentInstructionJobResult>;
