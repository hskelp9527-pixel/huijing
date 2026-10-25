"use client";

import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  X,
} from "lucide-react";

import { cx } from "../../lib/utils";

export interface LayerItem {
  id: string;
  name: string;
  type: string;
  locked: boolean;
  hidden: boolean;
  selected: boolean;
  thumb?: string;
  /** 副标题：类型/像素尺寸 */
  meta?: string;
}

/**
 * 图层列表（上层在前）：选中、定位、显示/隐藏、锁定/解锁、调整顺序。
 * 锁定对象在画布上点不中，但可以在这里选中查看（规格第 4 节）。
 */
export function LayersPanel({
  items,
  onClose,
  onSelect,
  onLocate,
  onToggleLock,
  onToggleHidden,
  onMove,
}: {
  items: LayerItem[];
  onClose(): void;
  onSelect(id: string): void;
  onLocate(id: string): void;
  onToggleLock(id: string): void;
  onToggleHidden(id: string): void;
  onMove(id: string, dir: "up" | "down"): void;
}) {
  return (
    <section className="layers" aria-label="图层">
      <header className="layers-head">
        <b>图层</b>
        <span className="layers-count">{items.length}</span>
        <button
          type="button"
          className="icon-btn icon-btn-sm"
          aria-label="关闭图层面板"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>
      {items.length === 0 ? (
        <p className="layers-empty">画布上还没有对象</p>
      ) : (
        <ul className="layers-list">
          {items.map((it, i) => (
            <li
              key={it.id}
              className={cx(
                "layer",
                it.selected && "is-selected",
                it.hidden && "is-hidden",
              )}
            >
              <button
                type="button"
                className="layer-main"
                aria-pressed={it.selected}
                onClick={() => onSelect(it.id)}
                onDoubleClick={() => onLocate(it.id)}
                title="点击选中，双击定位"
              >
                <span className="layer-thumb" aria-hidden>
                  {it.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={it.thumb} alt="" />
                  ) : (
                    <span>
                      {it.type === "text"
                        ? "T"
                        : it.type === "frame"
                          ? "#"
                          : "◻"}
                    </span>
                  )}
                </span>
                <span className="layer-name">
                  {it.name}
                  {it.meta && <small>{it.meta}</small>}
                </span>
                {it.locked && !it.hidden && (
                  <span className="badge">已锁定</span>
                )}
                {it.hidden && <span className="badge">已隐藏</span>}
              </button>
              <div className="layer-actions">
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  aria-label={`${it.name}：上移一层`}
                  disabled={i === 0}
                  onClick={() => onMove(it.id, "up")}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  aria-label={`${it.name}：下移一层`}
                  disabled={i === items.length - 1}
                  onClick={() => onMove(it.id, "down")}
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  aria-label={it.hidden ? `显示 ${it.name}` : `隐藏 ${it.name}`}
                  aria-pressed={it.hidden}
                  onClick={() => onToggleHidden(it.id)}
                >
                  {it.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  type="button"
                  className="icon-btn icon-btn-sm"
                  aria-label={it.locked ? `解锁 ${it.name}` : `锁定 ${it.name}`}
                  aria-pressed={it.locked}
                  disabled={it.hidden}
                  onClick={() => onToggleLock(it.id)}
                >
                  {it.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
