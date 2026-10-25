"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  type ApiError,
  type CanvasOp,
  type CanvasOpsRequest,
  type ConnectionState,
  type EdgeEvent,
  type MediaOpRequest,
  type Message,
  type MessageMeta,
  type MessageRequest,
  type MessagesResponse,
  type ProjectResponse,
  type ThreadSnapshot,
  getApi,
} from "../../lib/api";
import { useSession } from "../../lib/session";
import { loadRetryLinks, saveRetryLink } from "../../lib/message-meta";
import { errorMessage, newId, readJson, writeJson } from "../../lib/utils";
import { type SetEvent as SetEventT, isSetEvent } from "./use-set-session";
import {
  initialWorkspaceState,
  workspaceReducer,
} from "../../state/workspace-store";

export interface RemoteOps {
  revision: number;
  ops: CanvasOp[];
  source: "user" | "agent" | "task";
}
type Load =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

type StoredMessage = MessagesResponse["items"][number];

/** 服务端回显的提交设置、确认后的设置与冻结的参考图 → 气泡下方的元数据 */
function metaFromServer(m: StoredMessage): MessageMeta | undefined {
  if (m.role !== "user" || !(m.effectiveSettings ?? m.settings))
    return undefined;
  return {
    attachments: [],
    references: (m.references ?? []).map((r) => ({
      snapshotId: r.snapshotId,
      purpose: r.purpose,
      order: r.order,
      ...(r.thumbnailUrl ? { previewUrl: r.thumbnailUrl } : {}),
    })),
    settings: (m.effectiveSettings ?? m.settings) as MessageMeta["settings"],
    explicit: (m.settingsExplicitKeys ?? []) as MessageMeta["explicit"],
  };
}

export interface SendInput {
  request: MessageRequest;
  meta: MessageMeta;
}

export function useWorkspace(projectId: string, threadParam: string | null) {
  const { setQuota } = useSession();
  const [state, dispatch] = useReducer(workspaceReducer, initialWorkspaceState);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [canvas, setCanvas] = useState<ProjectResponse["canvas"] | null>(null);
  const [remoteOps, setRemoteOps] = useState<RemoteOps[]>([]);
  const [conn, setConn] = useState<ConnectionState>("connecting");
  const [contractError, setContractError] = useState<string | null>(null);
  const [threadErr, setThreadErr] = useState<Record<string, string>>({});
  const [nonce, setNonce] = useState(0);
  const loadingThreads = useRef(new Set<string>());
  const setQuotaRef = useRef(setQuota);
  setQuotaRef.current = setQuota;
  // 事件到达时要读最新状态/函数（handleEvents 本身不随状态重建）
  const messageSeenRef = useRef<(threadId: string, messageId: string) => void>(
    () => {},
  );
  const prefKey = `ws:${projectId}:thread`;
  // 套图事件（set.state / set.analyzed / set.shot）不进对话 reducer，直接转给套图视图
  const setListeners = useRef(new Set<(ev: SetEventT) => void>());
  const subscribeSet = useCallback((l: (ev: SetEventT) => void) => {
    setListeners.current.add(l);
    return () => {
      setListeners.current.delete(l);
    };
  }, []);

  const handleEvents = useCallback(
    (events: EdgeEvent[], snapshotCursor: number) => {
      const rest: EdgeEvent[] = [];
      for (const ev of events) {
        if (ev.type === "quota.updated") setQuotaRef.current(ev.payload);
        else if (isSetEvent(ev)) for (const l of setListeners.current) l(ev);
        else if (ev.type === "thread.created")
          dispatch({ type: "thread-seen", thread: ev.payload.thread });
        else if (ev.type === "message.created")
          messageSeenRef.current(ev.payload.threadId, ev.payload.messageId);
        else if (ev.type === "canvas.ops") {
          // 画布快照已包含 snapshotCursor 之前的操作；更新的操作交给画布按 revision 去重后应用
          if (ev.seq > snapshotCursor)
            setRemoteOps((l) => [
              ...l,
              {
                revision: ev.payload.revision,
                ops: ev.payload.ops,
                source: ev.payload.source,
              },
            ]);
        } else rest.push(ev);
      }
      if (rest.length) dispatch({ type: "events", events: rest });
    },
    [],
  );

  // 加载项目：画布快照 → 补读全部事件（还原步骤、任务、产物）→ 订阅实时事件。
  // 失败只显示“重试读取”，绝不重发消息。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些依赖是有意的重新执行触发条件（或只在首次进入时读取），不是遗漏
  useEffect(() => {
    const ctl = new AbortController();
    let sub: { close(): void } | undefined;
    setLoad({ status: "loading" });
    setCanvas(null);
    setRemoteOps([]);
    loadingThreads.current.clear();
    (async () => {
      try {
        const api = getApi();
        const detail = await api.getProject(projectId, { signal: ctl.signal });
        const pref = readJson<string>(prefKey);
        const pick =
          [threadParam, pref].find(
            (id) => id && detail.threads.some((t) => t.id === id),
          ) ??
          detail.threads.at(-1)?.id ??
          null;
        dispatch({
          type: "init",
          project: detail.project,
          threads: detail.threads,
          activeThreadId: pick,
        });
        // 补读事件（每次至多 1000 条，分页读到当前）
        let cursor = 0;
        for (let page = 0; page < 20; page++) {
          const items = await api.getEvents(projectId, cursor, {
            signal: ctl.signal,
          });
          if (!items.length) break;
          handleEvents(items, detail.eventCursor);
          cursor = items[items.length - 1]?.seq ?? cursor;
          if (items.length < 1000) break;
        }
        setCanvas(detail.canvas);
        setLoad({ status: "ready" });
        sub = api.subscribe(
          projectId,
          Math.max(cursor, detail.eventCursor),
          (ev) => handleEvents([ev], -1),
          setConn,
          (e: ApiError) => setContractError(e.message),
        );
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") return;
        setLoad({ status: "error", message: errorMessage(e, "读取项目失败") });
      }
    })();
    return () => {
      ctl.abort();
      sub?.close();
    };
    // threadParam 只在首次进入时用于选择线程；nonce 是“重试读取”的触发条件
  }, [projectId, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // 打开线程时读取消息快照，并把本机记录的参考图/设置挂回消息
  const active = state.activeThreadId;
  const loadThread = useCallback(
    async (id: string) => {
      if (loadingThreads.current.has(id)) return;
      loadingThreads.current.add(id);
      setThreadErr((m) => {
        const { [id]: _drop, ...rest } = m;
        return rest;
      });
      try {
        const res = await getApi().getMessages(id);
        const thread = state.threads.find((t) => t.id === id) ?? {
          id,
          projectId,
          title: "对话",
          createdAt: new Date().toISOString(),
        };
        const messages: Message[] = res.items
          .filter((m) => m.role !== "tool")
          .map((m) => {
            const meta = metaFromServer(m);
            return {
              id: m.id,
              threadId: id,
              role: m.role,
              text: m.parts
                .map((p) => (typeof p.text === "string" ? p.text : ""))
                .join(""),
              runId: m.runId,
              createdAt: m.createdAt,
              ...(meta ? { meta } : {}),
            };
          });
        const snapshot: ThreadSnapshot = {
          thread,
          messages,
          runs: res.runs,
          tasks: res.tasks,
          inputRequests: res.inputRequests,
        };
        dispatch({ type: "thread-loaded", threadId: id, snapshot });
        const links = loadRetryLinks(projectId);
        for (const [runId, taskId] of Object.entries(links))
          dispatch({ type: "retry-link", runId, taskId });
      } catch (e) {
        setThreadErr((m) => ({ ...m, [id]: errorMessage(e, "读取对话失败") }));
      } finally {
        loadingThreads.current.delete(id);
      }
    },
    [projectId, state.threads],
  );
  useEffect(() => {
    if (load.status === "ready" && active && !state.loaded[active])
      void loadThread(active);
  }, [load.status, active, state.loaded, loadThread]);

  // 服务端 message.created：别的窗口发的消息、规划中的助手消息、最终回复——本地没有就重新读取该对话
  const stateRef = useRef(state);
  stateRef.current = state;
  const reloadTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  messageSeenRef.current = (threadId, messageId) => {
    const st = stateRef.current;
    if (!st.loaded[threadId]) return; // 没打开过的对话，打开时会读到
    if (st.messages[threadId]?.some((m) => m.id === messageId)) return;
    clearTimeout(reloadTimers.current.get(threadId));
    reloadTimers.current.set(
      threadId,
      setTimeout(() => {
        reloadTimers.current.delete(threadId);
        void loadThread(threadId);
      }, 200),
    );
  };
  useEffect(() => {
    const timers = reloadTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  const selectThread = useCallback(
    (id: string) => {
      dispatch({ type: "active", threadId: id });
      writeJson(prefKey, id);
      const u = new URL(window.location.href);
      u.searchParams.set("thread", id);
      window.history.replaceState(null, "", u);
    },
    [prefKey],
  );

  const newThread = useCallback(async () => {
    const t = await getApi().createThread(projectId);
    dispatch({ type: "thread-created", thread: t });
    selectThread(t.id);
    return t.id;
  }, [projectId, selectThread]);

  const send = useCallback(
    async ({
      request,
      meta,
    }: SendInput): Promise<{ messageId: string; runId: string }> => {
      const threadId = active ?? (await newThread());
      const res = await getApi().postMessage(threadId, request);
      const text = request.parts
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("");
      dispatch({
        type: "local-message",
        message: {
          id: res.messageId,
          threadId,
          role: "user",
          text,
          runId: res.runId,
          createdAt: new Date().toISOString(),
          meta,
        },
      });
      return res;
    },
    [active, newThread],
  );

  const rename = useCallback(
    async (title: string) => {
      const prev = state.project?.title;
      dispatch({ type: "rename", title });
      try {
        await getApi().renameProject(projectId, title);
      } catch (e) {
        if (prev) dispatch({ type: "rename", title: prev });
        throw e;
      }
    },
    [projectId, state.project?.title],
  );

  const retryTask = useCallback(
    async (taskId: string) => {
      const res = await getApi().retryTask(taskId, newId());
      saveRetryLink(projectId, res.runId, taskId);
      if (active)
        dispatch({
          type: "assign-run",
          runId: res.runId,
          threadId: active,
          retryOf: taskId,
        });
      return res;
    },
    [projectId, active],
  );

  /** 把一个没有消息的 Run（图片后处理）挂到当前对话，标题带上操作名 */
  const assignRun = useCallback(
    (runId: string, threadId: string, label: string) =>
      dispatch({ type: "assign-run", runId, threadId, label }),
    [],
  );
  const mediaOp = useCallback(
    (req: MediaOpRequest) => getApi().mediaOp(req),
    [],
  );

  const applyOps = useCallback(
    (req: CanvasOpsRequest) => getApi().applyCanvasOps(projectId, req),
    [projectId],
  );

  const answer = useCallback(
    async (id: string, a: { choiceId?: string; text?: string }) => {
      await getApi().answerInputRequest(id, {
        clientOperationId: newId(),
        answer: a,
      });
      dispatch({ type: "input-answered", id });
    },
    [],
  );

  const tasks = useMemo(() => Object.values(state.tasks), [state.tasks]);

  return {
    state,
    load,
    canvas,
    remoteOps,
    conn,
    subscribeSet,
    contractError,
    threadErr,
    tasks,
    reload: () => setNonce((n) => n + 1),
    loadThread,
    selectThread,
    newThread,
    send,
    rename,
    cancel: (runId: string) => getApi().cancelRun(runId),
    answer,
    retryTask,
    applyOps,
    assignRun,
    mediaOp,
  };
}
