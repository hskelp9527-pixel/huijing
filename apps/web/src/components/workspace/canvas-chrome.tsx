"use client";

import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  Copy,
  Download,
  Frame,
  Hand,
  ImagePlus,
  Layers,
  Lock,
  LockOpen,
  Minus,
  MousePointer2,
  MousePointerSquareDashed,
  Plus,
  Redo2,
  Sparkles,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { useState } from "react";

import { cx } from "../../lib/utils";
import { Popover } from "../ui/popover";

export type ToolId = "selection" | "hand" | "text" | "frame" | "image";

export interface ChromeState {
  tool: string;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  locked: number;
}

/** 自有的精简画布工具条（替代 Excalidraw 原生工具条，原生界面整体隐藏，见 workspace.css） */
export function CanvasDock({
  chrome,
  onTool,
  onZoom,
  onUndo,
  onRedo,
  onUnlockAll,
  layersOpen,
  onToggleLayers,
}: {
  layersOpen: boolean;
  onToggleLayers(): void;
  chrome: ChromeState;
  onTool(t: ToolId): void;
  onZoom(dir: 1 | -1 | 0): void;
  onUndo(): void;
  onRedo(): void;
  onUnlockAll(): void;
}) {
  const tool = (
    id: ToolId,
    label: string,
    icon: React.ReactNode,
    key: string,
  ) => (
    <button
      type="button"
      className="dock-btn"
      aria-pressed={chrome.tool === id}
      aria-label={label}
      title={`${label}（${key}）`}
      onClick={() => onTool(id)}
    >
      {icon}
    </button>
  );
  return (
    <div className="dock" role="toolbar" aria-label="画布工具">
      <div className="dock-group">
        {tool("selection", "选择", <MousePointer2 size={17} />, "V")}
        {tool("hand", "抓手", <Hand size={17} />, "H")}
      </div>
      <span className="dock-sep" aria-hidden />
      <div className="dock-group">
        {tool("text", "文字", <Type size={17} />, "T")}
        {tool("frame", "框", <Frame size={17} />, "F")}
        {tool("image", "上传图片", <ImagePlus size={17} />, "9")}
      </div>
      <span className="dock-sep" aria-hidden />
      <div className="dock-group">
        <button
          type="button"
          className="dock-btn"
          aria-label="缩小"
          title="缩小"
          onClick={() => onZoom(-1)}
        >
          <Minus size={16} />
        </button>
        <button
          type="button"
          className="dock-zoom"
          aria-label="重置缩放到 100%"
          title="重置缩放"
          onClick={() => onZoom(0)}
        >
          {Math.round(chrome.zoom * 100)}%
        </button>
        <button
          type="button"
          className="dock-btn"
          aria-label="放大"
          title="放大"
          onClick={() => onZoom(1)}
        >
          <Plus size={16} />
        </button>
      </div>
      <span className="dock-sep" aria-hidden />
      <div className="dock-group">
        <button
          type="button"
          className="dock-btn"
          aria-label="图层"
          title="图层"
          aria-pressed={layersOpen}
          onClick={onToggleLayers}
        >
          <Layers size={16} />
        </button>
      </div>
      <span className="dock-sep" aria-hidden />
      <div className="dock-group">
        <button
          type="button"
          className="dock-btn"
          aria-label="撤销"
          title="撤销（Ctrl+Z）"
          disabled={!chrome.canUndo}
          onClick={onUndo}
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          className="dock-btn"
          aria-label="重做"
          title="重做（Ctrl+Y）"
          disabled={!chrome.canRedo}
          onClick={onRedo}
        >
          <Redo2 size={16} />
        </button>
      </div>
      {chrome.locked > 0 && (
        <>
          <span className="dock-sep" aria-hidden />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onUnlockAll}
            title="已锁定的对象无法被选中，点这里全部解锁"
          >
            <LockOpen size={14} /> 解锁 {chrome.locked} 个
          </button>
        </>
      )}
    </div>
  );
}

/** ready=已接到后端 /api/media/ops；其余依赖浏览器端处理包，先显示“即将接入” */
export const EDIT_ITEMS: ReadonlyArray<{ label: string; ready: boolean }> = [
  { label: "快速编辑", ready: true },
  { label: "去背景", ready: false },
  { label: "消除", ready: false },
  { label: "扩图", ready: true },
  { label: "增强", ready: false },
  { label: "OCR 改字", ready: false },
  { label: "矢量化", ready: false },
  { label: "多视角", ready: true },
];
const Z_ITEMS: ReadonlyArray<{
  label: string;
  dir: "front" | "forward" | "backward" | "back";
}> = [
  { label: "置于顶层", dir: "front" },
  { label: "上移一层", dir: "forward" },
  { label: "下移一层", dir: "backward" },
  { label: "置于底层", dir: "back" },
];

/** 选中图片时的浮动工具条：引用、编辑（后处理入口预留）、复制、层级、锁定、删除、下载 */
export function SelectionToolbar(props: {
  x: number;
  y: number;
  flip: boolean;
  count: number;
  locked: boolean;
  menuBelow: boolean;
  onReference(): void;
  onDuplicate(): void;
  onDelete(): void;
  onZ(dir: "front" | "forward" | "backward" | "back"): void;
  onLock(): void;
  onDownload(): void;
  onEdit(label: string): void;
}) {
  const [menu, setMenu] = useState<"edit" | "z" | null>(null);
  const placement = props.menuBelow ? "below" : "above";
  const close = () => setMenu(null);
  return (
    <div
      className={cx("float-toolbar", props.flip && "is-flipped")}
      style={{ left: props.x, top: props.y }}
      role="toolbar"
      aria-label="所选图片"
    >
      <button
        type="button"
        className="btn btn-sm btn-primary"
        onClick={props.onReference}
      >
        <MousePointerSquareDashed size={14} /> 引用到对话
        {props.count > 1 ? ` (${props.count})` : ""}
      </button>
      <Popover
        open={menu === "edit"}
        onClose={close}
        placement={placement}
        className="menu edit-menu"
        trigger={
          <button
            type="button"
            className="btn btn-sm"
            aria-haspopup="menu"
            aria-expanded={menu === "edit"}
            onClick={() => setMenu(menu === "edit" ? null : "edit")}
          >
            <Sparkles size={14} /> 编辑 <ChevronDown size={13} />
          </button>
        }
      >
        <div role="menu" aria-label="编辑">
          {EDIT_ITEMS.map(({ label, ready }) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              disabled={props.count !== 1}
              title={props.count !== 1 ? "请只选中一张图片" : undefined}
              onClick={() => {
                close();
                props.onEdit(label);
              }}
            >
              {label}
              {!ready && <small>即将接入</small>}
            </button>
          ))}
        </div>
      </Popover>
      <span className="dock-sep" aria-hidden />
      <button
        type="button"
        className="icon-btn"
        aria-label="复制"
        title="复制（Ctrl+D）"
        onClick={props.onDuplicate}
      >
        <Copy size={16} />
      </button>
      <Popover
        open={menu === "z"}
        onClose={close}
        placement={placement}
        className="menu"
        trigger={
          <button
            type="button"
            className="icon-btn"
            aria-label="层级"
            title="层级"
            aria-haspopup="menu"
            aria-expanded={menu === "z"}
            onClick={() => setMenu(menu === "z" ? null : "z")}
          >
            <Layers size={16} />
          </button>
        }
      >
        <div role="menu" aria-label="层级">
          {Z_ITEMS.map((z) => (
            <button
              key={z.dir}
              type="button"
              role="menuitem"
              onClick={() => {
                close();
                props.onZ(z.dir);
              }}
            >
              {z.dir === "front" || z.dir === "forward" ? (
                <ArrowUpToLine size={14} />
              ) : (
                <ArrowDownToLine size={14} />
              )}
              {z.label}
            </button>
          ))}
        </div>
      </Popover>
      <button
        type="button"
        className="icon-btn"
        aria-pressed={props.locked}
        aria-label={props.locked ? "解锁" : "锁定"}
        title={
          props.locked
            ? "解锁"
            : "锁定（锁定后无法选中，可在底部工具条一键解锁）"
        }
        onClick={props.onLock}
      >
        {props.locked ? <LockOpen size={16} /> : <Lock size={16} />}
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="下载"
        title="下载"
        onClick={props.onDownload}
      >
        <Download size={16} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn-danger"
        aria-label="删除"
        title="删除（Delete）"
        onClick={props.onDelete}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
