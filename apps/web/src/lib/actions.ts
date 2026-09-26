'use server';

import { revalidatePath } from 'next/cache';
import { api } from './api';

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Mutations run as server actions, so the dashboard's API key stays on the
 * server and every control-plane call is still authorised and audited by the
 * API itself — the browser never holds a credential.
 */

export async function cancelExecution(executionId: string): Promise<ActionResult> {
  try {
    await api().executions.cancel(executionId, 'cancelled from the dashboard');
    revalidatePath(`/executions/${executionId}`);
    return { ok: true, message: 'Execution cancelled.' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function pauseExecution(executionId: string): Promise<ActionResult> {
  try {
    await api().executions.pause(executionId, 'paused from the dashboard');
    revalidatePath(`/executions/${executionId}`);
    return { ok: true, message: 'Execution paused.' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function resumeExecution(executionId: string): Promise<ActionResult> {
  try {
    await api().executions.resume(executionId);
    revalidatePath(`/executions/${executionId}`);
    return { ok: true, message: 'Execution resumed.' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function retryExecution(executionId: string): Promise<ActionResult> {
  try {
    const created = await api().executions.retry(executionId);
    revalidatePath('/executions');
    return { ok: true, message: `Retrying as ${created.id}.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function replayExecution(executionId: string): Promise<ActionResult> {
  try {
    const created = await api().executions.replay(executionId, { strategy: 'recorded' });
    revalidatePath('/executions');
    return { ok: true, message: `Replaying as ${created.id}. Side-effecting tools are blocked.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function decideApproval(
  approvalId: string,
  approve: boolean,
  note: string,
  editedArguments: string | null,
): Promise<ActionResult> {
  try {
    let parsed: Record<string, unknown> | null = null;
    if (editedArguments && editedArguments.trim().length > 0) {
      try {
        parsed = JSON.parse(editedArguments) as Record<string, unknown>;
      } catch {
        return { ok: false, message: 'Edited arguments are not valid JSON; nothing was decided.' };
      }
    }

    await api().approvals.decide(approvalId, {
      approve,
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(parsed ? { editedArguments: parsed as never } : {}),
    });
    revalidatePath('/approvals');
    revalidatePath('/');
    return {
      ok: true,
      message: approve
        ? parsed
          ? 'Approved with edited arguments. The agent will use yours, not the model’s.'
          : 'Approved. The execution has been re-queued.'
        : 'Rejected. The agent has been told and will continue without this action.',
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
