"use client";

import {
  ArrowLeft,
  ArrowRight,
  ImagePlus,
  Loader2,
  MousePointerSquareDashed,
  RotateCw,
  SendHorizontal,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  ASPECT_OPTIONS,
  MAX_REFERENCES,
  MODEL_INFO,
  PURPOSE_LABEL,
  QUALITY_OPTIONS,
  type ReferencePurpose,
  modelLabel,
} from "../../lib/api/contract";
import { useCapabilities } from "../../lib/capabilities";
import { cx } from "../../lib/utils";
import { Popover } from "../ui/popover";
import { type ComposerImage, settingsSummary } from "./composer-model";
import type { ComposerController } from "./use-composer";

export type StaleState = "stale" | "deleted";

export interface ComposerProps {
  controller: ComposerController;
  variant: "hero" | "dock";
  placeholder: string;
  /** 用户点发送或在输入框按 Enter（已通过校验）时调用 */
  onSubmit: () => void;
  /** 本次提交是否正在等待服务端确认；给出后显示“取消等待” */
  onCancelWait?: (() => void) | undefined;
  /** 当前对话有进行中的 Run：发送换成停止 */
  runActive?: boolean;
  onStop?: (() => void) | undefined;
  /** 额外禁止发送的原因（例如额度用尽） */
  blockedReason?: string | undefined;
  /** 画布当前选中的图片数；点“引用所选”才会冻结加入 */
  canvasSelection?: { count: number; onReference: () => void } | undefined;
  /** 画布引用相对当前对象的状态 */
  staleMap?: Record<string, StaleState> | undefined;
  onUpdateReference?: ((imageId: string) => void) | undefined;
  onLocateReference?: ((elementId: string) => void) | undefined;
  /** Agent 追问回答模式的提示 */
  answerBanner?: { question: string; onSwitchToNew?: () => void } | undefined;
  autoFocus?: boolean | undefined;
  textareaRef?: RefObject<HTMLTextAreaElement | null> | undefined;
}

export function Composer(props: ComposerProps) {
  const {
    controller,
    variant,
    placeholder,
    onSubmit,
    runActive,
    onStop,
    blockedReason,
    canvasSelection,
    staleMap,
    answerBanner,
  } = props;
  const { state, actions, check } = controller;
  const localRef = useRef<HTMLTextAreaElement>(null);
  const taRef = props.textareaRef ?? localRef;
  const fileRef = useRef<HTMLInputElement>(null);
  const [composing, setComposing] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [drag, setDrag] = useState(false);
  const hintId = useId();
  const submitting = state.phase === "submitting";
  const locked = submitting;

  // 自动增高
  // biome-ignore lint/correctness/useExhaustiveDependencies: 这些依赖是有意的重新执行触发条件（或只在首次进入时读取），不是遗漏
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, variant === "hero" ? 260 : 180)}px`;
  }, [state.text, variant, taRef]);

  useEffect(() => {
    if (props.autoFocus) taRef.current?.focus();
  }, [props.autoFocus, taRef]);

  // 阻止原因一旦消失就收起提示
  const reason = !check.ok ? check.reason : blockedReason;
  const reasonVisible =
    !!reason && (showHint || (!check.ok && !check.silent) || !!blockedReason);
  useEffect(() => {
    if (!reason) setShowHint(false);
  }, [reason]);

  const trySubmit = () => {
    if (locked) return;
    if (runActive) {
      setShowHint(true);
      return;
    }
    if (!check.ok || blockedReason) {
      setShowHint(true);
      return;
    }
    setShowHint(false);
    onSubmit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    // 输入法组合期间（含 keyCode 229）的 Enter 只是确认候选词
    if (composing || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    trySubmit();
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length) {
      e.preventDefault();
      actions.addFiles(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length) actions.addFiles(files);
  };

  const canSend = check.ok && !blockedReason && !locked && !runActive;
  const full = state.images.length >= MAX_REFERENCES;

  return (
    <div
      className={cx(
        "composer",
        `composer-${variant}`,
        drag && "is-drag",
        locked && "is-locked",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
    >
      {answerBanner && (
        <output className="composer-answer">
          <span>
            <b>回答当前问题</b>：{answerBanner.question}
          </span>
          {answerBanner.onSwitchToNew && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={answerBanner.onSwitchToNew}
            >
              另起新请求
            </button>
          )}
        </output>
      )}

      {canvasSelection && canvasSelection.count > 0 && (
        <div className="composer-selection">
          <MousePointerSquareDashed size={15} aria-hidden />
          <span>画布上选中了 {canvasSelection.count} 张图</span>
          <button
            type="button"
            className="btn btn-sm composer-ref-btn"
            disabled={locked || full}
            onClick={canvasSelection.onReference}
            title="把画布上选中的图片作为参考（点击后才会固定当前版本）"
          >
            引用所选
          </button>
        </div>
      )}

      <textarea
        ref={taRef}
        className="composer-input"
        value={state.text}
        placeholder={placeholder}
        aria-label="需求描述"
        aria-describedby={reasonVisible ? hintId : undefined}
        rows={variant === "hero" ? 3 : 2}
        readOnly={locked}
        onChange={(e) => actions.setText(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onPaste={onPaste}
      />

      {state.images.length > 0 && (
        <ul className="composer-tray" aria-label="参考图">
          {state.images.map((img, idx) => (
            <ImageCard
              key={img.id}
              img={img}
              index={idx}
              total={state.images.length}
              locked={locked}
              stale={staleMap?.[img.id]}
              onPurpose={(p) => actions.setPurpose(img.id, p)}
              onMove={(d) => actions.move(img.id, d)}
              onRemove={() => actions.removeImage(img.id)}
              onRetry={() =>
                img.kind === "upload"
                  ? actions.retryUpload(img.id)
                  : actions.retryFreeze(img.id)
              }
              onUpdate={() => props.onUpdateReference?.(img.id)}
              onKeepOld={() =>
                img.appearanceKey &&
                actions.keepOldReference(img.id, img.appearanceKey)
              }
              onLocate={() =>
                img.elementId && props.onLocateReference?.(img.elementId)
              }
            />
          ))}
        </ul>
      )}

      {reasonVisible && (
        <output id={hintId} className="composer-hint">
          {reason}
        </output>
      )}

      <div className="composer-bar">
        <div className="composer-tools">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(e) => {
              actions.addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={locked || full}
            onClick={() => fileRef.current?.click()}
            title={
              full
                ? `最多 ${MAX_REFERENCES} 张参考图`
                : "添加参考图（也可以直接粘贴或拖入）"
            }
          >
            <ImagePlus size={15} />{" "}
            <span className="composer-attach-text">参考图</span>
            <span className="composer-count">
              {state.images.length}/{MAX_REFERENCES}
            </span>
          </button>
          <SettingsPopover
            controller={controller}
            disabled={locked}
            compact={variant === "dock"}
          />
        </div>
        <div className="composer-send">
          {submitting && props.onCancelWait && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={props.onCancelWait}
            >
              取消等待
            </button>
          )}
          {runActive && onStop ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={onStop}
              aria-label="停止当前任务"
            >
              <Square size={13} fill="currentColor" /> 停止
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary composer-send-btn"
              aria-disabled={!canSend}
              onClick={trySubmit}
              aria-label="发送"
            >
              {submitting ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <SendHorizontal size={16} />
              )}
              {variant === "hero" && (
                <span>{submitting ? "正在创建…" : "开始创作"}</span>
              )}
            </button>
          )}
        </div>
      </div>
      {variant === "hero" && (
        <p className="composer-keys">
          <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行 ·
          可粘贴或拖入图片
        </p>
      )}
    </div>
  );
}

function ImageCard(props: {
  img: ComposerImage;
  index: number;
  total: number;
  locked: boolean;
  stale: StaleState | undefined;
  onPurpose: (p: ReferencePurpose) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  onRetry: () => void;
  onUpdate: () => void;
  onKeepOld: () => void;
  onLocate: () => void;
}) {
  const { img, index, total, locked, stale } = props;
  const busy = img.status === "uploading" || img.status === "freezing";
  const statusText =
    img.status === "uploading"
      ? "上传中"
      : img.status === "freezing"
        ? "固定版本"
        : img.status === "failed"
          ? "失败"
          : null;
  return (
    <li
      className={cx(
        "ref-card",
        img.status === "failed" && "is-failed",
        stale && "is-stale",
      )}
      data-testid="composer-image"
      data-status={img.status}
      data-kind={img.kind}
    >
      <div className="ref-thumb">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={img.previewUrl} alt={img.name} />
        <span className="ref-order">{index + 1}</span>
        {statusText && (
          <div
            className={cx(
              "ref-status",
              img.status === "failed" ? "ref-status-failed" : "",
            )}
          >
            {busy ? <span className="spinner" aria-hidden /> : null}
            <span>{statusText}</span>
          </div>
        )}
        <button
          type="button"
          className="ref-remove icon-btn icon-btn-sm"
          onClick={props.onRemove}
          disabled={locked}
          aria-label={`删除 ${img.name}`}
        >
          <X size={13} />
        </button>
      </div>
      <div className="ref-meta">
        <span className="ref-name" title={img.name}>
          {img.kind === "canvas" ? "画布 · " : ""}
          {img.name}
        </span>
        {img.status === "failed" ? (
          <>
            <span className="ref-error" title={img.error}>
              {img.error ?? "失败"}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={props.onRetry}
              disabled={locked}
            >
              <RotateCw size={13} /> 重试
            </button>
          </>
        ) : (
          <>
            <select
              className="select select-sm"
              aria-label={`${img.name} 的用途`}
              value={img.purpose}
              disabled={locked || busy}
              onChange={(e) =>
                props.onPurpose(e.target.value as ReferencePurpose)
              }
            >
              {(Object.keys(PURPOSE_LABEL) as ReferencePurpose[]).map((p) => (
                <option key={p} value={p}>
                  {PURPOSE_LABEL[p]}
                </option>
              ))}
            </select>
            <div className="ref-order-btns">
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="前移"
                disabled={locked || index === 0}
                onClick={() => props.onMove(-1)}
              >
                <ArrowLeft size={13} />
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="后移"
                disabled={locked || index === total - 1}
                onClick={() => props.onMove(1)}
              >
                <ArrowRight size={13} />
              </button>
            </div>
          </>
        )}
        {stale === "stale" && (
          <output className="ref-stale">
            <span>引用较旧：画布上的图已改动</span>
            <div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={props.onUpdate}
                disabled={locked}
              >
                更新引用
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={props.onKeepOld}
                disabled={locked}
              >
                保持旧版
              </button>
            </div>
          </output>
        )}
        {stale === "deleted" && (
          <div className="ref-stale ref-stale-muted">
            画布对象已移除，引用的是当时的版本
          </div>
        )}
      </div>
    </li>
  );
}

function SettingsPopover({
  controller,
  disabled,
  compact,
}: { controller: ComposerController; disabled: boolean; compact: boolean }) {
  const { state, actions } = controller;
  const [open, setOpen] = useState(false);
  const caps = useCapabilities();
  // 可选模型完全以服务端 /api/capabilities 为准（首页和工作区一致）；没读到时不显示任何档位，也不提交模型
  const models = caps?.models ?? [];
  const s = state.settings;
  // 已保存的选择不在服务端当前开放的模型里时，退回默认，避免显示/提交一个不可用的档位
  const stale = !!caps && s.modelId !== "auto" && !models.includes(s.modelId);
  useEffect(() => {
    if (stale) actions.setSetting("modelId", "auto");
  }, [stale, actions]);
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      className="settings-pop"
      trigger={
        <button
          type="button"
          className="btn btn-sm settings-trigger"
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <SlidersHorizontal size={15} />
          <span>
            {settingsSummary(
              s,
              (id) => modelLabel(stale ? "auto" : id, models),
              compact,
            )}
          </span>
        </button>
      }
    >
      <section aria-label="生成设置" className="settings-body">
        <div className="settings-row">
          <span className="settings-label">数量</span>
          <div className="segmented" role="radiogroup" aria-label="生成数量">
            {([1, 2, 3, 4] as const).map((n) => (
              <RadioOpt
                key={n}
                name="gen-count"
                checked={s.count === n}
                onChange={() => actions.setSetting("count", n)}
              >
                {n}
              </RadioOpt>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">比例</span>
          <div className="chip-grid" role="radiogroup" aria-label="图片比例">
            {ASPECT_OPTIONS.map((a) => (
              <RadioOpt
                key={a}
                name="gen-aspect"
                variant="chip"
                checked={s.aspectRatio === a}
                onChange={() => actions.setSetting("aspectRatio", a)}
              >
                {a === "auto" ? "自动" : a}
              </RadioOpt>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">清晰度</span>
          <div className="segmented" role="radiogroup" aria-label="清晰度">
            {QUALITY_OPTIONS.map((q) => (
              <RadioOpt
                key={q.id}
                name="gen-quality"
                checked={s.quality === q.id}
                onChange={() => actions.setSetting("quality", q.id)}
              >
                {q.label}
              </RadioOpt>
            ))}
          </div>
        </div>
        <div className="settings-row settings-row-col">
          <span className="settings-label">模型</span>
          <div className="model-list" role="radiogroup" aria-label="模型">
            {!caps && <output className="field-hint">正在读取可用模型…</output>}
            {caps && models.length === 0 && (
              <p className="field-hint">服务端暂未开放模型</p>
            )}
            {models.map((id) => (
              <RadioOpt
                key={id}
                name="gen-model"
                variant="model"
                checked={
                  s.modelId === id || (s.modelId === "auto" && id === models[0])
                }
                onChange={() => actions.setSetting("modelId", id)}
              >
                <b>{MODEL_INFO[id]?.label ?? id}</b>
                <small>{MODEL_INFO[id]?.hint ?? ""}</small>
              </RadioOpt>
            ))}
          </div>
        </div>
        <p className="field-hint">
          文字里写明“3
          张”等数量时，以文字为准，并在任务里说明；文字和这里手动选的不一致时，Agent
          会先问你。
        </p>
      </section>
    </Popover>
  );
}

/** 原生单选框（视觉隐藏）+ 自绘样式：自带键盘方向键切换和读屏语义 */
function RadioOpt({
  name,
  checked,
  onChange,
  variant = "segment",
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  variant?: "segment" | "chip" | "model";
  children: React.ReactNode;
}) {
  return (
    <label className={cx("radio-opt", `radio-opt-${variant}`)}>
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span>{children}</span>
    </label>
  );
}
