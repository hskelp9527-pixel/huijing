"use client";

import {
  AlertCircle,
  Check,
  ChevronDown,
  Crosshair,
  Download,
  Loader2,
  MessageSquarePlus,
  MousePointerSquareDashed,
  RotateCw,
  Sparkles,
  Undo2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  type Artifact,
  type InputRequestView,
  type Message,
  PURPOSE_LABEL,
  type Run,
  type RunTiming,
  type Step,
  type StepStatus,
  TASK_TERMINAL,
  type Task,
  type TaskState,
  getApi,
  modelLabel,
} from "../../lib/api";
import { useCapabilities } from "../../lib/capabilities";
import { fmtElapsed, useNow } from "../../lib/elapsed";
import {
  cx,
  downloadUrl,
  errorMessage,
  extFor,
  must,
  relativeTime,
} from "../../lib/utils";
import {
  activeRunOf,
  runSteps,
  runTasks,
  threadRuns,
} from "../../state/workspace-store";
import { Composer, type StaleState } from "../composer/composer";
import type { ComposerController } from "../composer/use-composer";
import { Popover } from "../ui/popover";
import { useToast } from "../ui/toast";
import type { CanvasHandle } from "./canvas-pane";
import type { useWorkspace } from "./use-workspace";

type Workspace = ReturnType<typeof useWorkspace>;

const RUN_LABEL: Record<Run["state"], { text: string; tone: string }> = {
  queued: { text: "排队中", tone: "badge-info" },
  planning: { text: "理解需求中", tone: "badge-info" },
  running: { text: "生成中", tone: "badge-accent" },
  waiting_input: { text: "等你回答", tone: "badge-warn" },
  completed: { text: "已完成", tone: "badge-ok" },
  failed: { text: "未完成", tone: "badge-danger" },
  cancelled: { text: "已停止", tone: "" },
};
const TOOL_LABEL: Record<Step["tool"], string> = {
  agent_delegate: "子任务",
  canvas_apply: "整理画布",
  media_ocr: "识别文字",
  read_canvas: "读取画布",
  generate_images: "生成图片",
  edit_image: "编辑图片",
  ask_user: "确认需求",
};
const allTasksDone = (tasks: Task[]) =>
  tasks.length > 0 && tasks.every((t) => TASK_TERMINAL.includes(t.state));

/** 把 Run 的状态换成对用户有意义的描述（planning 其实是 Agent 在理解需求、读画布、决定怎么画） */
function runPhase(run: Run, tasks: Task[]): string {
  if (run.state === "running")
    return allTasksDone(tasks)
      ? "整理回复中"
      : tasks.length
        ? "生成中"
        : "处理中";
  // 服务端在等文本模型时会带一句明确的阶段说明，优先显示
  if ((run.state === "planning" || run.state === "queued") && run.summary)
    return run.summary;
  return RUN_LABEL[run.state].text;
}

const ROLE_LABEL: Record<NonNullable<Step["role"]>, string> = {
  orchestrator: "主 Agent",
  "reference-review": "参考图分析",
  concept: "构思方案",
  "quality-review": "质量检查",
};
const PHASE_LABEL: Record<RunTiming["phase"], string> = {
  read_canvas: "读取画布",
  model: "模型思考",
  tool: "调用工具",
  image: "图片生成",
  ingest: "保存并放入画布",
  review: "质量检查",
};
const fmtMs = (ms: number) => fmtElapsed(ms);

/** 图片类步骤的文字随任务状态变化：排队 → 生成中 → 已完成（含耗时） */
function imageStepView(
  step: Step,
  tasks: Task[],
  now: number,
  run: Run,
): { status: StepStatus; detail: string } {
  if (!tasks.length) return { status: step.status, detail: step.summary };
  const done = tasks.filter((t) => t.state === "committed").length;
  const failed = tasks.filter((t) => t.state === "failed").length;
  const cancelled = tasks.filter((t) => t.state === "cancelled").length;
  const starts = tasks.flatMap((t) => (t.startedAt ? [t.startedAt] : []));
  const ends = tasks.flatMap((t) => (t.endedAt ? [t.endedAt] : []));
  const start = starts.length ? Math.min(...starts) : undefined;
  const finished = allTasksDone(tasks);
  const span = (to: number | undefined) =>
    start !== undefined && to !== undefined
      ? fmtElapsed(Math.max(0, to - start))
      : "";
  if (finished) {
    // 刷新后任务没有事件时间戳，用服务端持久化的耗时（图片阶段）兜底
    const imageMs = (run.timings ?? [])
      .filter((t) => t.phase === "image")
      .reduce((m, t) => Math.max(m, t.durationMs), 0);
    const took = ends.length
      ? span(Math.max(...ends))
      : imageMs
        ? fmtMs(imageMs)
        : "";
    const tail = took ? ` · 用时 ${took}` : "";
    if (failed) {
      return {
        status: "failed",
        detail: `${done ? `${done} 张已完成，` : ""}${failed} 张未完成${tail}`,
      };
    }
    if (cancelled && !done) return { status: "failed", detail: "已停止" };
    return { status: "completed", detail: `已完成 · ${done} 张${tail}` };
  }
  const elapsed = span(now);
  const waiting = tasks.every((t) => t.state === "queued");
  const saving = tasks.some((t) => t.state === "ingesting");
  const phase = waiting ? "排队中" : saving ? "保存中" : "生成中";
  const progress = tasks.length > 1 ? ` · 已完成 ${done}/${tasks.length}` : "";
  return {
    status: "started",
    detail: `${phase}${progress}${elapsed ? ` · 已用 ${elapsed}` : ""}`,
  };
}

const STAGES: Array<{ id: TaskState; label: string }> = [
  { id: "queued", label: "排队" },
  { id: "submitted", label: "已提交" },
  { id: "running", label: "生成" },
  { id: "ingesting", label: "保存" },
];

interface Props {
  ws: Workspace;
  composer: ComposerController;
  canvasRef: React.RefObject<CanvasHandle | null>;
  sceneSig: string;
  selectionCount: number;
  staleMap: Record<string, StaleState>;
  onReferenceSelected(): void;
  onShowCanvas(): void;
  onSubmit(): void;
  onUpdateReference(imageId: string): void;
  onLocateReference(elementId: string): void;
  quotaBlock: string | undefined;
  /** 当前等待回答的追问（没有选项时可直接在输入框里回答） */
  openInput: InputRequestView | undefined;
}

export function AgentPanel(props: Props) {
  const { ws, composer, canvasRef, openInput } = props;
  const toast = useToast();
  const s = ws.state;
  const threadId = s.activeThreadId;
  const messages = threadId ? s.messages[threadId] : undefined;
  const activeRun = activeRunOf(s, threadId);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 自动滚动：贴底时跟随，用户上滑阅读时不抢滚动
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el)
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些依赖是有意的重新执行触发条件（或只在首次进入时读取），不是遗漏
  useEffect(() => {
    stick.current = true;
  }, [threadId]);

  const answerMode = !!openInput && openInput.choices.length === 0;
  const runs = threadId ? threadRuns(s, threadId) : [];
  const userMessages = (messages ?? []).filter((m) => m.role === "user");
  // 每个用户消息对应的 Run，加上对该 Run 里任务的重试 Run；其余没有归属的 Run 放到最后
  const shown = new Set<string>();
  const blocks = userMessages.map((m) => {
    const own = runs.filter((r) => r.id === m.runId);
    const ownTaskIds = new Set(
      own.flatMap((r) => runTasks(s, r.id).map((t) => t.id)),
    );
    const retries = runs.filter((r) => r.retryOf && ownTaskIds.has(r.retryOf));
    for (const r of [...own, ...retries]) shown.add(r.id);
    return { message: m, runs: [...own, ...retries] };
  });
  const orphans = runs.filter((r) => !shown.has(r.id));

  return (
    <section className="agent" aria-label="Agent 对话">
      <ThreadBar ws={ws} />
      <div
        className="agent-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {!threadId ? (
          <EmptyThread onNew={() => void ws.newThread()} />
        ) : ws.threadErr[threadId] ? (
          <div className="notice notice-error" role="alert">
            <span>{ws.threadErr[threadId]}（不会重发任何消息）</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void ws.loadThread(threadId)}
            >
              重试读取
            </button>
          </div>
        ) : !s.loaded[threadId] ? (
          <ThreadSkeleton />
        ) : userMessages.length === 0 && orphans.length === 0 ? (
          <EmptyThread onNew={undefined} />
        ) : (
          <>
            {blocks.map(({ message, runs: rs }) => (
              <div className="turn" key={message.id}>
                <UserBubble m={message} />
                {rs.map((r, i) => (
                  <RunBlock
                    key={r.id}
                    run={r}
                    retry={i > 0 || !!r.retryOf}
                    message={message}
                    {...props}
                  />
                ))}
              </div>
            ))}
            {orphans.map((r) => (
              <RunBlock key={r.id} run={r} retry {...props} />
            ))}
          </>
        )}
      </div>
      <div className="agent-composer">
        <Composer
          controller={composer}
          variant="dock"
          placeholder={
            answerMode
              ? "输入你的回答…"
              : userMessages.length
                ? "继续描述，或在画布上选一张图再改…"
                : "描述你想要的画面…"
          }
          onSubmit={props.onSubmit}
          runActive={!!activeRun && !answerMode}
          onStop={
            activeRun
              ? () =>
                  void ws.cancel(activeRun.id).catch((e) =>
                    toast.show(errorMessage(e, "停止失败"), {
                      tone: "error",
                    }),
                  )
              : undefined
          }
          blockedReason={props.quotaBlock}
          canvasSelection={{
            count: props.selectionCount,
            onReference: props.onReferenceSelected,
          }}
          staleMap={props.staleMap}
          onUpdateReference={props.onUpdateReference}
          onLocateReference={props.onLocateReference}
          answerBanner={
            openInput
              ? {
                  question: openInput.question,
                  ...(activeRun
                    ? {
                        onSwitchToNew: () =>
                          void ws
                            .cancel(activeRun.id)
                            .then(() => taRef.current?.focus()),
                      }
                    : {}),
                }
              : undefined
          }
          textareaRef={taRef}
        />
      </div>
    </section>
  );
}

function ThreadBar({ ws }: { ws: Workspace }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const cur = ws.state.threads.find((t) => t.id === ws.state.activeThreadId);
  return (
    <div className="thread-bar">
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        className="menu thread-menu"
        trigger={
          <button
            type="button"
            className="btn btn-ghost btn-sm thread-trigger"
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <span>{cur?.title ?? "还没有对话"}</span>
            <ChevronDown size={14} />
          </button>
        }
      >
        <div aria-label="对话列表">
          {ws.state.threads.length === 0 && (
            <div className="menu-empty">还没有对话</div>
          )}
          {[...ws.state.threads]
            .filter((t) => t.title !== "图片后处理")
            .reverse()
            .map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={t.id === ws.state.activeThreadId}
                onClick={() => {
                  ws.selectThread(t.id);
                  setOpen(false);
                }}
              >
                <span className="thread-item-title">{t.title}</span>
                <small>{relativeTime(t.createdAt)}</small>
              </button>
            ))}
        </div>
      </Popover>
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await ws.newThread();
          } catch (e) {
            toast.show(errorMessage(e, "新建对话失败"), { tone: "error" });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? (
          <span className="spinner" aria-hidden />
        ) : (
          <MessageSquarePlus size={15} />
        )}{" "}
        新对话
      </button>
    </div>
  );
}

function EmptyThread({ onNew }: { onNew: (() => void) | undefined }) {
  return (
    <div className="empty-state agent-empty">
      <Sparkles size={22} aria-hidden style={{ color: "var(--accent)" }} />
      <h3>从一句话开始</h3>
      <p>
        描述你想要的画面；也可以在画布上选中一张图，点“引用所选”，让它继续被修改。共享的画布会保留在所有对话里。
      </p>
      {onNew && (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onNew}
        >
          新建对话
        </button>
      )}
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="agent-skeleton" aria-busy="true" aria-label="正在读取对话">
      <div
        className="skeleton"
        style={{ height: 56, width: "70%", marginLeft: "auto" }}
      />
      <div className="skeleton" style={{ height: 120 }} />
      <div className="skeleton" style={{ height: 80, width: "85%" }} />
    </div>
  );
}

function UserBubble({ m }: { m: Message }) {
  const caps = useCapabilities();
  const meta = m.meta;
  const api = getApi();
  const refs = [...(meta?.references ?? [])].sort((a, b) => a.order - b.order);
  return (
    <div className="msg msg-user">
      <p className="msg-text">{m.text}</p>
      {refs.length > 0 && (
        <ul className="msg-refs" aria-label="本条消息的参考图（发送时的版本）">
          {refs.map((r) => (
            <li key={r.snapshotId} className="msg-ref">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={r.previewUrl ?? (r.assetId ? api.assetUrl(r.assetId) : "")}
                alt="参考图"
              />
              <span>{PURPOSE_LABEL[r.purpose]}</span>
            </li>
          ))}
        </ul>
      )}
      {meta && (
        <p className="msg-meta">
          {meta.settings.count} 张 ·{" "}
          {meta.settings.aspectRatio !== "auto"
            ? meta.settings.aspectRatio
            : "自动比例"}{" "}
          · {meta.settings.quality === "high" ? "2K" : "1K"} ·{" "}
          {modelLabel(meta.settings.modelId, caps?.models)}
        </p>
      )}
    </div>
  );
}

function RunBlock({
  run,
  retry,
  message,
  ws,
  canvasRef,
  sceneSig,
  onShowCanvas,
  composer,
}: { run: Run; retry: boolean; message?: Message } & Props) {
  const s = ws.state;
  const steps = runSteps(s, run.id);
  const tasks = runTasks(s, run.id);
  const label = RUN_LABEL[run.state];
  const inputs = Object.values(s.inputs).filter((i) => i.runId === run.id);
  const live =
    run.state === "queued" ||
    run.state === "planning" ||
    run.state === "running";
  const now = useNow(
    live || tasks.some((t) => !TASK_TERMINAL.includes(t.state)),
  );
  const startedAt =
    run.startedAt ?? (message ? Date.parse(message.createdAt) : undefined);
  const elapsed =
    startedAt !== undefined && Number.isFinite(startedAt)
      ? fmtElapsed((run.endedAt ?? now) - startedAt)
      : "";
  const phase = runPhase(run, tasks);
  const finals = (s.messages[run.threadId] ?? []).filter(
    (m) => m.role === "assistant" && m.runId === run.id,
  );
  const ref0 = message?.meta?.references[0];
  const sourceThumb =
    ref0?.previewUrl ??
    (ref0?.assetId ? getApi().assetUrl(ref0.assetId) : undefined);
  return (
    <article className="run" aria-label={retry ? "重试" : "Agent 执行"}>
      <header className="run-head">
        <span className="run-title">
          {run.label
            ? `图片后处理 · ${run.label}`
            : retry
              ? "重试失败项"
              : "Agent"}
        </span>
        <span className={cx("badge", label.tone)}>
          {live && <span className="pulse-dot" aria-hidden />}
          {phase}
          {elapsed ? ` · ${elapsed}` : ""}
        </span>
      </header>
      {live && <div className="run-progress" role="presentation" aria-hidden />}
      {live && steps.length === 0 && (
        <output className="run-working">
          {run.state === "queued"
            ? "已收到，正在排队…"
            : "正在读懂你的需求，决定怎么画…"}
        </output>
      )}
      {steps.length > 0 && (
        <ol className="steps">
          {steps.map((st) => (
            <StepRow key={st.id} step={st} tasks={tasks} now={now} run={run} />
          ))}
        </ol>
      )}
      {live && run.state === "running" && allTasksDone(tasks) && (
        <output className="run-working">
          图片已放入画布，Agent 正在做收尾检查，可以随时点“停止”结束。
        </output>
      )}
      {inputs.map((i) => (
        <InputCard key={i.id} req={i} ws={ws} />
      ))}
      {!live && run.timings && run.timings.length > 0 && (
        <details className="run-timings">
          <summary>耗时明细</summary>
          <ul>
            {run.timings.map((t, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 耗时分段没有稳定 id，只读展示
              <li key={i}>
                <span>{PHASE_LABEL[t.phase]}</span>
                <span>{fmtMs(t.durationMs)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {tasks.length > 0 && (
        <div className="task-list">
          {tasks.map((t) => {
            const art = t.artifactId ? s.artifacts[t.artifactId] : undefined;
            return art && t.state === "committed" ? (
              <ResultCard
                key={t.id}
                artifact={art}
                sourceThumb={sourceThumb}
                canvasRef={canvasRef}
                sceneSig={sceneSig}
                onShowCanvas={onShowCanvas}
                composer={composer}
              />
            ) : (
              <TaskCard
                key={t.id}
                task={t}
                ws={ws}
                superseded={Object.values(s.runs).some(
                  (r) => r.retryOf === t.id,
                )}
              />
            );
          })}
        </div>
      )}
      {run.state === "failed" && run.error && tasks.length === 0 && (
        <div className="notice notice-error" role="alert">
          {run.error.message}
        </div>
      )}
      {finals.map((m) => (
        <p key={m.id} className="run-final">
          {m.text}
        </p>
      ))}
    </article>
  );
}

function StepRow({
  step,
  tasks,
  now,
  run,
}: { step: Step; tasks: Task[]; now: number; run: Run }) {
  const isImage = step.tool === "generate_images" || step.tool === "edit_image";
  const view = isImage
    ? imageStepView(step, tasks, now, run)
    : { status: step.status, detail: step.summary };
  const detail = view.detail;
  // Run 已经结束但步骤还停在“进行中”（事件丢失/被取消）：不再转圈，按 Run 结果显示
  const ended =
    run.state === "completed" ||
    run.state === "failed" ||
    run.state === "cancelled";
  const status: StepStatus =
    view.status === "started" && ended
      ? run.state === "completed"
        ? "completed"
        : "failed"
      : view.status;
  const title =
    step.tool === "agent_delegate" && step.role
      ? ROLE_LABEL[step.role]
      : TOOL_LABEL[step.tool];
  return (
    <li
      className={cx(
        "step",
        `step-${status === "started" ? "running" : status === "completed" ? "done" : "failed"}`,
      )}
    >
      <span className="step-icon" aria-hidden>
        {status === "started" ? (
          <Loader2 size={14} className="spin" />
        ) : status === "completed" ? (
          <Check size={14} />
        ) : (
          <AlertCircle size={14} />
        )}
      </span>
      <div>
        <div className="step-title">{title}</div>
        {detail && detail !== title && (
          <div className="step-detail">{detail}</div>
        )}
      </div>
    </li>
  );
}

function InputCard({ req, ws }: { req: InputRequestView; ws: Workspace }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const open = req.state === "open";
  return (
    <fieldset
      className={cx("input-card", !open && "is-closed")}
      aria-label="Agent 的追问"
    >
      <p>
        <b>Agent 想确认：</b>
        {req.question}
      </p>
      {req.choices.length > 0 && (
        <div className="input-choices">
          {req.choices.map((c) => (
            <button
              key={c.id}
              type="button"
              className="btn btn-sm"
              disabled={!open || !!busy}
              onClick={async () => {
                setBusy(c.id);
                try {
                  await ws.answer(req.id, { choiceId: c.id });
                } catch (e) {
                  toast.show(
                    errorMessage(e, "回答失败，这个问题可能已经结束"),
                    { tone: "error" },
                  );
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === c.id && <span className="spinner" aria-hidden />}{" "}
              {c.label}
            </button>
          ))}
        </div>
      )}
      {open && req.choices.length === 0 && (
        <small>在下面的输入框里回答即可。</small>
      )}
      {!open && <small>已回答</small>}
    </fieldset>
  );
}

function TaskCard({
  task,
  ws,
  superseded,
}: { task: Task; ws: Workspace; superseded: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const failed = task.state === "failed";
  const cancelled = task.state === "cancelled";
  const limited = task.error?.code === "RATE_LIMITED";
  const idx = STAGES.findIndex((x) => x.id === task.state);
  const canRetry = (failed && (task.error?.retryable ?? true)) || cancelled;
  return (
    <div
      className={cx("task", failed && "is-failed", cancelled && "is-cancelled")}
      data-state={task.state}
    >
      <div className="task-head">
        <b>方案 {task.slotIndex + 1}</b>
        {failed ? (
          <span
            className={cx(
              "badge",
              superseded ? "" : limited ? "badge-warn" : "badge-danger",
            )}
          >
            {superseded ? "已重试" : limited ? "稍后重试" : "未生成"}
          </span>
        ) : cancelled ? (
          <span className="badge">{superseded ? "已重试" : "已停止"}</span>
        ) : (
          <span className="badge badge-accent">
            {STAGES[idx]?.label ?? task.state}
          </span>
        )}
      </div>
      {!failed && !cancelled && (
        <ol className="stages" aria-label="任务阶段">
          {STAGES.map((st, i) => (
            <li
              key={st.id}
              className={cx(i < idx && "is-done", i === idx && "is-current")}
              aria-current={i === idx ? "step" : undefined}
            >
              {st.label}
            </li>
          ))}
        </ol>
      )}
      {failed && task.error && (
        <p className="task-error">{task.error.message}</p>
      )}
      {canRetry && !superseded && (
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await ws.retryTask(task.id);
            } catch (e) {
              toast.show(errorMessage(e, "重试失败"), { tone: "error" });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <span className="spinner" aria-hidden />
          ) : (
            <RotateCw size={13} />
          )}{" "}
          重试
        </button>
      )}
    </div>
  );
}

function ResultCard({
  artifact: a,
  sourceThumb,
  canvasRef,
  sceneSig,
  onShowCanvas,
  composer,
}: {
  artifact: Artifact;
  sourceThumb: string | undefined;
  canvasRef: React.RefObject<CanvasHandle | null>;
  sceneSig: string;
  onShowCanvas(): void;
  composer: ComposerController;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [, force] = useState(0);
  void sceneSig; // 画布变化时重新计算“是否仍在画布上”
  const canvas = canvasRef.current;
  const elId = canvas?.findArtifactElement(a.id) ?? null;
  const { asset } = a;
  const name = `方案${a.slotIndex + 1}`;
  const placing = !elId && !!a.elementIds?.length && !canvas;
  // 事件顺序是 canvas.ops → artifact.committed，画布异步应用；给一小段宽限时间再判定“已移除”
  const [born] = useState(() => Date.now());
  const grace = !elId && Date.now() - born < 2500;
  useEffect(() => {
    if (!grace) return;
    const t = setTimeout(() => force((n) => n + 1), 2600 - (Date.now() - born));
    return () => clearTimeout(t);
  }, [grace, born]);
  const removed = !!canvas && !elId && !grace;

  const run = async (key: string, fn: () => Promise<void> | void) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.show(errorMessage(e, "操作失败"), { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <figure className="result" data-testid="result-card">
      <div className="result-img">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={asset.url}
          width={asset.width}
          height={asset.height}
          alt={`${name} 的生成结果`}
          loading="lazy"
        />
      </div>
      <figcaption>
        <div className="result-line">
          <b>方案 {a.slotIndex + 1}</b>
          <span className="result-size" title="实际像素">
            {asset.width}×{asset.height}
          </span>
          <span className="badge badge-ok">
            <Check size={12} /> 已完成
          </span>
          {a.mode === "fixture" && (
            <span
              className="badge badge-warn"
              title="这是后端演示模式生成的占位图，不是真实模型输出"
            >
              演示结果
            </span>
          )}
          {sourceThumb && (
            <span className="result-src" title="这次修改所基于的来源图">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={sourceThumb} alt="来源图" /> 来源
            </span>
          )}
        </div>
        {removed ? (
          <output className="result-removed">
            <span>画布对象已移除</span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy === "reinsert"}
              onClick={() =>
                run("reinsert", async () => {
                  const c = must(canvas, "画布");
                  const id = await c.reinsertArtifact(a);
                  onShowCanvas();
                  setTimeout(() => c.locate(id), 250);
                  toast.show("已重新放入画布（新对象，没有重新生成）");
                })
              }
            >
              <Undo2 size={13} /> 重新放入
            </button>
          </output>
        ) : grace || placing ? (
          <p className="result-note">
            <Loader2 size={12} className="spin" /> 正在放入画布…
          </p>
        ) : null}
        <div className="result-actions">
          <button
            type="button"
            className="btn btn-sm"
            disabled={!elId}
            onClick={() => {
              onShowCanvas();
              setTimeout(() => {
                if (elId && !canvasRef.current?.locate(elId))
                  toast.show("画布对象已移除");
              }, 150);
            }}
          >
            <Crosshair size={13} /> 在画布定位
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy === "ref"}
            onClick={() =>
              run("ref", async () => {
                if (!canvas) return;
                composer.actions.addCanvasReference(
                  await canvas.referenceInputForArtifact(a),
                );
              })
            }
          >
            <MousePointerSquareDashed size={13} /> 引用
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy === "dl"}
            onClick={() =>
              run("dl", () =>
                downloadUrl(
                  asset.url,
                  `${name}-${asset.width}x${asset.height}.${extFor(asset.mime, asset.url)}`,
                ),
              )
            }
          >
            <Download size={13} /> 下载
          </button>
        </div>
      </figcaption>
    </figure>
  );
}
