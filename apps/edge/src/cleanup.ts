import { all, one, roomCall, stmt } from "./core";
import type { Env } from "./types";

export const retentionMs = 7 * 86400000;
export async function cleanupGuests(env: Env) {
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const projects = await all(env, `SELECT p.id FROM projects p JOIN users u ON u.id=p.user_id
    WHERE u.is_guest=1 AND (p.deleting=1 OR p.last_accessed_at<?) ORDER BY p.last_accessed_at LIMIT 100`, cutoff);
  for (const p of projects) await roomCall(env, p.id, "expire");
  await stmt(env, "DELETE FROM sessions WHERE expires_at<?", Date.now()).run();
}

/** Called under the project's DO gate. Tombstone survives R2 or D1 failure and is retried. */
export async function expireProject(env: Env, projectId: string) {
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const claimed = await stmt(env, `UPDATE projects SET deleting=1 WHERE id=?
    AND user_id IN (SELECT id FROM users WHERE is_guest=1)
    AND (deleting=1 OR last_accessed_at<?)
    AND NOT EXISTS(SELECT 1 FROM runs WHERE project_id=? AND state IN ('queued','planning','running') AND started_at>?)
    AND NOT EXISTS(SELECT 1 FROM tasks WHERE project_id=? AND state NOT IN ('committed','failed','cancelled') AND updated_at>?) RETURNING id`,
    projectId, cutoff, projectId, Date.now() - 600000, projectId, new Date(Date.now() - 300000).toISOString()).first();
  if (!claimed) return { deleted: false };
  // Old versions deduplicated R2 globally. Keep any object still referenced by another project/draft.
  const assets = await all(env, `SELECT DISTINCT storage_key FROM assets a WHERE a.project_id=?
    AND NOT EXISTS(SELECT 1 FROM assets other WHERE other.storage_key=a.storage_key AND other.project_id IS NOT ?)`, projectId, projectId);
  const tasks = await all(env, "SELECT id FROM tasks WHERE project_id=?", projectId);
  const keys = [...assets.map(a => a.storage_key), ...tasks.map(t => `provider-parts/${t.id}.json`)];
  for (let i = 0; i < keys.length; i += 100) await env.BUCKET.delete(keys.slice(i, i + 100));
  const project = await one(env, "SELECT user_id FROM projects WHERE id=?", projectId);
  await env.DB.batch([
    stmt(env, "PRAGMA defer_foreign_keys = ON"),
    stmt(env, `DELETE FROM idempotency WHERE user_id=? AND (
      json_extract(response,'$.projectId')=? OR json_extract(response,'$.runId') IN (SELECT id FROM runs WHERE project_id=?)
      OR json_extract(response,'$.taskId') IN (SELECT id FROM tasks WHERE project_id=?))`, project!.user_id, projectId, projectId, projectId),
    ...["outbox", "submit_intents"].map(table => stmt(env, `DELETE FROM ${table} WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)`, projectId)),
    ...["insertions", "artifacts"].map(table => stmt(env, `DELETE FROM ${table} WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)`, projectId)),
    stmt(env, "DELETE FROM set_shots WHERE set_id IN (SELECT id FROM image_sets WHERE project_id=?)", projectId),
    ...["image_sets", "media_artifacts", "client_ops", "input_requests", "child_runs", "messages", "operations", "element_revisions", "events", "appearance_snapshots", "assets", "tasks", "runs", "threads"].map(table =>
      stmt(env, `DELETE FROM ${table} WHERE project_id=?`, projectId)),
    stmt(env, "DELETE FROM projects WHERE id=? AND deleting=1", projectId),
  ]);
  // Daily cost records intentionally outlive deleted content, so cleanup cannot refund spend.
  return { deleted: true };
}
