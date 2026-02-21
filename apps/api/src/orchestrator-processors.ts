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
  approvalId: z.string().min(1).optional(),
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

export const supervisorRiskLevelSchema = z.enum(["none", "low", "med", "high"]);
export const supervisorNonNoneRiskLevelSchema = z.enum(["low", "med", "high"]);
export const supervisorConfidenceSchema = z.enum(["low", "med", "high"]);
export const supervisorCheckStatusSchema = z.enum(["passed", "failed", "error", "timeout", "skipped"]);

export const fileChangeSupervisorInsightJobPayloadSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  projectId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  sourceEvent: z.enum(["approval_request", "approvals_reconcile", "item_completed"]),
  fileChangeStatus: z.enum(["pending_approval", "completed"]),
  approvalId: z.string().min(1).optional(),
  summary: z.string().min(1),
  details: z.string().min(1),
  anchorItemId: z.string().min(1)
});

export const fileChangeSupervisorInsightJobResultSchema = z.object({
  messageId: z.string().min(1),
  anchorItemId: z.string().min(1),
  approvalId: z.string().min(1).optional(),
  insight: z.object({
    change: z.string().min(1),
    impact: z.string().min(1),
    risk: z.object({
      level: supervisorRiskLevelSchema,
      reason: z.string().min(1)
    }),
    check: z.object({
      instruction: z.string().min(1),
      expected: z.string().min(1)
    }),
    confidence: supervisorConfidenceSchema
  })
});

export type FileChangeSupervisorInsightJobPayload = z.infer<typeof fileChangeSupervisorInsightJobPayloadSchema>;
export type FileChangeSupervisorInsightJobResult = z.infer<typeof fileChangeSupervisorInsightJobResultSchema>;

export const riskRecheckBatchJobPayloadSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  projectId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  checks: z.array(
    z.object({
      itemId: z.string().min(1),
      approvalId: z.string().min(1).optional(),
      riskLevel: supervisorNonNoneRiskLevelSchema,
      riskReason: z.string().min(1),
      instruction: z.string().min(1),
      expected: z.string().min(1)
    })
  ),
  execution: z
    .object({
      maxConcurrency: z.number().int().positive(),
      perCheckTimeoutMs: z.number().int().positive()
    })
    .optional()
});

export const riskRecheckBatchJobResultSchema = z.object({
  messageId: z.string().min(1),
  turnId: z.string().min(1),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
    timeout: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative()
  }),
  checks: z.array(
    z.object({
      itemId: z.string().min(1),
      riskLevel: supervisorNonNoneRiskLevelSchema,
      instruction: z.string().min(1),
      expected: z.string().min(1),
      status: supervisorCheckStatusSchema,
      evidence: z.string().min(1),
      durationMs: z.number().int().nonnegative()
    })
  )
});

export type RiskRecheckBatchJobPayload = z.infer<typeof riskRecheckBatchJobPayloadSchema>;
export type RiskRecheckBatchJobResult = z.infer<typeof riskRecheckBatchJobResultSchema>;

export const turnSupervisorReviewJobPayloadSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  projectId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  insights: z.array(
    z.object({
      itemId: z.string().min(1),
      change: z.string().min(1),
      impact: z.string().min(1),
      riskLevel: supervisorRiskLevelSchema,
      riskReason: z.string().min(1)
    })
  ),
  riskBatch: z
    .object({
      summary: z.object({
        total: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        error: z.number().int().nonnegative(),
        timeout: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative()
      }),
      checks: z.array(
        z.object({
          itemId: z.string().min(1),
          status: supervisorCheckStatusSchema,
          evidence: z.string().min(1)
        })
      )
    })
    .nullable(),
  turnTranscriptSnapshot: z.string().min(1)
});

export const turnSupervisorReviewJobResultSchema = z.object({
  messageId: z.string().min(1),
  turnId: z.string().min(1),
  review: z.object({
    overallChange: z.string().min(1),
    topRisks: z.array(
      z.object({
        itemId: z.string().min(1),
        level: supervisorNonNoneRiskLevelSchema,
        why: z.string().min(1),
        state: z.enum(["open", "validated", "mitigated"])
      })
    ),
    nextBestAction: z.string().min(1),
    suggestReplyGuidance: z.string().min(1)
  })
});

export type TurnSupervisorReviewJobPayload = z.infer<typeof turnSupervisorReviewJobPayloadSchema>;
export type TurnSupervisorReviewJobResult = z.infer<typeof turnSupervisorReviewJobResultSchema>;

export type SuggestReplyJobDefinition = JobDefinition<SuggestReplyJobPayload, SuggestReplyJobResult>;
export type FileChangeExplainJobDefinition = JobDefinition<FileChangeExplainJobPayload, FileChangeExplainJobResult>;
export type FileChangeSupervisorInsightJobDefinition = JobDefinition<
  FileChangeSupervisorInsightJobPayload,
  FileChangeSupervisorInsightJobResult
>;
export type RiskRecheckBatchJobDefinition = JobDefinition<RiskRecheckBatchJobPayload, RiskRecheckBatchJobResult>;
export type TurnSupervisorReviewJobDefinition = JobDefinition<TurnSupervisorReviewJobPayload, TurnSupervisorReviewJobResult>;
