"use client";

import {
  AlertTriangle,
  Check,
  Download,
  Locate,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { sellingPointSchema } from "@loomic/shared/edge";

import { ApiError, getApi } from "../../lib/api";
import type {
  PatchAnalysisBody,
  RegenerateScope,
  SellingPoint,
  SetAnalysis,
  SetShotDef,
  SetShotStatus,
} from "../../lib/sets/types";
import { makeZip } from "../../lib/sets/zip";
import { useSession } from "../../lib/session";
import { cx, errorMessage } from "../../lib/utils";
import { useToast } from "../ui/toast";
import type { CanvasHandle } from "./canvas-pane";
import { type useSetSession, shotBusy } from "./use-set-session";

type Session = ReturnType<typeof useSetSession>;

// 与 shared 的 productAnalysisSchema 一致：3–5 个卖点
const MIN_POINTS = 3;
const MAX_POINTS = 5;
const SAVE_DELAY = 700;
const STATE_LABEL: Record<SetShotStatus["state"], string> = {
  queued: "排队中",
  submitted: "已提交",
  running: "生成中",
  ingesting: "入库中",
  completed: "已完成",
  failed: "未生成",
  cancelled: "已取消",
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, "-");

/** 套图的整体操作：整套重新生成、单张重出、下载全套。顶栏和面板共用同一份状态。 */
export function useSetActions(
  session: Session,
  canvasRef: RefObject<CanvasHandle | null>,
  title: string,
) {
  const toast = useToast();
  const { remaining, refresh } = useSession();
  const [busy, setBusy] = useState<"download" | "regen" | null>(null);
  const { detail, template, reload } = session;

  const regenShot = useCallback(
    async (shotId: string) => {
      if (!detail) return;
      try {
        await getApi().regenerateShot(detail.setId, shotId);
        void refresh();
        void reload();
      } catch (e) {
        console.warn("[set] 单张重出失败", shotId, e);
        toast.show(errorMessage(e, "重新生成失败"), { tone: "error" });
        if (e instanceof ApiError && e.code === "QUOTA_EXCEEDED") void refresh();
        else void reload();
      }
    },
    [detail, refresh, reload, toast],
  );

  /**
   * 重出失败的 / 整套重出（POST /api/sets/:id/regenerate，按张预扣，额度不足整体拒绝）。
   * 接口还没上线（404/405）时退回逐张调用单张重出，功能不丢。
   */
  const regenSet = useCallback(
    async (scope: RegenerateScope) => {
      if (!detail || busy) return;
      const targets = detail.shots.filter(
        (x) => !shotBusy(x) && (scope === "all" || x.state === "failed"),
      );
      if (!targets.length) return;
      if (remaining !== null && remaining < targets.length) {
        toast.show(
          `今天还能生成 ${remaining} 张，这次需要 ${targets.length} 张。可以在右侧逐张重新生成`,
          { tone: "error" },
        );
        return;
      }
      setBusy("regen");
      try {
        try {
          await getApi().regenerateSet(detail.setId, scope);
        } catch (e) {
          if (!(e instanceof ApiError && (e.status === 404 || e.status === 405))) throw e;
          console.warn("[set] 整套重出接口未就绪，退回逐张重出", e);
          for (const t of targets) await getApi().regenerateShot(detail.setId, t.shotId);
        }
        toast.show(`已开始重新生成 ${targets.length} 张`);
      } catch (e) {
        console.warn("[set] 重新生成失败", scope, e);
        toast.show(errorMessage(e, "重新生成失败"), { tone: "error" });
      } finally {
        setBusy(null);
        void refresh();
        void reload();
      }
    },
    [detail, busy, remaining, toast, refresh, reload],
  );

  const download = useCallback(async () => {
    if (!detail || busy) return;
    const done = detail.shots.filter((s) => s.state === "completed");
    if (!done.length) {
      toast.show("还没有出完的图可以下载");
      return;
    }
    const c = canvasRef.current;
    if (!c) return;
    setBusy("download");
    try {
      const defs = template?.shots ?? [];
      const blobs = await c.exportFrames(done.map((s) => s.frameElementId));
      if (!blobs.length) throw new Error("画布上找不到这些图，请刷新后重试");
      const files = await Promise.all(
        blobs.map(async (b) => {
          const shot = done.find((s) => s.frameElementId === b.id);
          const idx = defs.findIndex((d) => d.id === shot?.shotId);
          const name = defs[idx]?.name ?? shot?.shotId ?? "image";
          return {
            name: `${pad2((idx < 0 ? 0 : idx) + 1)}-${safeName(name)}.png`,
            data: new Uint8Array(await b.blob.arrayBuffer()),
          };
        }),
      );
      files.sort((a, b) => a.name.localeCompare(b.name));
      const zip = makeZip(files);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(zip);
      a.download = `${safeName(title || "套图")}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      const left = detail.shots.length - done.length;
      toast.show(
        left > 0
          ? `已下载 ${done.length} 张（还有 ${left} 张没出完，没有放进压缩包）`
          : `已下载全套 ${done.length} 张，文字已合成进图片`,
      );
    } catch (e) {
      console.error("[set] 下载全套失败", e);
      toast.show(errorMessage(e, "下载失败，请重试"), { tone: "error" });
    } finally {
      setBusy(null);
    }
  }, [detail, busy, template, canvasRef, title, toast]);

  return { busy, regenShot, regenSet, download, remaining };
}
export type SetActions = ReturnType<typeof useSetActions>;

/** 「重出失败的」「整套重出」「下载全套」。重出会再花额度，所以先二次确认。 */
export function SetActionButtons({
  session,
  actions,
  compact = false,
}: { session: Session; actions: SetActions; compact?: boolean }) {
  const { detail } = session;
  const [confirm, setConfirm] = useState<RegenerateScope | null>(null);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(null), 5000);
    return () => clearTimeout(t);
  }, [confirm]);
  if (!detail) return null;
  const idle = detail.shots.filter((s) => !shotBusy(s)).length;
  const failed = detail.shots.filter((s) => s.state === "failed").length;
  const done = detail.shots.filter((s) => s.state === "completed").length;
  const need = confirm === "failed" ? failed : idle;
  const noQuota = actions.remaining !== null && actions.remaining < need;
  const disabled = actions.busy !== null;
  return (
    <div className={cx("set-actions", compact && "is-compact")}>
      {confirm ? (
        <>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={noQuota || disabled}
            onClick={() => {
              const scope = confirm;
              setConfirm(null);
              void actions.regenSet(scope);
            }}
            title={noQuota ? "今天的额度不够这次重出" : undefined}
          >
            确认，再用 {need} 张额度
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>
            取消
          </button>
        </>
      ) : (
        <>
          {failed > 0 && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={disabled}
              onClick={() => setConfirm("failed")}
              title="只重新生成没成功的图"
            >
              {actions.busy === "regen" ? <span className="spinner" aria-hidden /> : <RefreshCw size={14} />}
              重出失败的（{failed}）
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            disabled={idle === 0 || disabled}
            onClick={() => setConfirm("all")}
            title="按当前卖点把每一张都重新出图（会再消耗额度）"
          >
            {actions.busy === "regen" && failed === 0 ? <span className="spinner" aria-hidden /> : <RefreshCw size={14} />}
            整套重出
          </button>
        </>
      )}
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={done === 0 || disabled}
        onClick={() => void actions.download()}
        title="每张图导出为 PNG，文字图层已合成，打包成 ZIP"
      >
        {actions.busy === "download" ? <span className="spinner" aria-hidden /> : <Download size={14} />}
        下载全套
      </button>
    </div>
  );
}

type SaveState = "idle" | "saving" | "saved" | "error" | "invalid";
interface Draft {
  productName: string;
  audience: string;
  points: SellingPoint[];
}
/** 与 shared 的 productAnalysisSchema 同规则：3–5 个卖点，每条标题（≤12 字或 6 个英文词）和说明（≤30 字）都不能为空 */
function validateDraft(d: Draft): string | null {
  if (!d.productName.trim()) return "商品名不能为空";
  if (!d.audience.trim()) return "目标人群不能为空";
  if (d.points.length < MIN_POINTS || d.points.length > MAX_POINTS)
    return `卖点需要 ${MIN_POINTS}–${MAX_POINTS} 条`;
  for (const [i, p] of d.points.entries()) {
    const r = sellingPointSchema.safeParse({ title: p.title, detail: p.detail });
    if (!r.success) return `卖点 ${i + 1}：${pointIssue(p)}`;
  }
  return null;
}
function pointIssue(p: SellingPoint): string {
  if (!p.title.trim() || !p.detail.trim()) return "标题和说明都要填";
  if (p.detail.trim().length > 30) return "说明最多 30 字";
  return "标题最多 12 字（英文 6 个词）";
}
const draftOf = (a: SetAnalysis): Draft => ({
  productName: a.productName,
  audience: a.audience,
  points: a.sellingPoints.map((p) => ({ ...p })),
});

/** 右侧默认面板：商品与卖点（可编辑）+ 每张图的状态与重出 */
export function SetPanel({
  session,
  actions,
  canvasRef,
  showActions,
}: {
  session: Session;
  actions: SetActions;
  canvasRef: RefObject<CanvasHandle | null>;
  showActions: boolean;
}) {
  const { detail, template, error, reload } = session;
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef<Draft | null>(null);
  latest.current = draft;
  const setId = detail?.setId;

  // 分析结果到达（首次、或别处改了）时同步草稿；用户正在编辑/还没存出去的改动优先，不被服务端回显覆盖
  const analysis = detail?.analysis;
  useEffect(() => {
    if (analysis && !dirty.current) setDraft(draftOf(analysis));
  }, [analysis]);
  const analysisRef = useRef(analysis);
  analysisRef.current = analysis;

  const flush = useCallback(async () => {
    const d = latest.current;
    const base = analysisRef.current;
    if (!setId || !d || !base || !dirty.current) return;
    const issue = validateDraft(d);
    if (issue) {
      // 不合法的草稿不发给服务端（会被 422 拒绝）；用户改好之后会自动再存
      setSave("invalid");
      return;
    }
    dirty.current = false;
    const body: PatchAnalysisBody = {};
    const productName = d.productName.trim();
    const audience = d.audience.trim();
    const points = d.points.map((p) => ({ title: p.title.trim(), detail: p.detail.trim() }));
    if (productName !== base.productName) body.productName = productName;
    if (audience !== base.audience) body.audience = audience;
    if (JSON.stringify(points) !== JSON.stringify(base.sellingPoints)) body.sellingPoints = points;
    if (!Object.keys(body).length) {
      setSave("idle");
      return;
    }
    setSave("saving");
    try {
      await getApi().patchAnalysis(setId, body);
      setSave(dirty.current ? "saving" : "saved");
    } catch (e) {
      console.warn("[set] 保存商品信息失败", e);
      dirty.current = true;
      setSave("error");
      toast.show(
        e instanceof ApiError && e.status === 404
          ? "后端还没有提供修改接口，这次修改没有保存"
          : errorMessage(e, "保存失败"),
        { tone: "error" },
      );
    }
  }, [setId, toast]);

  const edit = (next: Draft) => {
    setDraft(next);
    dirty.current = true;
    setSave("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY);
  };
  // 离开页面前把还没发出的改动发出去
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );

  const defs = useMemo(() => {
    const m = new Map<string, SetShotDef>();
    for (const d of template?.shots ?? []) m.set(d.id, d);
    return m;
  }, [template]);

  if (!detail)
    return (
      <div className="set-panel" aria-busy="true">
        {error ? (
          <div className="notice notice-error" role="alert">
            <span>{error}</span>
            <button type="button" className="btn btn-sm" onClick={() => void reload()}>
              重试
            </button>
          </div>
        ) : (
          <>
            <div className="skeleton" style={{ height: 20, width: "50%" }} />
            <div className="skeleton" style={{ height: 120 }} />
          </>
        )}
      </div>
    );

  const draftIssue = draft ? validateDraft(draft) : null;
  const total = detail.shots.length;
  const finished = detail.shots.filter((s) => s.state === "completed").length;
  const failed = detail.shots.filter((s) => s.state === "failed").length;
  const analyzing = detail.state === "analyzing";

  return (
    <div className="set-panel">
      <section className="set-status" aria-live="polite">
        <div className="set-status-row">
          <b>
            {analyzing
              ? "正在识别商品、提炼卖点…"
              : busyLabel(finished, total, failed, actions.busy === "regen")}
          </b>
          <span>
            {finished}/{total}
          </span>
        </div>
        <div className="set-bar" aria-hidden>
          <i style={{ width: `${(finished / Math.max(1, total)) * 100}%` }} />
        </div>
        {showActions && <SetActionButtons session={session} actions={actions} compact />}
      </section>

      <section className="set-section">
        <h3>商品信息</h3>
        {!draft ? (
          <div className="skeleton" style={{ height: 96 }} />
        ) : (
          <>
            <label className="set-field">
              <span>商品名</span>
              <input
                className="input"
                value={draft.productName}
                maxLength={40}
                onChange={(e) => edit({ ...draft, productName: e.target.value })}
              />
            </label>
            <label className="set-field">
              <span>目标人群</span>
              <input
                className="input"
                value={draft.audience}
                maxLength={60}
                onChange={(e) => edit({ ...draft, audience: e.target.value })}
              />
            </label>
          </>
        )}
      </section>

      <section className="set-section">
        <div className="set-section-head">
          <h3>卖点</h3>
          <SaveBadge state={save} onRetry={() => void flush()} />
        </div>
        {!draft ? (
          <div className="skeleton" style={{ height: 160 }} />
        ) : (
          <>
            <ol className="points">
              {draft.points.map((p, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 卖点没有稳定 ID，按位置编辑
                <li key={i} className="point">
                  <span className="point-no">{i + 1}</span>
                  <div className="point-fields">
                    <input
                      className="input"
                      aria-label={`卖点 ${i + 1} 标题`}
                      value={p.title}
                      maxLength={72}
                      placeholder="卖点标题（≤12 字）"
                      onChange={(e) =>
                        edit({
                          ...draft,
                          points: draft.points.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)),
                        })
                      }
                    />
                    <textarea
                      className="input"
                      aria-label={`卖点 ${i + 1} 说明`}
                      value={p.detail}
                      maxLength={30}
                      rows={2}
                      placeholder="一句话说明（≤30 字）"
                      onChange={(e) =>
                        edit({
                          ...draft,
                          points: draft.points.map((x, j) => (j === i ? { ...x, detail: e.target.value } : x)),
                        })
                      }
                    />
                  </div>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`删除卖点 ${i + 1}`}
                    disabled={draft.points.length <= MIN_POINTS}
                    onClick={() => edit({ ...draft, points: draft.points.filter((_, j) => j !== i) })}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={draft.points.length >= MAX_POINTS}
              onClick={() => edit({ ...draft, points: [...draft.points, { title: "", detail: "" }] })}
            >
              <Plus size={14} /> 添加卖点
            </button>
            {draftIssue ? (
              <p className="set-note is-warn" role="alert">
                {draftIssue}，改好后自动保存。
              </p>
            ) : (
              <p className="set-note">改动只更新画布上的文字，不会重新出图，也不消耗额度。</p>
            )}
          </>
        )}
      </section>

      <section className="set-section">
        <h3>每张图</h3>
        <ul className="shots">
          {detail.shots.map((s) => {
            const def = defs.get(s.shotId);
            const busy = shotBusy(s);
            return (
              <li key={s.shotId} className={cx("shot", `is-${s.state}`)}>
                <div className="shot-main">
                  <b>{def?.name ?? s.shotId}</b>
                  <span className={cx("shot-state", `st-${s.state}`)}>
                    {busy && <span className="spinner" aria-hidden />}
                    {s.state === "failed" && <AlertTriangle size={12} aria-hidden />}
                    {s.state === "completed" && <Check size={12} aria-hidden />}
                    {STATE_LABEL[s.state]}
                  </span>
                </div>
                {s.error && <p className="shot-err">{s.error.message}</p>}
                <div className="shot-ops">
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      if (!canvasRef.current?.locate(s.frameElementId)) toast.show("画布上找不到这张图");
                    }}
                  >
                    <Locate size={13} /> 定位
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => void actions.regenShot(s.shotId)}
                  >
                    <RefreshCw size={13} /> {s.state === "failed" ? "重试" : "重新生成这张"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function busyLabel(done: number, total: number, failed: number, regen: boolean) {
  if (done + failed < total) return regen ? "正在重新生成…" : "正在逐张出图…";
  if (failed > 0) return `${failed} 张没有成功，可以单独重试`;
  return "整套已完成";
}

function SaveBadge({ state, onRetry }: { state: SaveState; onRetry(): void }) {
  if (state === "idle" || state === "invalid") return null;
  if (state === "error")
    return (
      <span className="save-error">
        <AlertTriangle size={13} /> 保存失败
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          重试
        </button>
      </span>
    );
  return state === "saving" ? (
    <span className="set-saving">
      <span className="spinner" aria-hidden /> 同步到画布…
    </span>
  ) : (
    <span className="save-ok">
      <Check size={13} /> 画布文字已更新
    </span>
  );
}
