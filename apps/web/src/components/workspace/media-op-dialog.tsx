"use client";

import { X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import type { MediaOpRequest } from "../../lib/api";

export type MediaForm = "快速编辑" | "扩图" | "多视角";
export type MediaParams = Pick<MediaOpRequest, "op" | "params">;

const clampInt = (v: string, max: number) =>
  Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
const MAX_PIXELS = 1_048_576;
const MAX_SIDE = 2048;

/** 图片后处理的参数面板：快速编辑（一句话指令）、扩图（四边像素）、多视角（水平/俯仰角）。提交后由服务端异步执行。 */
export function MediaOpDialog({
  kind,
  busy,
  sourceSize,
  onClose,
  onSubmit,
}: {
  kind: MediaForm;
  busy: boolean;
  sourceSize: { width: number; height: number } | null;
  onClose(): void;
  onSubmit(p: MediaParams): void;
}) {
  const [prompt, setPrompt] = useState("");
  const [margin, setMargin] = useState({
    top: "0",
    right: "256",
    bottom: "0",
    left: "0",
  });
  const [azimuth, setAzimuth] = useState(35);
  const [elevation, setElevation] = useState(10);
  const first = useRef<HTMLElement | null>(null);
  const setFirst = (el: HTMLElement | null) => {
    first.current = el;
  };

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const m = {
    top: clampInt(margin.top, 1024),
    right: clampInt(margin.right, 1024),
    bottom: clampInt(margin.bottom, 1024),
    left: clampInt(margin.left, 1024),
  };
  const out = sourceSize
    ? {
        width: sourceSize.width + m.left + m.right,
        height: sourceSize.height + m.top + m.bottom,
      }
    : null;
  // 服务端处理上限：100 万像素、单边 2048；提交前先在这里挡住，免得白等一次请求
  const expandError =
    kind === "扩图" &&
    out &&
    (out.width * out.height > MAX_PIXELS ||
      Math.max(out.width, out.height) > MAX_SIDE)
      ? `扩展后 ${out.width}×${out.height}，超过服务端处理上限（100 万像素、单边 2048）。请减小扩展，或换一张更小的图。`
      : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (kind === "快速编辑") {
      const text = prompt.trim();
      if (text) onSubmit({ op: "edit", params: { prompt: text } });
    } else if (kind === "扩图") {
      if (expandError) return;
      if (m.top + m.right + m.bottom + m.left > 0)
        onSubmit({ op: "expand", params: { margin: m } });
    } else onSubmit({ op: "multiview", params: { azimuth, elevation } });
  };
  const sides: Array<[keyof typeof margin, string]> = [
    ["top", "上"],
    ["right", "右"],
    ["bottom", "下"],
    ["left", "左"],
  ];

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form className="dialog" aria-label={kind} onSubmit={submit}>
        <header className="dialog-head">
          <h2>{kind}</h2>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>
        {kind === "快速编辑" && (
          <div className="field">
            <label htmlFor="mo-prompt">想怎么改？</label>
            <textarea
              id="mo-prompt"
              ref={setFirst}
              className="input"
              rows={3}
              style={{ height: "auto", padding: 10 }}
              placeholder="例如：把背景换成傍晚的海边，保持主体不变"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <span className="field-hint">
              结果会作为新图放在原图右侧，原图保留。
            </span>
          </div>
        )}
        {kind === "扩图" && (
          <div className="field">
            <span className="settings-label">
              向外扩展（像素，每边 0–1024）
            </span>
            <div className="margin-grid">
              {sides.map(([k, label], i) => (
                <label key={k} className="margin-field">
                  <span>{label}</span>
                  <input
                    ref={i === 0 ? setFirst : undefined}
                    className="input"
                    type="number"
                    min={0}
                    max={1024}
                    step={32}
                    value={margin[k]}
                    onChange={(e) =>
                      setMargin((s) => ({ ...s, [k]: e.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
            {expandError ? (
              <span className="field-error" role="alert">
                {expandError}
              </span>
            ) : (
              <span className="field-hint">
                原图像素原样保留在原位置，只补绘新增的边缘；
                {out ? `扩展后 ${out.width}×${out.height}。` : ""}
                服务端处理上限为 100 万像素、单边 2048。
              </span>
            )}
          </div>
        )}
        {kind === "多视角" && (
          <div className="field">
            <label htmlFor="mo-az">水平角度 {azimuth}°</label>
            <input
              id="mo-az"
              ref={setFirst}
              type="range"
              min={-180}
              max={180}
              value={azimuth}
              onChange={(e) => setAzimuth(Number(e.target.value))}
            />
            <label htmlFor="mo-el">俯仰角度 {elevation}°</label>
            <input
              id="mo-el"
              type="range"
              min={-90}
              max={90}
              value={elevation}
              onChange={(e) => setElevation(Number(e.target.value))}
            />
            <span className="field-hint">
              角度只是对模型的条件约束，不保证几何精确。
            </span>
          </div>
        )}
        <footer className="dialog-foot">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              busy || (kind === "快速编辑" && !prompt.trim()) || !!expandError
            }
          >
            {busy && <span className="spinner" aria-hidden />} 开始处理
          </button>
        </footer>
      </form>
    </div>
  );
}
