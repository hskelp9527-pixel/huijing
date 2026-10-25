"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CloudOff,
  Maximize2,
  Pencil,
  RotateCw,
  Wifi,
} from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  ApiError,
  type MediaOpRequest,
  type Message,
  type MessageMeta,
  getApi,
} from "../../lib/api";
import { SessionGate, useSession } from "../../lib/session";
import { cx, errorMessage, newId, readJson, writeJson } from "../../lib/utils";
import { activeRunOf, runTasks } from "../../state/workspace-store";
import type { StaleState } from "../composer/composer";
import { useComposer } from "../composer/use-composer";
import { DemoBadge, QuotaPill, ThemeToggle } from "../ui/app-chrome";
import { BrandMark } from "../ui/brand";
import { useToast } from "../ui/toast";
import { AgentPanel } from "./agent-panel";
import { SetActionButtons, SetPanel, useSetActions } from "./set-panel";
import { shotBusy, useSetSession } from "./use-set-session";
import { EDIT_ITEMS } from "./canvas-chrome";
import {
  type CanvasHandle,
  CanvasPane,
  type PendingBatch,
  type SaveState,
  type SelectedImage,
} from "./canvas-pane";
import {
  type MediaForm,
  MediaOpDialog,
  type MediaParams,
} from "./media-op-dialog";
import { useWorkspace } from "./use-workspace";

const MIN_AGENT = 320;
const MAX_AGENT = 560;
const DEFAULT_AGENT = 380;
const MIN_CANVAS = 600;
const WIDE_QUERY = "(min-width: 1100px)";

function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(WIDE_QUERY);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true,
  );
}

export function WorkspaceView() {
  const params = useSearchParams();
  const id = params.get("id");
  const thread = params.get("thread");
  // 套图项目：项目详情自带 setId；?set=<setId> 只是刚创建时的提示，让界面不用等项目读完
  const setParam = params.get("set");
  if (!id) {
    return (
      <main id="main" className="empty-state" style={{ minHeight: "100vh" }}>
        <h3>缺少项目</h3>
        <p>这个链接里没有项目编号。</p>
        <Link className="btn btn-primary" href="/">
          回到首页
        </Link>
      </main>
    );
  }
  return (
    <SessionGate>
      <Workspace key={id} projectId={id} threadParam={thread} setId={setParam} />
    </SessionGate>
  );
}

function Workspace({
  projectId,
  threadParam,
  setId: setHint,
}: { projectId: string; threadParam: string | null; setId: string | null }) {
  const canvasRef = useRef<CanvasHandle>(null);
  const ws = useWorkspace(projectId, threadParam);
  const setId = ws.state.project?.setId ?? setHint;
  const setMode = !!setId;
  const setSess = useSetSession(setId, { subscribeSet: ws.subscribeSet, conn: ws.conn });
  const setActions = useSetActions(
    setSess,
    canvasRef,
    ws.state.project?.title ?? "",
  );
  const toast = useToast();
  const { quota } = useSession();
  const { resolvedTheme } = useTheme();
  const wide = useWide();
  const composer = useComposer(`draft:ws:${projectId}`, (m) => toast.show(m));
  // 窄屏：画布 / 商品与卖点（仅套图项目）/ Agent 三个标签；宽屏画布常驻，右栏用 side 切换
  const [tab, setTab] = useState<"canvas" | "agent" | "set">("canvas");
  const [side, setSide] = useState<"set" | "agent">(setMode ? "set" : "agent");
  // 项目读完才知道它是套图项目：第一次确认后默认展示「商品与卖点」
  const sawSetMode = useRef(setMode);
  useEffect(() => {
    if (setMode && !sawSetMode.current) {
      sawSetMode.current = true;
      setSide("set");
    }
  }, [setMode]);
  const [agentW, setAgentW] = useState<number>(
    () => readJson<number>(`ws:${projectId}:agentW`) ?? DEFAULT_AGENT,
  );
  const [save, setSave] = useState<SaveState>("saved");
  const [sceneSig, setSceneSig] = useState("");
  const [mediaDialog, setMediaDialog] = useState<{
    kind: MediaForm;
    elementId: string;
  } | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  // 图片后处理：runId → 来源元素（服务端没有 slot 的旧任务/演示模式才用它估算占位位置）
  const [mediaRuns, setMediaRuns] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<SelectedImage[]>([]);
  const mainRef = useRef<HTMLDivElement>(null);

  // 右栏宽度夹在 320–560，且保证左画布不小于 600
  const clampW = useCallback((w: number) => {
    const total = mainRef.current?.clientWidth ?? 1440;
    return Math.round(
      Math.max(MIN_AGENT, Math.min(MAX_AGENT, total - MIN_CANVAS, w)),
    );
  }, []);
  useEffect(() => {
    if (!wide) return;
    const onResize = () => setAgentW((w) => clampW(w));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [wide, clampW]);
  const commitW = (w: number) => writeJson(`ws:${projectId}:agentW`, w);

  const onDragStart = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const main = mainRef.current;
    if (!main) return;
    const right = main.getBoundingClientRect().right;
    const move = (ev: globalThis.PointerEvent) =>
      setAgentW(clampW(right - ev.clientX));
    const up = (ev: globalThis.PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      commitW(clampW(right - ev.clientX));
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const onSepKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = agentW + step;
    else if (e.key === "ArrowRight") next = agentW - step;
    else if (e.key === "Home") next = MIN_AGENT;
    else if (e.key === "End") next = MAX_AGENT;
    if (next === null) return;
    e.preventDefault();
    const w = clampW(next);
    setAgentW(w);
    commitW(w);
  };

  // viewport 与线程偏好由画布/Workspace 各自写入 localStorage（按项目）

  // 进行中的任务按 Run 分批，交给画布估算占位；来源图和视口中心取自发送时记下的本机元数据
  // 套图出图的任务由套图视图按 frame 显示占位；这里记下见过的套图任务 ID，避免同一张图出现两个占位
  const setTaskIds = useRef(new Set<string>());
  for (const sh of setSess.detail?.shots ?? [])
    if (sh.taskId) setTaskIds.current.add(sh.taskId);
  const batches = useMemo<PendingBatch[]>(() => {
    const s = ws.state;
    const metaOf = (runId: string, depth = 0): MessageMeta | undefined => {
      for (const list of Object.values(s.messages)) {
        const m = list.find(
          (x: Message) => x.role === "user" && x.runId === runId,
        );
        if (m) return m.meta;
      }
      const link = s.runs[runId]?.retryOf;
      const orig = link ? s.tasks[link]?.runId : undefined;
      return orig && depth < 3 ? metaOf(orig, depth + 1) : undefined;
    };
    return Object.values(s.runs)
      .map((run) => {
        const meta = metaOf(run.id);
        const slots = runTasks(s, run.id).map((t) => ({
          taskId: t.id,
          slotIndex: t.slotIndex,
          state: t.state,
          ...(t.slot ? { slot: t.slot } : {}),
          ...(t.error ? { error: t.error } : {}),
        }));
        return {
          runId: run.id,
          sourceElementId: meta?.sourceElementId ?? mediaRuns[run.id],
          viewportCenter: meta?.viewportCenter,
          slots,
        } satisfies PendingBatch;
      })
      .filter(
        (b) =>
          b.slots.length > 0 &&
          !b.slots.some((sl) => setTaskIds.current.has(sl.taskId)),
      );
  }, [ws.state, mediaRuns, setSess.detail]);
  // 套图：还没出完的张在对应 frame 上显示占位（排队/生成中/失败）
  const setBatches = useMemo<PendingBatch[]>(() => {
    const d = setSess.detail;
    if (!d) return [];
    const defs = setSess.template?.shots ?? [];
    const slots = d.shots.flatMap((s, i) =>
      s.state === "completed"
        ? []
        : [
            {
              taskId: s.taskId ?? s.shotId,
              slotIndex: i,
              state: s.state as PendingBatch["slots"][number]["state"],
              label: defs.find((x) => x.id === s.shotId)?.name ?? s.shotId,
              frameId: s.frameElementId,
              ...(s.error
                ? {
                    error: {
                      code: s.error.code,
                      message: s.error.message,
                      retryable: s.error.retryable ?? true,
                    },
                  }
                : {}),
            },
          ],
    );
    return slots.length ? [{ runId: `set:${d.setId}`, slots }] : [];
  }, [setSess.detail, setSess.template]);
  const allBatches = useMemo(() => [...batches, ...setBatches], [batches, setBatches]);
  const activeRun = activeRunOf(ws.state, ws.state.activeThreadId);

  const submitMedia = async (p: MediaParams) => {
    if (!mediaDialog) return;
    const c = canvasRef.current;
    const threadId = ws.state.activeThreadId;
    if (!c || !threadId) return;
    setMediaBusy(true);
    try {
      const input = await c.referenceInputFor(mediaDialog.elementId);
      if (!input) throw new Error("这张图还没加载完，稍后再试");
      const assetId = await input.resolveSourceAssetId();
      const api = getApi();
      const snapshot = await api.createSnapshot({
        sourceAssetId: assetId,
        appearance: {},
        renderKey: `media:${assetId}`,
      });
      const { settings } = composer.state;
      const req = {
        clientOpId: newId(),
        projectId,
        source: { elementId: mediaDialog.elementId, snapshotId: snapshot.id },
        settings: { modelId: settings.modelId, quality: settings.quality },
        // 挂到当前对话：结果和进度显示在用户正在看的线程里（该线程有进行中的 Run 时服务端返回 RUN_ACTIVE）
        threadId,
        settingsExplicitKeys: composer.state.explicit.filter(
          (k) => k === "modelId" || k === "quality",
        ),
        ...p,
      } as MediaOpRequest;
      const res = await ws.mediaOp(req);
      ws.assignRun(res.runId, res.threadId, mediaDialog.kind);
      const srcId = mediaDialog.elementId;
      setMediaRuns((m) => ({ ...m, [res.runId]: srcId }));
      setMediaDialog(null);
      toast.show(`「${mediaDialog.kind}」已提交，结果会放在原图右侧`);
    } catch (e) {
      toast.show(errorMessage(e, "提交失败"), { tone: "error" });
    } finally {
      setMediaBusy(false);
    }
  };
  const openInput = Object.values(ws.state.inputs).find(
    (i) => i.state === "open" && i.runId === activeRun?.id,
  );

  const referenceElements = useCallback(
    async (ids: string[]) => {
      const c = canvasRef.current;
      if (!c) return;
      for (const id of ids) {
        const input = await c.referenceInputFor(id);
        if (input) composer.actions.addCanvasReference(input);
      }
      setSide("agent");
      if (!wide) setTab("agent");
    },
    [composer.actions, wide],
  );

  // 引用状态：对象改动提示“较旧”，对象被删提示“已移除”；选择本身不触发任何引用
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些依赖是有意的重新执行触发条件（或只在首次进入时读取），不是遗漏
  const staleMap = useMemo(() => {
    const m: Record<string, StaleState> = {};
    const c = canvasRef.current;
    if (!c) return m;
    for (const img of composer.state.images) {
      if (img.kind !== "canvas" || !img.elementId) continue;
      if (!c.elementExists(img.elementId)) m[img.id] = "deleted";
      else {
        const key = c.appearanceKeyOf(img.elementId);
        if (
          key &&
          img.appearanceKey &&
          key !== img.appearanceKey &&
          key !== img.ackKey
        )
          m[img.id] = "stale";
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composer.state.images, sceneSig]);

  const updateReference = useCallback(
    async (imageId: string) => {
      const img = composer.state.images.find((i) => i.id === imageId);
      const c = canvasRef.current;
      if (!img?.elementId || !c) return;
      const input = await c.referenceInputFor(img.elementId);
      if (input) composer.actions.updateReference(imageId, input);
    },
    [composer.state.images, composer.actions],
  );

  const quotaBlock =
    quota && quota.used >= quota.limit
      ? "今日额度已用完，北京时间零点重置后再来"
      : undefined;

  const submit = useCallback(async () => {
    const { payload, submissionId } = composer.actions.beginSubmit(
      canvasRef.current?.getViewportCenter(),
    );
    try {
      if (openInput && openInput.choices.length === 0) {
        // 回答当前问题：发到原 Run，不是新请求
        await ws.answer(openInput.id, {
          text: payload.request.parts
            .map((p) => (p.type === "text" ? p.text : ""))
            .join(""),
        });
      } else {
        await ws.send({
          request: { ...payload.request, clientMessageId: submissionId },
          meta: payload.meta,
        });
      }
      composer.actions.clear();
    } catch (e) {
      composer.actions.endSubmit();
      const msg =
        e instanceof ApiError && e.code === "RUN_ACTIVE"
          ? "这个对话还有进行中的任务，请先等它结束或点停止"
          : errorMessage(e, "发送失败，内容已保留");
      toast.show(msg, { tone: "error" });
    }
  }, [composer.actions, ws, toast, openInput]);

  if (ws.load.status === "loading") return <WorkspaceSkeleton />;
  if (ws.load.status === "error")
    return (
      <main id="main" className="empty-state" style={{ minHeight: "100vh" }}>
        <h3>项目读取失败</h3>
        <p>{ws.load.message}</p>
        <p style={{ fontSize: "var(--fs-sm)" }}>
          只是读取失败，不会重新发送任何生成请求。
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-primary" onClick={ws.reload}>
            <RotateCw size={15} /> 重试读取
          </button>
          <Link className="btn" href="/">
            回到首页
          </Link>
        </div>
      </main>
    );

  const agent = (
    <AgentPanel
      ws={ws}
      composer={composer}
      canvasRef={canvasRef}
      sceneSig={sceneSig}
      selectionCount={selection.length}
      staleMap={staleMap}
      onReferenceSelected={() =>
        void referenceElements(selection.map((s) => s.id))
      }
      onShowCanvas={() => !wide && setTab("canvas")}
      onSubmit={() => void submit()}
      onUpdateReference={(id) => void updateReference(id)}
      onLocateReference={(elId) => {
        setTab("canvas");
        setTimeout(
          () => canvasRef.current?.locate(elId) || toast.show("画布对象已移除"),
          150,
        );
      }}
      quotaBlock={quotaBlock}
      openInput={openInput}
    />
  );
  const shown: "set" | "agent" = !setMode
    ? "agent"
    : wide
      ? side
      : tab === "set"
        ? "set"
        : "agent";
  const runningCount = ws.tasks.filter(
    (t) =>
      t.state === "queued" ||
      t.state === "submitted" ||
      t.state === "running" ||
      t.state === "ingesting",
  ).length;

  return (
    <div className="ws">
      {mediaDialog && (
        <MediaOpDialog
          kind={mediaDialog.kind}
          sourceSize={
            canvasRef.current?.elementPixels(mediaDialog.elementId) ?? null
          }
          busy={mediaBusy}
          onClose={() => setMediaDialog(null)}
          onSubmit={(p) => void submitMedia(p)}
        />
      )}
      <TopBar
        ws={ws}
        save={save}
        onRetrySave={() => canvasRef.current?.retrySave()}
        onResolveConflict={(c) => canvasRef.current?.resolveConflict(c)}
        onFit={() => canvasRef.current?.fitAll()}
        extra={
          setMode && wide ? (
            <SetActionButtons session={setSess} actions={setActions} />
          ) : null
        }
      />
      {!wide && (
        <div className="ws-tabs" role="tablist" aria-label="工作区视图">
          <button
            type="button"
            role="tab"
            id="tab-canvas"
            aria-selected={tab === "canvas"}
            aria-controls="pane-canvas"
            onClick={() => setTab("canvas")}
          >
            画布
          </button>
          {setMode && (
            <button
              type="button"
              role="tab"
              id="tab-set"
              aria-selected={tab === "set"}
              aria-controls="pane-agent"
              onClick={() => setTab("set")}
            >
              卖点
              {setSess.busyCount > 0 && (
                <span className="badge badge-accent">{setSess.busyCount} 生成中</span>
              )}
            </button>
          )}
          <button
            type="button"
            role="tab"
            id="tab-agent"
            aria-selected={tab === "agent"}
            aria-controls="pane-agent"
            onClick={() => setTab("agent")}
          >
            Agent{" "}
            {runningCount > 0 && (
              <span className="badge badge-accent">{runningCount} 进行中</span>
            )}
          </button>
        </div>
      )}
      <main
        id="main"
        className={cx("ws-main", wide ? "is-wide" : "is-narrow")}
        ref={mainRef}
        style={
          wide
            ? { gridTemplateColumns: `minmax(0,1fr) 8px ${agentW}px` }
            : undefined
        }
      >
        <div
          id="pane-canvas"
          role={wide ? undefined : "tabpanel"}
          aria-labelledby="tab-canvas"
          className={cx(
            "ws-pane ws-canvas",
            !wide && tab !== "canvas" && "is-hidden",
          )}
        >
          {ws.canvas && (
            <CanvasPane
              ref={canvasRef}
              projectId={projectId}
              initial={ws.canvas}
              theme={resolvedTheme === "dark" ? "dark" : "light"}
              batches={allBatches}
              saveOps={ws.applyOps}
              remoteOps={ws.remoteOps}
              active={wide || tab === "canvas"}
              working={!!activeRun}
              onSaveState={setSave}
              onSceneSig={setSceneSig}
              onSelection={setSelection}
              onReferenceElements={(ids) => void referenceElements(ids)}
              onNotice={(m, tone) => toast.show(m, tone ? { tone } : {})}
              onEdit={(label, elementId) => {
                const item = EDIT_ITEMS.find((i) => i.label === label);
                if (item?.ready)
                  setMediaDialog({ kind: label as MediaForm, elementId });
                else toast.show(`「${label}」即将接入`);
              }}
            />
          )}
        </div>
        {wide && (
          <div
            className="ws-sep"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整 Agent 面板宽度"
            aria-valuemin={MIN_AGENT}
            aria-valuemax={MAX_AGENT}
            aria-valuenow={agentW}
            tabIndex={0}
            onPointerDown={onDragStart}
            onKeyDown={onSepKey}
            onDoubleClick={() => {
              setAgentW(clampW(DEFAULT_AGENT));
              commitW(DEFAULT_AGENT);
            }}
          />
        )}
        <div
          id="pane-agent"
          role={wide ? undefined : "tabpanel"}
          aria-labelledby={shown === "set" ? "tab-set" : "tab-agent"}
          className={cx(
            "ws-pane ws-agent",
            !wide && tab === "canvas" && "is-hidden",
          )}
        >
          <div className="side">
            {setMode && wide && (
              <div className="side-tabs" role="tablist" aria-label="右侧面板">
                <button
                  type="button"
                  role="tab"
                  id="tab-set"
                  aria-selected={side === "set"}
                  onClick={() => setSide("set")}
                >
                  商品与卖点
                  {setSess.busyCount > 0 && (
                    <span className="badge badge-accent">{setSess.busyCount} 生成中</span>
                  )}
                </button>
                <button
                  type="button"
                  role="tab"
                  id="tab-agent"
                  aria-selected={side === "agent"}
                  onClick={() => setSide("agent")}
                >
                  Agent
                  {runningCount > 0 && (
                    <span className="badge badge-accent">{runningCount} 进行中</span>
                  )}
                </button>
              </div>
            )}
            <div className="side-body">
              {setMode && (
                <div className={cx("side-layer", shown !== "set" && "is-hidden")}>
                  <SetPanel
                    session={setSess}
                    actions={setActions}
                    canvasRef={canvasRef}
                    showActions={!wide}
                  />
                </div>
              )}
              <div className={cx("side-layer", shown !== "agent" && "is-hidden")}>{agent}</div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function TopBar({
  ws,
  save,
  onRetrySave,
  onResolveConflict,
  onFit,
  extra,
}: {
  ws: ReturnType<typeof useWorkspace>;
  save: SaveState;
  onRetrySave(): void;
  onResolveConflict(c: "mine" | "server"): void;
  onFit(): void;
  extra?: ReactNode;
}) {
  return (
    <header className="ws-top">
      <Link
        href="/"
        className="icon-btn"
        aria-label="返回首页"
        title="返回首页"
      >
        <ArrowLeft size={18} />
      </Link>
      <Link href="/" className="ws-brand" aria-label="首页">
        <BrandMark size={22} />
      </Link>
      <EditableTitle
        title={ws.state.project?.title ?? ""}
        onCommit={ws.rename}
      />
      <SaveStatus
        save={save}
        conn={ws.conn}
        onRetry={onRetrySave}
        onResolve={onResolveConflict}
        contractError={ws.contractError}
      />
      <div className="ws-top-right">
        {extra}
        <DemoBadge inline />
        <button
          type="button"
          className="icon-btn"
          aria-label="适应全部内容"
          title="适应全部内容"
          onClick={onFit}
        >
          <Maximize2 size={17} />
        </button>
        <QuotaPill />
        <ThemeToggle />
      </div>
    </header>
  );
}

function EditableTitle({
  title,
  onCommit,
}: { title: string; onCommit(t: string): Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);
  useEffect(() => setValue(title), [title]);
  const commit = async () => {
    setEditing(false);
    const t = value.trim();
    if (!t || t === title) return setValue(title);
    try {
      await onCommit(t);
    } catch (e) {
      setValue(title);
      toast.show(errorMessage(e, "改名失败"), { tone: "error" });
    }
  };
  return editing ? (
    <input
      ref={ref}
      className="input ws-title-input"
      value={value}
      maxLength={60}
      aria-label="项目名"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) void commit();
        if (e.key === "Escape") {
          setValue(title);
          setEditing(false);
        }
      }}
    />
  ) : (
    <button
      type="button"
      className="ws-title"
      onClick={() => setEditing(true)}
      title="点击改名"
    >
      <span>{title || "未命名项目"}</span>
      <Pencil size={13} aria-hidden />
    </button>
  );
}

function SaveStatus({
  save,
  conn,
  onRetry,
  onResolve,
  contractError,
}: {
  save: string;
  conn: string;
  onRetry(): void;
  onResolve(c: "mine" | "server"): void;
  contractError: string | null;
}) {
  const offline = conn === "reconnecting";
  return (
    <output className="save-status" aria-live="polite">
      {save === "conflict" ? (
        <>
          <span className="save-error">
            <AlertTriangle size={14} /> 画布有冲突
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onResolve("mine")}
            title="以服务器最新版本为基线，重新提交我的改动"
          >
            保留我的
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onResolve("server")}
            title="冲突的对象改用服务器上的版本"
          >
            采用服务器版本
          </button>
        </>
      ) : save === "error" ? (
        <>
          <span className="save-error">
            <AlertTriangle size={14} /> 保存失败
          </span>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            重试
          </button>
        </>
      ) : save === "saving" ? (
        <span>
          <span className="spinner" aria-hidden /> 保存中…
        </span>
      ) : save === "dirty" ? (
        <span>有改动，稍后保存</span>
      ) : (
        <span className="save-ok">
          <Check size={14} /> 已保存
        </span>
      )}
      {offline && (
        <span
          className="badge badge-warn"
          title="正在自动重连，已确认的任务不会重复提交"
        >
          <CloudOff size={12} /> 重新连接中
        </span>
      )}
      {contractError && (
        <span className="badge badge-danger" title={contractError}>
          <AlertTriangle size={12} /> 接口数据异常
        </span>
      )}
      {conn === "open" && <Wifi size={0} aria-hidden />}
    </output>
  );
}

function WorkspaceSkeleton() {
  return (
    <div className="ws" aria-busy="true">
      <header className="ws-top">
        <div className="skeleton" style={{ width: 160, height: 20 }} />
      </header>
      <main
        className="ws-main is-wide"
        style={{ gridTemplateColumns: `minmax(0,1fr) 8px ${DEFAULT_AGENT}px` }}
      >
        <output className="ws-pane ws-canvas canvas-loading">
          <span className="spinner spinner-lg" /> 正在载入项目…
        </output>
        <div />
        <div
          className="ws-pane ws-agent"
          style={{
            padding: 16,
            display: "grid",
            gap: 12,
            alignContent: "start",
          }}
        >
          <div className="skeleton" style={{ height: 36 }} />
          <div className="skeleton" style={{ height: 80 }} />
          <div className="skeleton" style={{ height: 140 }} />
        </div>
      </main>
    </div>
  );
}
