/**
 * Shared text-job transport shape for agents.
 */

export type SendTextJob = (input: {
  jobType: string;
  projectId: string;
  sourceSessionId: string;
  threadId: string;
  text: string;
  metadata?: Record<string, unknown>;
}) => Promise<{ messageId?: string } | void>;

export async function dispatchTextJob(
  send: SendTextJob,
  input: {
    jobType: string;
    projectId: string;
    sourceSessionId: string;
    threadId: string;
    text: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await send(input);
}

