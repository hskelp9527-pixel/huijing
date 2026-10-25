import { readJson, writeJson } from "./utils";

// 参考图、生成设置、步骤与耗时由服务端回显（GET /api/threads/:id/messages），这里不再保存。

/** 重试产生的新 Run 没有用户消息：记下它是对哪个任务的重试，用来把它排在原消息之后 */
const retryKey = (projectId: string) => `retry:${projectId}`;
export const loadRetryLinks = (projectId: string): Record<string, string> =>
  readJson<Record<string, string>>(retryKey(projectId)) ?? {};
export function saveRetryLink(
  projectId: string,
  runId: string,
  taskId: string,
) {
  writeJson(retryKey(projectId), {
    ...loadRetryLinks(projectId),
    [runId]: taskId,
  });
}
