import type {
  Artifact,
  ArtifactPayload,
  EdgeEvent,
  InputRequestView,
  Message,
  Project,
  Run,
  Step,
  Task,
  Thread,
  ThreadSnapshot,
} from "../lib/api/contract";
import { TASK_TERMINAL } from "../lib/api/contract";

/**
 * 工作区状态 = 服务端事实（消息快照 + 事件流）按 id 归并出来的视图。
 * 后端的事件信封只带 runId/taskId，不带 threadId，所以 Run、Task、Step、Artifact 都按项目维度存；
 * 对话只持有消息列表，Run 通过 run.threadId（来自消息快照）归属到对话。
 */
export interface WorkspaceState {
  project: Project | null;
  threads: Thread[];
  activeThreadId: string | null;
  loaded: Record<string, boolean>;
  messages: Record<string, Message[]>;
  runs: Record<string, Run>;
  steps: Record<string, Step[]>;
  tasks: Record<string, Task>;
  artifacts: Record<string, Artifact>;
  inputs: Record<string, InputRequestView>;
  counter: number;
}

export type WorkspaceAction =
  | {
      type: "init";
      project: Project;
      threads: Thread[];
      activeThreadId: string | null;
    }
  | { type: "events"; events: EdgeEvent[] }
  | { type: "thread-loaded"; threadId: string; snapshot: ThreadSnapshot }
  | { type: "local-message"; message: Message }
  | { type: "thread-created"; thread: Thread }
  /** 服务端 thread.created 事件：只登记到对话列表，消息仍要读取（不能标记为已加载） */
  | { type: "thread-seen"; thread: Thread }
  | { type: "retry-link"; runId: string; taskId: string }
  | {
      type: "assign-run";
      runId: string;
      threadId: string;
      retryOf?: string;
      label?: string;
    }
  | { type: "input-answered"; id: string }
  | { type: "active"; threadId: string | null }
  | { type: "rename"; title: string };

export const initialWorkspaceState: WorkspaceState = {
  project: null,
  threads: [],
  activeThreadId: null,
  loaded: {},
  messages: {},
  runs: {},
  steps: {},
  tasks: {},
  artifacts: {},
  inputs: {},
  counter: 0,
};

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

const RUN_DONE = ["completed", "failed", "cancelled"];
/** 事件时间戳（毫秒）；解析失败时返回 undefined，不影响状态归并 */
const atMs = (iso: string): number | undefined => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
};
const earliest = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

function applyEvent(s: WorkspaceState, ev: EdgeEvent): WorkspaceState {
  switch (ev.type) {
    case "run.state": {
      const id = ev.runId;
      if (!id) return s;
      const old = s.runs[id];
      const counter = old ? s.counter : s.counter + 1;
      // 新的 run.state 事件没带 error 时要清掉旧的 error
      const { error: _prevError, ...prev } = old ?? { id, order: counter };
      const at = atMs(ev.at);
      const startedAt = earliest(old?.startedAt, at);
      const run: Run = {
        ...prev,
        id,
        threadId: old?.threadId ?? "",
        state: ev.payload.state,
        order: old?.order ?? counter,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(RUN_DONE.includes(ev.payload.state) && at !== undefined
          ? { endedAt: old?.endedAt ?? at }
          : {}),
        ...(ev.payload.error ? { error: ev.payload.error } : {}),
        ...(ev.payload.summary ? { summary: ev.payload.summary } : {}),
      };
      return { ...s, counter, runs: { ...s.runs, [id]: run } };
    }
    case "run.step": {
      const runId = ev.runId;
      if (!runId) return s;
      const list = s.steps[runId] ?? [];
      const old = list.find((x) => x.id === ev.payload.stepId);
      const counter = old ? s.counter : s.counter + 1;
      const step: Step = {
        id: ev.payload.stepId,
        runId,
        tool: ev.payload.tool,
        status: ev.payload.status,
        summary: ev.payload.summary,
        order: old?.order ?? counter,
        ...(ev.payload.role ? { role: ev.payload.role } : {}),
        ...(ev.payload.warning ? { warning: true } : {}),
      };
      return {
        ...s,
        counter,
        steps: { ...s.steps, [runId]: upsertById(list, step) },
      };
    }
    case "task.state": {
      const id = ev.taskId;
      const runId = ev.runId;
      if (!id || !runId) return s;
      const old = s.tasks[id];
      const at = atMs(ev.at);
      const startedAt = earliest(old?.startedAt, at);
      const task: Task = {
        id,
        runId,
        slotIndex: ev.payload.slotIndex,
        state: ev.payload.state,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(TASK_TERMINAL.includes(ev.payload.state) && at !== undefined
          ? { endedAt: old?.endedAt ?? at }
          : {}),
        ...(ev.payload.error ? { error: ev.payload.error } : {}),
        ...(old?.artifactId ? { artifactId: old.artifactId } : {}),
        ...((ev.payload.slot ?? old?.slot)
          ? {
              slot: (ev.payload.slot ?? old?.slot) as NonNullable<Task["slot"]>,
            }
          : {}),
      };
      return { ...s, tasks: { ...s.tasks, [id]: task } };
    }
    case "artifact.committed": {
      const { artifact, elementIds, revision } = ev.payload;
      // 浏览器端处理结果（client-results）没有任务/快照，不属于 Agent 任务卡
      if (!artifact.taskId || !artifact.asset || !artifact.snapshotId) return s;
      const runId = ev.runId ?? "";
      const task = s.tasks[artifact.taskId];
      const art: Artifact = {
        ...(artifact as ArtifactPayload),
        runId,
        slotIndex: task?.slotIndex ?? 0,
        elementIds,
        revision,
      };
      return {
        ...s,
        artifacts: { ...s.artifacts, [artifact.id]: art },
        tasks: task
          ? { ...s.tasks, [task.id]: { ...task, artifactId: artifact.id } }
          : s.tasks,
      };
    }
    case "input.requested": {
      const p = ev.payload;
      return {
        ...s,
        inputs: {
          ...s.inputs,
          [p.id]: {
            id: p.id,
            runId: p.runId,
            question: p.question,
            choices: p.choices,
            state: "open",
          },
        },
      };
    }
    case "message.final": {
      const threadId = ev.runId ? s.runs[ev.runId]?.threadId : undefined;
      if (!threadId) return s; // 对话还没打开：打开时会从消息快照里读到
      const text = ev.payload.parts
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("");
      const msg: Message = {
        id: ev.payload.messageId,
        threadId,
        role: "assistant",
        text,
        runId: ev.runId ?? null,
        createdAt: ev.at,
      };
      return {
        ...s,
        messages: {
          ...s.messages,
          [threadId]: upsertById(s.messages[threadId] ?? [], msg),
        },
      };
    }
    default:
      return s; // canvas.ops / quota.updated / message.delta 由 hook 或画布处理
  }
}

export function workspaceReducer(
  s: WorkspaceState,
  a: WorkspaceAction,
): WorkspaceState {
  switch (a.type) {
    case "init":
      return {
        ...initialWorkspaceState,
        project: a.project,
        threads: a.threads,
        activeThreadId: a.activeThreadId,
      };
    case "active":
      return { ...s, activeThreadId: a.threadId };
    case "rename":
      return s.project
        ? { ...s, project: { ...s.project, title: a.title } }
        : s;
    case "events":
      return a.events.reduce(applyEvent, s);
    case "thread-seen":
      return s.threads.some((t) => t.id === a.thread.id)
        ? s
        : { ...s, threads: [...s.threads, a.thread] };
    case "thread-created":
      return {
        ...s,
        threads: s.threads.some((t) => t.id === a.thread.id)
          ? s.threads
          : [...s.threads, a.thread],
        loaded: { ...s.loaded, [a.thread.id]: true },
        messages: {
          ...s.messages,
          [a.thread.id]: s.messages[a.thread.id] ?? [],
        },
      };
    case "local-message": {
      const m = a.message;
      const runs =
        m.runId && !s.runs[m.runId]
          ? {
              ...s.runs,
              [m.runId]: {
                id: m.runId,
                threadId: m.threadId,
                state: "queued" as const,
                order: s.counter + 1,
              },
            }
          : s.runs;
      return {
        ...s,
        counter: runs === s.runs ? s.counter : s.counter + 1,
        runs:
          m.runId && runs[m.runId] && !runs[m.runId]?.threadId
            ? {
                ...runs,
                [m.runId]: { ...(runs[m.runId] as Run), threadId: m.threadId },
              }
            : runs,
        messages: {
          ...s.messages,
          [m.threadId]: upsertById(s.messages[m.threadId] ?? [], m),
        },
      };
    }
    case "retry-link": {
      const run = s.runs[a.runId];
      return run
        ? {
            ...s,
            runs: { ...s.runs, [a.runId]: { ...run, retryOf: a.taskId } },
          }
        : s;
    }
    case "assign-run": {
      const old = s.runs[a.runId];
      const counter = old ? s.counter : s.counter + 1;
      const run: Run = {
        ...(old ?? { id: a.runId, state: "queued", order: counter }),
        threadId: a.threadId,
        ...(a.retryOf ? { retryOf: a.retryOf } : {}),
        ...(a.label ? { label: a.label } : {}),
      };
      return { ...s, counter, runs: { ...s.runs, [a.runId]: run } };
    }
    case "input-answered": {
      const ir = s.inputs[a.id];
      return ir
        ? {
            ...s,
            inputs: { ...s.inputs, [a.id]: { ...ir, state: "answered" } },
          }
        : s;
    }
    case "thread-loaded": {
      const { threadId, snapshot } = a;
      let counter = s.counter;
      const runs = { ...s.runs };
      const steps = { ...s.steps };
      for (const r of snapshot.runs) {
        const old = runs[r.id];
        if (!old) counter += 1;
        // 服务端持久化的步骤（按 seq 排序，同一 stepId 折叠成最新状态）和耗时：刷新后仍在，不依赖本机存储
        if (r.steps?.length) {
          const ordered = [...r.steps].sort((a, b) => a.seq - b.seq);
          const byId = new Map<string, Step>();
          for (const st of ordered)
            byId.set(st.stepId, {
              id: st.stepId,
              runId: r.id,
              tool: st.tool,
              status: st.status,
              summary: st.summary,
              order: byId.get(st.stepId)?.order ?? st.seq,
              ...(st.role ? { role: st.role } : {}),
              ...(st.warning ? { warning: true } : {}),
            });
          // 事件流里已有更新的同名步骤时以事件为准
          const live = new Map((s.steps[r.id] ?? []).map((x) => [x.id, x]));
          steps[r.id] = [...byId.values()].map((x) => live.get(x.id) ?? x);
        }
        const stamps = [...(r.steps ?? []), ...(r.timings ?? [])]
          .map((x) => atMs(x.at))
          .filter((x): x is number => x !== undefined);
        const snapStart = stamps.length ? Math.min(...stamps) : undefined;
        const snapEnd = stamps.length ? Math.max(...stamps) : undefined;
        const state = old ? old.state : r.state;
        const startedAt = earliest(old?.startedAt, snapStart);
        const endedAt =
          old?.endedAt ?? (RUN_DONE.includes(state) ? snapEnd : undefined);
        const error = old?.error ?? r.error ?? undefined;
        // 事件流可能比快照新（例如刚收到 completed），已有的状态以事件为准，只补 threadId
        runs[r.id] = {
          ...(old ?? { id: r.id, state: r.state, order: counter }),
          threadId,
          state,
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(endedAt !== undefined ? { endedAt } : {}),
          ...(error ? { error } : {}),
          ...(r.timings?.length
            ? {
                timings: r.timings.map((t) => ({
                  phase: t.phase,
                  durationMs: t.durationMs,
                  label: t.label,
                  ...(t.taskId ? { taskId: t.taskId } : {}),
                })),
              }
            : {}),
        };
      }
      const tasks = { ...s.tasks };
      const artifacts = { ...s.artifacts };
      for (const t of snapshot.tasks) {
        const old = tasks[t.id];
        tasks[t.id] = {
          id: t.id,
          runId: t.runId,
          slotIndex: t.slotIndex,
          state:
            old && old.state !== t.state && old.state === "committed"
              ? old.state
              : t.state,
          ...(t.error ? { error: t.error } : {}),
          ...(t.artifact ? { artifactId: t.artifact.id } : {}),
          ...(old?.startedAt !== undefined ? { startedAt: old.startedAt } : {}),
          ...(old?.endedAt !== undefined ? { endedAt: old.endedAt } : {}),
          ...((old?.slot ?? t.slot)
            ? { slot: (t.slot ?? old?.slot) as NonNullable<Task["slot"]> }
            : {}),
        };
        if (t.artifact && !artifacts[t.artifact.id])
          artifacts[t.artifact.id] = {
            ...t.artifact,
            runId: t.runId,
            slotIndex: t.slotIndex,
          };
      }
      const pending = new Set(snapshot.inputRequests.map((i) => i.id));
      const inputs = { ...s.inputs };
      for (const i of snapshot.inputRequests)
        inputs[i.id] = {
          id: i.id,
          runId: i.runId,
          question: i.question,
          choices: i.choices,
          state: "open",
        };
      for (const [id, ir] of Object.entries(inputs)) {
        const belongs = runs[ir.runId]?.threadId === threadId;
        if (belongs && !pending.has(id))
          inputs[id] = { ...ir, state: "answered" };
      }
      // 本地刚发出的消息（服务端快照可能还没带上）保留
      const server = snapshot.messages;
      const serverIds = new Set(server.map((m) => m.id));
      const extra = (s.messages[threadId] ?? []).filter(
        (m) =>
          !serverIds.has(m.id) &&
          m.role === "user" &&
          m.runId &&
          !server.some((x) => x.runId === m.runId && x.role === "user"),
      );
      return {
        ...s,
        counter,
        runs,
        steps,
        tasks,
        artifacts,
        inputs,
        loaded: { ...s.loaded, [threadId]: true },
        messages: { ...s.messages, [threadId]: [...server, ...extra] },
        threads: s.threads.some((t) => t.id === threadId)
          ? s.threads
          : [snapshot.thread, ...s.threads],
      };
    }
  }
}

// ───────── 选择器 ─────────
export const threadRuns = (s: WorkspaceState, threadId: string): Run[] =>
  Object.values(s.runs)
    .filter((r) => r.threadId === threadId)
    .sort((a, b) => a.order - b.order);
export const runTasks = (s: WorkspaceState, runId: string): Task[] =>
  Object.values(s.tasks)
    .filter((t) => t.runId === runId)
    .sort((a, b) => a.slotIndex - b.slotIndex);
export const activeRunOf = (
  s: WorkspaceState,
  threadId: string | null,
): Run | undefined =>
  threadId
    ? threadRuns(s, threadId).find(
        (r) =>
          r.state === "queued" ||
          r.state === "planning" ||
          r.state === "running" ||
          r.state === "waiting_input",
      )
    : undefined;
export const runSteps = (s: WorkspaceState, runId: string): Step[] =>
  [...(s.steps[runId] ?? [])].sort((a, b) => a.order - b.order);
