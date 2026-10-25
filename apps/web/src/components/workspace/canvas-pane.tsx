"use client";

import "@excalidraw/excalidraw/index.css";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import dynamic from "next/dynamic";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  ApiError,
  type Artifact,
  type CanvasOp,
  type CanvasOpsRequest,
  type ProjectResponse,
  type TaskError,
  type TaskState,
  getApi,
} from "../../lib/api";
import {
  appearanceKey,
  customDataOf,
  elementRect,
  fileIdForAsset,
  isTransient,
  makeImageElement,
  newElementId,
} from "../../lib/canvas/elements";
import { dataUrlToFile, makeThumb, toDataUrl } from "../../lib/canvas/files";
import { BAND_KIND, typesetScene } from "../../lib/sets/typeset";
import {
  type Rect,
  fitLongEdge,
  layoutRow,
  worldBounds,
} from "../../lib/canvas/placement";
import {
  downloadUrl,
  errorMessage,
  extFor,
  newId,
  readJson,
  writeJson,
} from "../../lib/utils";
import type { CanvasRefInput } from "../composer/use-composer";
import {
  CanvasDock,
  type ChromeState,
  SelectionToolbar,
  type ToolId,
} from "./canvas-chrome";
import { type LayerItem, LayersPanel } from "./layers-panel";

const Excalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((m) => m.Excalidraw),
  {
    ssr: false,
    loading: () => (
      <output className="canvas-loading">
        <span className="spinner spinner-lg" /> 正在载入画布…
      </output>
    ),
  },
);

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
// Excalidraw 的元素/场景类型很大，这里只在边界处用 any
// biome-ignore lint/suspicious/noExplicitAny: Excalidraw 边界处的元素/appState 类型很大，只在这个别名处用 any
type XAny = any;
type XEl = XAny;

export interface SelectedImage {
  id: string;
  name: string;
}
export interface CanvasHandle {
  getViewportCenter(): { x: number; y: number };
  /** 当前选中的图片元素 */
  getSelectedImages(): SelectedImage[];
  referenceInputFor(elementId: string): Promise<CanvasRefInput | null>;
  referenceInputForArtifact(a: Artifact): Promise<CanvasRefInput>;
  appearanceKeyOf(elementId: string): string | null;
  /** 图片元素的原始像素尺寸（后处理的像素上限要按它校验） */
  elementPixels(elementId: string): { width: number; height: number } | null;
  elementExists(elementId: string): boolean;
  /** 按 Artifact 查找画布上仍存在的元素 ID（可能是重新放入的新元素） */
  findArtifactElement(artifactId: string): string | null;
  locate(elementId: string): boolean;
  reinsertArtifact(a: Artifact): Promise<string>;
  /** 画布保存遇到 409 冲突后：保留我的改动（以服务端最新版本为基线重新提交），或采用服务端版本 */
  resolveConflict(choice: "mine" | "server"): void;
  fitAll(): void;
  retrySave(): void;
  /** 按 frame 导出 PNG（文字图层合成进图）；像素倍率取该 frame 里底图的原始像素与 frame 宽度之比 */
  exportFrames(frameIds: string[]): Promise<Array<{ id: string; blob: Blob }>>;
}

/** 进行中的一批任务（一个 Run）：用来在画布上估算占位位置；真实结果位置以服务端 canvas.ops 为准 */
export interface PendingBatch {
  runId: string;
  sourceElementId?: string | undefined;
  viewportCenter?: { x: number; y: number } | undefined;
  slots: Array<{
    taskId: string;
    slotIndex: number;
    state: TaskState;
    error?: TaskError | undefined;
    /** 服务端排队时冻结的占位矩形；没有（旧任务/演示模式）时才用前端估算 */
    slot?: { x: number; y: number; w: number; h: number } | undefined;
    /** 占位上的文字（套图用图名；缺省为“方案 N · 状态”） */
    label?: string | undefined;
    /** 套图：占位铺满这个 frame（取画布上 frame 当前的位置），并放在 frame 内、文字图层下面 */
    frameId?: string | undefined;
  }>;
}

interface Props {
  projectId: string;
  initial: ProjectResponse["canvas"];
  theme: "light" | "dark";
  batches: PendingBatch[];
  /** 服务端推来的画布操作（按 revision 去重） */
  remoteOps: Array<{
    revision: number;
    ops: CanvasOp[];
    source: "user" | "agent" | "task";
  }>;
  active: boolean;
  /** 有进行中的 Run：画布为空时提示“正在理解需求” */
  working: boolean;
  /** 提交画布操作（revision 冲突时抛出 ApiError CANVAS_CONFLICT，details 带服务端版本） */
  saveOps(req: CanvasOpsRequest): Promise<{ revision: number }>;
  onSaveState(s: SaveState): void;
  /** 选中集合、元素外观或增删变化时通知（签名字符串） */
  onSceneSig(sig: string): void;
  onSelection(ids: SelectedImage[]): void;
  onReferenceElements(ids: string[]): void;
  onNotice(msg: string, tone?: "info" | "error"): void;
  onEdit(label: string, elementId: string): void;
}

const PALETTE = {
  light: {
    stroke: "#d6451b",
    fill: "#fbe6dc",
    failStroke: "#b0261d",
    failFill: "#f8dcd8",
    bg: "#faf8f3",
    ink: "#1e1b16",
  },
  dark: {
    stroke: "#ff7447",
    fill: "#3b2216",
    failStroke: "#ff8a7d",
    failFill: "#3d1a16",
    bg: "#17140f",
    ink: "#f2eee4",
  },
} as const;

type Slot = PendingBatch["slots"][number];
function placeholderLabel(t: Slot): string {
  const n = t.label ?? `方案 ${t.slotIndex + 1}`;
  switch (t.state) {
    case "queued":
      return `${n} · 排队中`;
    case "submitted":
      return `${n} · 已提交`;
    case "running":
      return `${n} · 生成中`;
    case "ingesting":
      return `${n} · 保存结果`;
    case "failed":
      return `${n} · ${t.error?.code === "RATE_LIMITED" ? "稍后重试" : "未生成"}`;
    default:
      return n;
  }
}
/** 还需要占位的 slot：排队/进行中，以及可重试的失败（不可重试的失败原因只在右侧任务卡显示） */
const needsPlaceholder = (t: Slot) =>
  t.state === "queued" ||
  t.state === "submitted" ||
  t.state === "running" ||
  t.state === "ingesting" ||
  (t.state === "failed" && (t.error?.retryable ?? true));
/**
 * 有 frameId 的元素的层级：底图放在同一 frame 所有成员下面；占位放在文字图层下面（重出时盖住旧图）；
 * 找不到合适位置就追加到最上层。
 */
function placeInFrame(list: XEl[], el: XEl) {
  if (el.frameId) {
    const placeholder = customDataOf(el)?.kind === "placeholder";
    const i = list.findIndex(
      (e) =>
        e.frameId === el.frameId &&
        (!placeholder ||
          e.type === "text" ||
          customDataOf(e)?.kind === BAND_KIND),
    );
    if (i >= 0) {
      list.splice(i, 0, el);
      return;
    }
  }
  list.push(el);
}
const mimeOfDataUrl = (d: string) =>
  d.match(/^data:([^;,]+)/)?.[1] ?? "image/png";

export const CanvasPane = forwardRef<CanvasHandle, Props>(
  function CanvasPane(props, ref) {
    const { projectId, initial, theme, batches, remoteOps, active, working } =
      props;
    const palette = PALETTE[theme];
    const themeRef = useRef(theme);
    themeRef.current = theme;
    const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
    const [apiReady, setApiReady] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);
    const propsRef = useRef(props);
    propsRef.current = props;

    // 保存相关
    const revisionRef = useRef(initial.revision);
    const sentVersions = useRef(new Map<string, number>());
    // 已同步元素的“内容指纹”（去掉 version/versionNonce/index/updated）。Excalidraw 会在加载、补索引、加文件时悄悄提升 version，
    // 内容没变就不能当成用户改动回写，否则后端会把它记成“用户手动改过”，影响整批重排。
    const syncedKeys = useRef(new Map<string, string>());
    const contentKey = (e: XEl) => {
      const {
        version: _v,
        versionNonce: _n,
        index: _i,
        updated: _u,
        ...rest
      } = e;
      return JSON.stringify(rest, Object.keys(rest).sort());
    };
    const dirtyOps = useRef(new Map<string, CanvasOp>());
    const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    );
    const flushing = useRef(false);
    // 正在提交（已从 dirtyOps 移出、服务端还没回包）的元素：这段时间内到达的回显不能覆盖本地更新的位置
    const inflight = useRef(new Set<string>());
    // fileId 就是 Asset ID（后端约定）。用户自己拖进画布的图片 fileId 是 Excalidraw 生成的哈希，保存前要先上传成 Asset 并换成 Asset ID
    const knownAssets = useRef(new Set<string>(Object.keys(initial.files)));
    const rekeying = useRef(new Set<string>());
    const conflictRef = useRef<{
      revision: number;
      serverElements: XEl[];
      ops: CanvasOp[];
    } | null>(null);
    const appliedRemote = useRef(0);

    // 视图
    const userMoved = useRef(false);
    const ignoreScrollUntil = useRef(0);
    // 只有用户手势（滚轮、拖动、键盘、自有缩放按钮）引起的视图变化才算“用户移动了视图”并被保存
    const lastGesture = useRef(0);
    const sigRef = useRef("");
    const selRef = useRef("");
    const vpKey = `vp:${projectId}`;
    type Tb = {
      x: number;
      y: number;
      flip: boolean;
      menuBelow: boolean;
      ids: string[];
      locked: boolean;
    };
    const [toolbar, setToolbar] = useState<Tb | null>(null);
    const toolbarRef = useRef<Tb | null>(null);
    const [chrome, setChrome] = useState<ChromeState>({
      tool: "selection",
      zoom: 1,
      canUndo: false,
      canRedo: false,
      locked: 0,
    });
    const chromeRef = useRef(chrome);
    const [layersOpen, setLayersOpen] = useState(false);
    const layersOpenRef = useRef(false);
    layersOpenRef.current = layersOpen;
    const layerSigRef = useRef("");
    // 画布上没有任何对象（含占位）：显示引导/等待提示
    const [emptyCanvas, setEmptyCanvas] = useState(
      initial.elements.every((e) => e.isDeleted),
    );
    const [layerTick, setLayerTick] = useState(0);

    // 初始场景：已有元素的版本记为“已保存”，避免回写
    const initialData = useRef<XAny>(null);
    if (!initialData.current) {
      const savedVp = readJson<{
        scrollX: number;
        scrollY: number;
        zoom: number;
      }>(vpKey);
      if (savedVp) userMoved.current = true;
      // 演示模式的资源是 data URL，可以同步放进初始文件；真实模式的图片在画布就绪后异步取回
      const inline: Record<string, XAny> = {};
      for (const fid of Object.keys(initial.files)) {
        const url = getApi().assetUrl(fid);
        if (url.startsWith("data:"))
          inline[fid] = {
            id: fid,
            dataURL: url,
            mimeType: mimeOfDataUrl(url),
            created: Date.now(),
          };
      }
      for (const e of initial.elements)
        sentVersions.current.set(e.id, Number(e.version ?? 0));
      // 套图文字排版（字号/字体/底条）：服务端只给粗略位置，前端统一排；onApi 里 markSynced 会把排版结果记为「已同步」，不会回写
      const typeset = typesetScene(initial.elements);
      if (typeset.changed.length)
        console.info("[set] 初始排版", typeset.changed.length, "个图层");
      initialData.current = {
        elements: typeset.elements,
        files: inline,
        scrollToContent: false,
        appState: {
          viewBackgroundColor: PALETTE[themeRef.current].bg,
          currentItemStrokeColor: PALETTE[themeRef.current].ink,
          currentItemRoughness: 0,
          currentItemFontFamily: 6,
          frameRendering: {
            enabled: true,
            name: false,
            outline: true,
            clip: true,
          },
          ...(savedVp
            ? {
                scrollX: savedVp.scrollX,
                scrollY: savedVp.scrollY,
                zoom: { value: savedVp.zoom },
              }
            : {}),
        },
      };
    }

    const api = () => apiRef.current;
    const markProgrammaticScroll = () => {
      ignoreScrollUntil.current = Date.now() + 900;
    };

    // ───── 保存 ─────
    /** 把用户自己放进画布的图片上传成 Asset，并把元素的 fileId 换成 Asset ID；完成后差异检测会重新提交这个元素 */
    const rekeyToAsset = async (el: XEl) => {
      const x = api();
      const fileId = String(el.fileId);
      if (!x || rekeying.current.has(fileId)) return;
      const data = x.getFiles()[fileId]?.dataURL as string | undefined;
      if (!data) return;
      rekeying.current.add(fileId);
      try {
        const asset = await getApi().uploadAsset(
          await dataUrlToFile(data, `canvas-${fileId.slice(0, 8)}.png`),
          { projectId },
        );
        x.addFiles([
          {
            id: asset.id as XAny,
            dataURL: data as XAny,
            mimeType: mimeOfDataUrl(data) as XAny,
            created: Date.now(),
          },
        ]);
        knownAssets.current.add(asset.id);
        const all = x.getSceneElementsIncludingDeleted() as XEl[];
        x.updateScene({
          elements: all.map((e) =>
            e.fileId === fileId
              ? {
                  ...e,
                  fileId: asset.id,
                  version: (e.version ?? 0) + 1,
                  versionNonce: (Math.random() * 2 ** 31) | 0,
                  updated: Date.now(),
                }
              : e,
          ),
          captureUpdate: (await import("@excalidraw/excalidraw"))
            .CaptureUpdateAction.NEVER,
        });
      } catch (e) {
        propsRef.current.onNotice(
          `图片保存失败：${errorMessage(e, "上传出错")}`,
          "error",
        );
        propsRef.current.onSaveState("error");
      } finally {
        rekeying.current.delete(fileId);
      }
    };

    // biome-ignore lint/correctness/useExhaustiveDependencies: api()、fitTo 等是每次渲染重建但只读 ref 的辅助函数，列入依赖会让副作用每次渲染都重跑
    const flush = useCallback(async () => {
      if (
        flushing.current ||
        dirtyOps.current.size === 0 ||
        conflictRef.current
      )
        return;
      flushing.current = true;
      let batch = [...dirtyOps.current.entries()];
      dirtyOps.current.clear();
      // 还不是 Asset 的图片先去上传，本批不带它们（上传完成后会作为新的版本再次提交）
      const unbacked = batch.filter(
        ([, op]) =>
          op.kind === "upsert" &&
          op.element.type === "image" &&
          op.element.fileId &&
          !knownAssets.current.has(String(op.element.fileId)),
      );
      for (const [, op] of unbacked)
        if (op.kind === "upsert") void rekeyToAsset(op.element);
      const skip = new Set(unbacked.map(([id]) => id));
      batch = batch.filter(([id]) => !skip.has(id));
      if (!batch.length) {
        flushing.current = false;
        propsRef.current.onSaveState(skip.size ? "saving" : "saved");
        return;
      }
      propsRef.current.onSaveState("saving");
      const ops = batch.map(([, op]) => op);
      for (const [id] of batch) inflight.current.add(id);
      try {
        const res = await propsRef.current.saveOps({
          clientOpId: newId(),
          baseRevision: revisionRef.current,
          ops,
        });
        revisionRef.current = Math.max(revisionRef.current, res.revision);
        propsRef.current.onSaveState(dirtyOps.current.size ? "dirty" : "saved");
      } catch (e) {
        for (const [id, op] of batch)
          if (!dirtyOps.current.has(id)) dirtyOps.current.set(id, op);
        if (e instanceof ApiError && e.code === "CANVAS_CONFLICT") {
          // 不静默覆盖：保留本地改动，等用户选择“保留我的”或“采用服务器版本”
          const d = (e.details ?? {}) as {
            revision?: number;
            serverElements?: XEl[];
          };
          conflictRef.current = {
            revision: Number(d.revision ?? revisionRef.current),
            serverElements: d.serverElements ?? [],
            ops,
          };
          propsRef.current.onSaveState("conflict");
          propsRef.current.onNotice(
            "画布在别处已更新，和你的改动有冲突。请在顶栏选择保留你的改动，或采用服务器版本。",
            "error",
          );
        } else {
          propsRef.current.onSaveState("error");
        }
      } finally {
        for (const [id] of batch) inflight.current.delete(id);
        flushing.current = false;
        if (
          dirtyOps.current.size &&
          !conflictRef.current &&
          !flushTimer.current
        )
          flushTimer.current = setTimeout(() => {
            flushTimer.current = undefined;
            void flush();
          }, 1500);
      }
    }, [projectId]);

    const scheduleFlush = useCallback(() => {
      propsRef.current.onSaveState("dirty");
      clearTimeout(flushTimer.current);
      flushTimer.current = setTimeout(() => {
        flushTimer.current = undefined;
        void flush();
      }, 900);
    }, [flush]);

    useEffect(
      () => () => {
        clearTimeout(flushTimer.current);
        void flush(); // 离开页面时尽力保存
      },
      [flush],
    );

    // ───── onChange：选择、工具条位置、保存差异、场景签名 ─────
    // biome-ignore lint/correctness/useExhaustiveDependencies: api()、fitTo、contentKey 等是每次渲染重建但只读 ref 的辅助函数，列入依赖会让回调每次渲染都变
    const handleChange = useCallback(
      (elements: readonly XEl[], appState: XAny) => {
        // 保存差异（占位/高亮不保存）
        let changed = false;
        for (const el of elements) {
          if (isTransient(el) || customDataOf(el)?.kind === BAND_KIND) continue; // 底条只在前端，不保存
          const v = Number(el.version ?? 0);
          if (sentVersions.current.get(el.id) === v) continue;
          sentVersions.current.set(el.id, v);
          const key = contentKey(el);
          if (syncedKeys.current.get(el.id) === key) continue; // 只是版本号/索引变了
          syncedKeys.current.set(el.id, key);
          dirtyOps.current.set(
            el.id,
            el.isDeleted
              ? { kind: "delete", elementId: el.id }
              : { kind: "upsert", element: el },
          );
          changed = true;
        }
        if (changed) scheduleFlush();

        // 选中的图片
        const selectedIds = Object.keys(
          appState.selectedElementIds ?? {},
        ).filter((id) => appState.selectedElementIds[id]);
        const selImages = elements.filter(
          (e) =>
            !e.isDeleted &&
            e.type === "image" &&
            selectedIds.includes(e.id) &&
            !isTransient(e),
        );
        const selKey = selImages.map((e) => e.id).join(",");
        if (selKey !== selRef.current) {
          selRef.current = selKey;
          propsRef.current.onSelection(
            selImages.map((e) => ({ id: e.id, name: nameOf(e) })),
          );
        }

        // 浮动工具条：选中图片外框上方；离顶部太近时翻到下方
        if (selImages.length && appState.zoom) {
          const z = appState.zoom.value as number;
          const minX = Math.min(...selImages.map((e) => e.x));
          const maxX = Math.max(...selImages.map((e) => e.x + e.width));
          const minY = Math.min(...selImages.map((e) => e.y));
          const maxY = Math.max(...selImages.map((e) => e.y + e.height));
          const x = Math.min(
            Math.max(((minX + maxX) / 2 + appState.scrollX) * z, 200),
            Math.max(200, appState.width - 200),
          );
          const topY = (minY + appState.scrollY) * z - 12;
          const bottomY = (maxY + appState.scrollY) * z + 12;
          const flip = topY < 64;
          const y = flip ? Math.min(bottomY, appState.height - 56) : topY;
          const locked = selImages.every((e) => e.locked);
          const prev = toolbarRef.current;
          if (
            !prev ||
            Math.abs(prev.x - x) > 0.5 ||
            Math.abs(prev.y - y) > 0.5 ||
            prev.ids.join() !== selKey ||
            prev.flip !== flip ||
            prev.locked !== locked
          ) {
            const next = {
              x,
              y,
              flip,
              menuBelow: y < appState.height * 0.5,
              ids: selImages.map((e) => e.id),
              locked,
            };
            toolbarRef.current = next;
            setToolbar(next);
          }
        } else if (toolbarRef.current) {
          toolbarRef.current = null;
          setToolbar(null);
        }

        // 自有工具条状态：当前工具、缩放、可撤销/重做（读原生隐藏按钮的 disabled）、被锁定对象数
        const root = wrapRef.current;
        const nextChrome: ChromeState = {
          tool: String(appState.activeTool?.type ?? "selection"),
          zoom: Number(appState.zoom?.value ?? 1),
          canUndo: !(
            root?.querySelector<HTMLButtonElement>('button[aria-label="撤销"]')
              ?.disabled ?? true
          ),
          canRedo: !(
            root?.querySelector<HTMLButtonElement>('button[aria-label="重做"]')
              ?.disabled ?? true
          ),
          locked: elements.filter(
            (e) =>
              !e.isDeleted &&
              e.locked &&
              !isTransient(e) &&
              !customDataOf(e)?.hidden,
          ).length,
        };
        const pc = chromeRef.current;
        if (
          pc.tool !== nextChrome.tool ||
          Math.abs(pc.zoom - nextChrome.zoom) > 0.001 ||
          pc.canUndo !== nextChrome.canUndo ||
          pc.canRedo !== nextChrome.canRedo ||
          pc.locked !== nextChrome.locked
        ) {
          chromeRef.current = nextChrome;
          setChrome(nextChrome);
        }

        // 图层面板打开时：对象增删、锁定、隐藏、选中、顺序变化才刷新列表
        if (layersOpenRef.current) {
          const lsig = elements
            .filter((e) => !e.isDeleted && !isTransient(e))
            .map(
              (e) =>
                `${e.id}:${e.locked ? 1 : 0}:${customDataOf(e)?.hidden ? 1 : 0}:${appState.selectedElementIds?.[e.id] ? 1 : 0}`,
            )
            .join(";");
          if (lsig !== layerSigRef.current) {
            layerSigRef.current = lsig;
            setLayerTick((t) => t + 1);
          }
        }

        const isEmpty = !elements.some((e) => !e.isDeleted);
        setEmptyCanvas((prev) => (prev === isEmpty ? prev : isEmpty));

        // 外观/增删签名（引用较旧、结果卡“已移除”据此刷新）
        const sig = elements
          .filter((e) => e.type === "image" && !isTransient(e))
          .map((e) => `${e.id}:${e.isDeleted ? 0 : 1}:${appearanceKey(e)}`)
          .join(";");
        if (sig !== sigRef.current) {
          sigRef.current = sig;
          propsRef.current.onSceneSig(sig);
        }
      },
      [scheduleFlush],
    );

    const handleScroll = useCallback(
      (scrollX: number, scrollY: number, zoom: { value: number }) => {
        if (
          Date.now() < ignoreScrollUntil.current ||
          Date.now() - lastGesture.current > 1500
        )
          return;
        userMoved.current = true;
        writeJson(vpKey, { scrollX, scrollY, zoom: zoom.value });
      },
      [vpKey],
    );

    /**
     * 服务端来的元素进入 Excalidraw 后会被补上 index 等字段并提升 version。
     * 把场景里的实际版本记为“已同步”，否则差异检测会把它们当成用户改动回写，后端就会误以为用户手动移动过（影响整批重排）。
     */
    const markSynced = (ids?: Set<string>) => {
      for (const e of (api()?.getSceneElementsIncludingDeleted() ??
        []) as XEl[]) {
        if (isTransient(e) || (ids && !ids.has(e.id))) continue;
        sentVersions.current.set(e.id, Number(e.version ?? 0));
        syncedKeys.current.set(e.id, contentKey(e));
      }
    };

    /** 保证画布里有这张图的文件数据（fileId = Asset ID，从 /api/assets/:id 取回） */
    const ensureFile = async (fileId: string) => {
      const x = api();
      if (!x || x.getFiles()[fileId]) return;
      try {
        const dataURL = await toDataUrl(getApi().assetUrl(fileId));
        x.addFiles([
          {
            id: fileId as XAny,
            dataURL: dataURL as XAny,
            mimeType: mimeOfDataUrl(dataURL) as XAny,
            created: Date.now(),
          },
        ]);
        knownAssets.current.add(fileId);
      } catch {
        /* 单张图加载失败：该元素显示为占位，不影响其他 */
      }
    };

    // 适应视图：缩放上限 100%，不把图片放大
    const fitTo = (els: XEl[], factor = 0.8) => {
      const x = api();
      if (!x || !els.length) return;
      const st = x.getAppState();
      const minX = Math.min(...els.map((e) => e.x));
      const minY = Math.min(...els.map((e) => e.y));
      const maxX = Math.max(...els.map((e) => e.x + e.width));
      const maxY = Math.max(...els.map((e) => e.y + e.height));
      const bw = Math.max(1, maxX - minX);
      const bh = Math.max(1, maxY - minY);
      const zoom = Math.min(
        1,
        Math.max(
          0.05,
          Math.min((st.width * factor) / bw, (st.height * factor) / bh),
        ),
      );
      markProgrammaticScroll();
      x.updateScene({
        appState: {
          zoom: { value: zoom },
          scrollX: st.width / (2 * zoom) - (minX + maxX) / 2,
          scrollY: st.height / (2 * zoom) - (minY + maxY) / 2,
        } as XAny,
      });
    };

    // ───── 画布 API 就绪：补文件、居中空画布 ─────
    // biome-ignore lint/correctness/useExhaustiveDependencies: api()、fitTo 等是每次渲染重建但只读 ref 的辅助函数，列入依赖会让副作用每次渲染都重跑
    const onApi = useCallback(
      (x: ExcalidrawImperativeAPI) => {
        apiRef.current = x;
        // 开发/演示时暴露给控制台，方便手工检查场景
        if (process.env.NODE_ENV !== "production")
          (window as unknown as { __excalidraw?: unknown }).__excalidraw = x;
        markSynced();
        markProgrammaticScroll();
        void Promise.all(
          Object.keys(initial.files)
            .filter((fid) => !x.getFiles()[fid])
            .map((fid) => ensureFile(fid)),
        );
        const alive = initial.elements.filter((e) => !e.isDeleted);
        if (!readJson(vpKey)) {
          // 容器尺寸在首帧后才稳定，稍等再定位视图
          setTimeout(() => {
            const cur = apiRef.current;
            if (!cur) return;
            markProgrammaticScroll();
            if (alive.length === 0) {
              // 空画布：把原点放在视口中心，占位和首批结果才会出现在视野里
              const st = cur.getAppState();
              cur.updateScene({
                appState: {
                  scrollX: st.width / 2,
                  scrollY: st.height / 2,
                } as XAny,
              });
            } else {
              fitTo(alive as XEl[]);
            }
          }, 200);
        }
        setApiReady(true);
      },
      [initial, vpKey],
    );

    // ───── 占位：按批次估算位置（规则与后端一致），以场景为准做差异更新 ─────
    // 真实结果的位置由服务端决定；这里只给“进行中”的任务一个大致的位置，结果到达后占位消失
    // biome-ignore lint/correctness/useExhaustiveDependencies: api()、fitTo 等是每次渲染重建但只读 ref 的辅助函数，列入依赖会让副作用每次渲染都重跑
    useEffect(() => {
      const x = api();
      if (!x || !apiReady) return;
      let cancelled = false;
      void (async () => {
        const { convertToExcalidrawElements, CaptureUpdateAction } =
          await import("@excalidraw/excalidraw");
        if (cancelled) return;
        const scene = x.getSceneElementsIncludingDeleted() as XEl[];
        const live = scene.filter((e) => !e.isDeleted && !isTransient(e));
        const wanted = new Map<
          string,
          { slot: Slot; rect: Rect; label: string; frameId?: string }
        >();
        for (const b of batches) {
          if (!b.slots.some(needsPlaceholder)) continue;
          const ids = new Set(b.slots.map((t) => `element_${t.taskId}`));
          const sizes = b.slots.map((t) => {
            const ex = live.find((e) => e.id === `element_${t.taskId}`);
            return ex
              ? { width: ex.width, height: ex.height }
              : { width: 360, height: 360 };
          });
          const src = b.sourceElementId
            ? live.find((e) => e.id === b.sourceElementId)
            : undefined;
          const obstacles = live
            .filter((e) => !ids.has(e.id))
            .map((e) => worldBounds(e));
          const rects = layoutRow({
            sizes,
            source: src ? worldBounds(src) : undefined,
            viewportCenter: b.viewportCenter,
            obstacles,
          });
          b.slots.forEach((t, i) => {
            // 服务端冻结的 slot 优先（与最终结果位置一致）；没有才用前端估算
            const fr = t.frameId
              ? live.find((e) => e.id === t.frameId)
              : undefined;
            const rect: Rect | undefined = fr
              ? { x: fr.x, y: fr.y, width: fr.width, height: fr.height }
              : t.slot
                ? {
                    x: t.slot.x,
                    y: t.slot.y,
                    width: t.slot.w,
                    height: t.slot.h,
                  }
                : rects[i];
            if (rect && needsPlaceholder(t))
              wanted.set(`${b.runId}:${t.slotIndex}`, {
                slot: t,
                rect,
                label: placeholderLabel(t),
                ...(fr ? { frameId: fr.id as string } : {}),
              });
          });
        }
        const sigOf = (label: string, r: Rect) =>
          `${label}|${theme}|${Math.round(r.x)}|${Math.round(r.y)}`;
        const existing = new Map<string, string>();
        for (const el of scene) {
          const cd = customDataOf(el);
          if (
            cd?.kind === "placeholder" &&
            el.type === "rectangle" &&
            !el.isDeleted
          )
            existing.set(String(cd.slotKey), String(cd.sig));
        }
        const stale = new Set<string>();
        const add: XEl[] = [];
        for (const [key, sig] of existing) {
          const w = wanted.get(key);
          if (!w || sigOf(w.label, w.rect) !== sig) stale.add(key);
        }
        for (const [key, w] of wanted) {
          const sig = sigOf(w.label, w.rect);
          if (existing.get(key) === sig) continue;
          const failed = w.slot.state === "failed";
          const color = failed ? palette.failStroke : palette.stroke;
          const made = convertToExcalidrawElements([
            {
              type: "rectangle",
              id: `ph_${key}_${w.slot.state}`,
              x: w.rect.x,
              y: w.rect.y,
              width: w.rect.width,
              height: w.rect.height,
              strokeStyle: "dashed",
              strokeWidth: 2,
              strokeColor: color,
              backgroundColor: failed ? palette.failFill : palette.fill,
              fillStyle: "solid",
              roughness: 0,
              roundness: { type: 3, value: 18 },
              opacity: 80,
              locked: true,
              label: {
                text: w.label,
                fontSize: 18,
                fontFamily: 2,
                strokeColor: color,
              },
            } as XAny,
          ]) as XEl[];
          for (const m of made) {
            m.customData = {
              kind: "placeholder",
              slotKey: key,
              sig,
              taskId: w.slot.taskId,
            };
            m.locked = true;
            if (w.frameId) m.frameId = w.frameId;
            add.push(m);
          }
        }
        if (!stale.size && !add.length) return;
        const kept = scene.filter((e) => {
          const cd = customDataOf(e);
          return !(cd?.kind === "placeholder" && stale.has(String(cd.slotKey)));
        });
        const merged = [...kept];
        for (const m of add) placeInFrame(merged, m);
        x.updateScene({
          elements: merged,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        // 画布原本是空的、用户也没动过视图：第一次生成时把占位框放到视野中央（否则它们落在原点右下，被底部工具条挡住）
        if (add.length && live.length === 0 && !userMoved.current) {
          markProgrammaticScroll();
          fitTo(add, 0.6);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [batches, remoteOps, apiReady, theme, palette]);

    // 主题切换：画布背景和默认描边色跟随（画布里的图片不做反色，保持真实颜色）
    // biome-ignore lint/correctness/useExhaustiveDependencies: api()、fitTo 等是每次渲染重建但只读 ref 的辅助函数，列入依赖会让副作用每次渲染都重跑
    useEffect(() => {
      apiRef.current?.updateScene({
        appState: {
          viewBackgroundColor: palette.bg,
          currentItemStrokeColor: palette.ink,
        } as XAny,
      });
    }, [palette, apiReady]);

    // ───── 服务端画布操作（结果插入、整批重排、其他窗口的改动）：只渲染，不在前端自己算位置 ─────
    // biome-ignore lint/correctness/useExhaustiveDependencies: api()、fitTo 等是每次渲染重建但只读 ref 的辅助函数，列入依赖会让副作用每次渲染都重跑
    useEffect(() => {
      const x = api();
      if (!x || !apiReady) return;
      const fresh = remoteOps.filter((o) => o.revision > appliedRemote.current);
      if (!fresh.length) return;
      void (async () => {
        const { restoreElements, CaptureUpdateAction } = await import(
          "@excalidraw/excalidraw"
        );
        for (const batch of fresh) {
          appliedRemote.current = Math.max(
            appliedRemote.current,
            batch.revision,
          );
          revisionRef.current = Math.max(revisionRef.current, batch.revision);
          // 先把图片取回来，再读场景并同步写回：中间不能有 await，否则会用过期的场景覆盖掉占位的清理
          await Promise.all(
            batch.ops.flatMap((op) =>
              op.kind === "upsert" &&
              op.element.fileId &&
              !x.getFiles()[String(op.element.fileId)]
                ? [ensureFile(String(op.element.fileId))]
                : [],
            ),
          );
          const st = x.getAppState();
          const sx = st as XAny;
          const dragging = !!(
            sx.newElement ||
            sx.resizingElement ||
            sx.selectedElementsAreBeingDragged ||
            sx.editingTextElement
          );
          const scene = x.getSceneElementsIncludingDeleted() as XEl[];
          const hadContent = scene.some((e) => !e.isDeleted && !isTransient(e));
          let next = [...scene];
          let addedImage = false;
          for (const op of batch.ops) {
            const id = op.kind === "upsert" ? op.element.id : op.elementId;
            // 本地正在拖动、有未提交或提交中改动的元素，不被任何来源的回显/重排覆盖（否则松手后会弹回旧位置）。
            // 真有冲突由保存时的 409 处理，不在这里静默决定谁赢。
            if (
              dirtyOps.current.has(id) ||
              inflight.current.has(id) ||
              dragging
            ) {
              console.debug(
                "[canvas] 跳过对本地未保存元素的远程更新",
                id,
                batch.source,
              );
              continue;
            }
            if (op.kind === "upsert") {
              const [restored] = restoreElements(
                [op.element as XAny],
                null,
              ) as XEl[];
              if (!restored) continue;
              sentVersions.current.set(
                restored.id,
                Number(restored.version ?? 0),
              );
              const i = next.findIndex((e) => e.id === restored.id);
              if (i >= 0) next[i] = restored;
              else {
                next = [...next];
                // frame 里的底图放在同一 frame 的文字图层下面
                if (restored.type === "image") placeInFrame(next, restored);
                else next.push(restored);
                if (restored.type === "image") addedImage = true;
              }
            } else {
              next = next.map((e) =>
                e.id === op.elementId
                  ? { ...e, isDeleted: true, version: (e.version ?? 0) + 1 }
                  : e,
              );
            }
          }
          // 套图文字（新写入或服务端改了卖点）统一排版；排版产生的改动不是用户改动，不回写
          const typeset = typesetScene(next);
          next = typeset.elements as XEl[];
          x.updateScene({
            elements: next,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          markSynced(
            new Set([
              ...batch.ops.map((o) =>
                o.kind === "upsert" ? o.element.id : o.elementId,
              ),
              ...typeset.changed,
            ]),
          );
          // 新结果不抢视角；只有画布原本为空且用户没动过视图时，首批完成后适应结果
          if (addedImage && !hadContent && !userMoved.current) {
            const images = next.filter(
              (e) =>
                !e.isDeleted &&
                (e.type === "image" || customDataOf(e)?.kind === "placeholder"),
            );
            markProgrammaticScroll();
            fitTo(images, 0.75);
          }
        }
      })();
    }, [remoteOps, apiReady]);

    // 主题切换时刷新（Excalidraw 的 theme 是受控 prop）；标签页切回来时需要重新量尺寸
    useEffect(() => {
      if (active) requestAnimationFrame(() => apiRef.current?.refresh());
    }, [active]);

    // ───── 命令式接口 ─────
    const nameOf = (e: XEl): string => {
      const cd = customDataOf(e);
      if (
        typeof cd?.artifactId === "string" &&
        typeof cd.slotIndex === "number"
      )
        return `方案 ${cd.slotIndex + 1}`;
      return "画布图片";
    };
    const findEl = (id: string): XEl | undefined =>
      (api()?.getSceneElements() as XEl[] | undefined)?.find(
        (e) => e.id === id,
      );

    // biome-ignore lint/correctness/useExhaustiveDependencies: api()、fitTo 等是每次渲染重建但只读 ref 的辅助函数，列入依赖会让副作用每次渲染都重跑
    useImperativeHandle(
      ref,
      (): CanvasHandle => ({
        getViewportCenter() {
          const x = api();
          if (!x) return { x: 0, y: 0 };
          const st = x.getAppState();
          return {
            x: st.width / 2 / st.zoom.value - st.scrollX,
            y: st.height / 2 / st.zoom.value - st.scrollY,
          };
        },
        getSelectedImages() {
          const x = api();
          if (!x) return [];
          const st = x.getAppState();
          return (x.getSceneElements() as XEl[])
            .filter(
              (e) =>
                e.type === "image" &&
                st.selectedElementIds[e.id] &&
                !isTransient(e),
            )
            .map((e) => ({ id: e.id, name: nameOf(e) }));
        },
        async referenceInputFor(elementId) {
          const x = api();
          const el = findEl(elementId);
          if (!x || !el) return null;
          const data = x.getFiles()[el.fileId]?.dataURL as string | undefined;
          if (!data) return null;
          const thumb = await makeThumb(data);
          const fileId = String(el.fileId);
          return {
            elementId,
            name: nameOf(el),
            previewUrl: thumb,
            width: Math.round(el.width),
            height: Math.round(el.height),
            appearanceKey: appearanceKey(el),
            resolveSourceAssetId: async () => {
              if (knownAssets.current.has(fileId)) return fileId;
              // 用户自己放进画布的图：先上传成 Asset（同时把元素换成 Asset 引用）
              const asset = await getApi().uploadAsset(
                await dataUrlToFile(data, `canvas-${fileId.slice(0, 8)}.png`),
                { projectId },
              );
              knownAssets.current.add(asset.id);
              return asset.id;
            },
          };
        },
        async referenceInputForArtifact(a) {
          const el = (api()?.getSceneElements() as XEl[] | undefined)?.find(
            (e) => !e.isDeleted && customDataOf(e)?.artifactId === a.id,
          );
          const data = await toDataUrl(a.asset.url);
          return {
            ...(el
              ? { elementId: el.id as string, appearanceKey: appearanceKey(el) }
              : {}),
            name: `方案 ${a.slotIndex + 1}`,
            previewUrl: await makeThumb(data),
            width: a.asset.width,
            height: a.asset.height,
            resolveSourceAssetId: async () => a.asset.id,
          };
        },
        async exportFrames(frameIds) {
          const x = api();
          if (!x) return [];
          const { exportToBlob } = await import("@excalidraw/excalidraw");
          const all = (x.getSceneElements() as XEl[]).filter(
            (e) => !e.isDeleted && !isTransient(e),
          );
          // 先保证 frame 里的图片数据都在内存里（刚刷新时可能还在后台取回）
          await Promise.all(
            all
              .filter((e) => e.type === "image" && e.fileId)
              .map((e) => ensureFile(String(e.fileId))),
          );
          const out: Array<{ id: string; blob: Blob }> = [];
          for (const id of frameIds) {
            const frame = all.find((e) => e.id === id && e.type === "frame");
            if (!frame) continue;
            const img = all.find((e) => e.type === "image" && e.frameId === id);
            const natural = Number(customDataOf(img ?? {})?.naturalWidth);
            const scale =
              natural > 0
                ? Math.min(4, Math.max(1, natural / frame.width))
                : 2;
            const blob = await exportToBlob({
              elements: all,
              appState: {
                exportBackground: true,
                viewBackgroundColor: "#ffffff",
                exportWithDarkMode: false,
                frameRendering: {
                  enabled: true,
                  name: false,
                  outline: false,
                  clip: true,
                },
              } as XAny,
              files: x.getFiles(),
              exportingFrame: frame,
              mimeType: "image/png",
              getDimensions: (w: number, h: number) => ({
                width: Math.round(w * scale),
                height: Math.round(h * scale),
                scale,
              }),
            });
            console.info("[canvas] 导出 frame", id, Math.round(frame.width * scale), "px 宽");
            out.push({ id, blob });
          }
          return out;
        },
        elementPixels(elementId) {
          const el = findEl(elementId);
          if (!el) return null;
          const cd = customDataOf(el);
          return {
            width: Math.round(Number(cd?.naturalWidth ?? el.width)),
            height: Math.round(Number(cd?.naturalHeight ?? el.height)),
          };
        },
        appearanceKeyOf(elementId) {
          const el = findEl(elementId);
          return el ? appearanceKey(el) : null;
        },
        elementExists(elementId) {
          return !!findEl(elementId);
        },
        findArtifactElement(artifactId) {
          const el = (api()?.getSceneElements() as XEl[] | undefined)?.find(
            (e) => customDataOf(e)?.artifactId === artifactId,
          );
          return el ? (el.id as string) : null;
        },
        locate(elementId) {
          const x = api();
          const el = findEl(elementId);
          if (!x || !el) return false;
          markProgrammaticScroll();
          x.updateScene({
            appState: { selectedElementIds: { [elementId]: true } } as XAny,
          });
          x.scrollToContent(el, {
            fitToContent: false,
            animate: true,
            duration: 450,
          });
          void (async () => {
            // 高亮：临时描边框，1.8 秒后移除；不保存、不可选
            const { convertToExcalidrawElements, CaptureUpdateAction } =
              await import("@excalidraw/excalidraw");
            const pad = 10;
            const [ring] = convertToExcalidrawElements([
              {
                type: "rectangle",
                id: `hl_${elementId}`,
                x: el.x - pad,
                y: el.y - pad,
                width: el.width + pad * 2,
                height: el.height + pad * 2,
                strokeColor: PALETTE[themeRef.current].stroke,
                strokeWidth: 4,
                backgroundColor: "transparent",
                roughness: 0,
                roundness: { type: 3, value: 14 },
                locked: true,
              } as XAny,
            ]) as XEl[];
            if (!ring) return;
            ring.customData = { kind: "highlight" };
            const base = (x.getSceneElementsIncludingDeleted() as XEl[]).filter(
              (e) => customDataOf(e)?.kind !== "highlight",
            );
            x.updateScene({
              elements: [...base, ring],
              captureUpdate: CaptureUpdateAction.NEVER,
            });
            setTimeout(() => {
              const cur = apiRef.current;
              if (!cur) return;
              cur.updateScene({
                elements: (
                  cur.getSceneElementsIncludingDeleted() as XEl[]
                ).filter((e) => customDataOf(e)?.kind !== "highlight"),
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            }, 1800);
          })();
          return true;
        },
        async reinsertArtifact(a) {
          const x = api();
          if (!x) throw new Error("画布还没准备好");
          const fileId = fileIdForAsset(a.asset.id);
          await ensureFile(fileId);
          knownAssets.current.add(fileId);
          const scene = (x.getSceneElements() as XEl[]).filter(
            (e) => !isTransient(e),
          );
          const st = x.getAppState();
          const center = {
            x: st.width / 2 / st.zoom.value - st.scrollX,
            y: st.height / 2 / st.zoom.value - st.scrollY,
          };
          const size = fitLongEdge(a.asset.width, a.asset.height);
          const [rect] = layoutRow({
            sizes: [size],
            viewportCenter: center,
            obstacles: scene.map((e) => worldBounds(e)),
          });
          const id = newElementId("element");
          const element = makeImageElement({
            id,
            fileId,
            rect: rect ?? { x: center.x, y: center.y, ...size },
            customData: {
              taskId: a.taskId,
              artifactId: a.id,
              snapshotId: a.snapshotId,
              slotIndex: a.slotIndex,
              naturalWidth: a.asset.width,
              naturalHeight: a.asset.height,
              reinserted: true,
            },
          });
          const { restoreElements } = await import("@excalidraw/excalidraw");
          const [restored] = restoreElements([element as XAny], null) as XEl[];
          x.updateScene({
            elements: [
              ...(x.getSceneElementsIncludingDeleted() as XEl[]),
              restored,
            ],
          });
          return id;
        },
        resolveConflict(choice) {
          const c = conflictRef.current;
          const x = api();
          if (!c || !x) return;
          conflictRef.current = null;
          revisionRef.current = Math.max(revisionRef.current, c.revision);
          if (choice === "server") {
            // 采用服务器版本：冲突元素用服务端的替换，本批里不冲突的改动继续提交
            const server = new Map(c.serverElements.map((e) => [e.id, e]));
            const all = x.getSceneElementsIncludingDeleted() as XEl[];
            const next = all.map((e) => server.get(e.id) ?? e);
            for (const e of c.serverElements) {
              sentVersions.current.set(e.id, Number(e.version ?? 0));
              dirtyOps.current.delete(e.id);
            }
            void import("@excalidraw/excalidraw").then(
              ({ CaptureUpdateAction }) =>
                x.updateScene({
                  elements: next,
                  captureUpdate: CaptureUpdateAction.NEVER,
                }),
            );
            for (const op of c.ops) {
              const id = op.kind === "upsert" ? op.element.id : op.elementId;
              if (!server.has(id)) dirtyOps.current.set(id, op);
            }
          } else {
            // 保留我的改动：以服务端最新 revision 为基线重新提交（版本号由服务端规范化）
            for (const op of c.ops) {
              const id = op.kind === "upsert" ? op.element.id : op.elementId;
              if (!dirtyOps.current.has(id)) dirtyOps.current.set(id, op);
            }
          }
          propsRef.current.onSaveState("dirty");
          void flush();
        },
        fitAll() {
          const x = api();
          if (!x) return;
          lastGesture.current = Date.now();
          const els = (x.getSceneElements() as XEl[]).filter(
            (e) => !isTransient(e),
          );
          if (!els.length) return;
          markProgrammaticScroll();
          fitTo(els);
        },
        retrySave() {
          void flush();
        },
      }),
      [flush],
    );

    // ───── 工具条操作 ─────
    const fireKey = (init: KeyboardEventInit) => {
      const mac =
        typeof navigator !== "undefined" &&
        /Mac|iPhone|iPad/.test(navigator.platform);
      // Excalidraw 默认只在自己的容器上处理快捷键，所以事件发到容器元素
      (wrapRef.current?.querySelector(".excalidraw") ?? document).dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...(mac ? { metaKey: true } : { ctrlKey: true }),
          ...init,
        }),
      );
    };
    const selectedEls = (): XEl[] => {
      const x = api();
      if (!x) return [];
      const st = x.getAppState();
      return (x.getSceneElements() as XEl[]).filter(
        (e) => st.selectedElementIds[e.id] && !isTransient(e),
      );
    };
    const withCapture = async (
      fn: (all: XEl[]) => XEl[],
      clearSelection = false,
    ) => {
      const x = api();
      if (!x) return;
      const { CaptureUpdateAction } = await import("@excalidraw/excalidraw");
      x.updateScene({
        elements: fn(x.getSceneElementsIncludingDeleted() as XEl[]),
        ...(clearSelection
          ? { appState: { selectedElementIds: {} } as XAny }
          : {}),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    };
    const bump = (e: XEl, patch: Record<string, unknown>): XEl => ({
      ...e,
      ...patch,
      version: (e.version ?? 0) + 1,
      versionNonce: (Math.random() * 2 ** 31) | 0,
      updated: Date.now(),
    });
    const setTool = (t: ToolId) => api()?.setActiveTool({ type: t } as XAny);
    const zoomBy = (dir: 1 | -1 | 0) => {
      const x = api();
      if (!x) return;
      const st = x.getAppState();
      const z = st.zoom.value as number;
      const nz =
        dir === 0
          ? 1
          : Math.min(8, Math.max(0.05, dir > 0 ? z * 1.25 : z / 1.25));
      const cx = st.width / 2 / z - st.scrollX;
      const cy = st.height / 2 / z - st.scrollY;
      lastGesture.current = Date.now();
      x.updateScene({
        appState: {
          zoom: { value: nz },
          scrollX: st.width / (2 * nz) - cx,
          scrollY: st.height / (2 * nz) - cy,
        } as XAny,
      });
    };
    const clickNative = (label: string) =>
      wrapRef.current
        ?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
        ?.click();
    const zOrder = (dir: "front" | "forward" | "backward" | "back") => {
      const top = dir === "front" || dir === "forward";
      const shift = dir === "front" || dir === "back";
      fireKey({
        key: top ? (shift ? "}" : "]") : shift ? "{" : "[",
        code: top ? "BracketRight" : "BracketLeft",
        shiftKey: shift,
      });
    };
    const toggleLock = () => {
      const sel = selectedEls();
      const ids = new Set(sel.map((e) => e.id));
      const lock = !sel.every((e) => e.locked);
      void withCapture(
        (all) =>
          all.map((e) => (ids.has(e.id) ? bump(e, { locked: lock }) : e)),
        true,
      );
    };
    const unlockAll = () =>
      void withCapture((all) =>
        all.map((e) =>
          e.locked && !isTransient(e) && !customDataOf(e)?.hidden
            ? bump(e, { locked: false })
            : e,
        ),
      );
    const deleteSelected = () => {
      const ids = new Set(selectedEls().map((e) => e.id));
      void withCapture(
        (all) =>
          all.map((e) => (ids.has(e.id) ? bump(e, { isDeleted: true }) : e)),
        true,
      );
    };
    const toolbarDownload = async () => {
      const x = api();
      const els = selectedEls().filter((e) => e.type === "image");
      try {
        for (const el of els) {
          const data = x?.getFiles()[el.fileId]?.dataURL as string | undefined;
          if (!data) throw new Error("图片还没加载完");
          await downloadUrl(data, `${nameOf(el)}.${extFor("", data)}`);
        }
      } catch (e) {
        propsRef.current.onNotice(errorMessage(e, "下载失败"), "error");
      }
    };

    // ───── 图层面板 ─────
    const TYPE_NAME: Record<string, string> = {
      image: "图片",
      text: "文字",
      frame: "框",
      rectangle: "矩形",
      ellipse: "椭圆",
      diamond: "菱形",
      arrow: "箭头",
      line: "线条",
      freedraw: "手绘",
    };
    // layerTick 只用来触发重新渲染；列表直接读场景
    const layers: LayerItem[] = (() => {
      void layerTick;
      const x = api();
      if (!layersOpen || !x) return [];
      const st = x.getAppState();
      return (x.getSceneElements() as XEl[])
        .filter((e) => !isTransient(e) && customDataOf(e)?.kind !== BAND_KIND)
        .map((e): LayerItem => {
          const base =
            e.type === "image"
              ? nameOf(e)
              : e.type === "text"
                ? String(e.text ?? "")
                    .replace(/\s+/g, " ")
                    .slice(0, 14) || "文字"
                : (TYPE_NAME[e.type] ?? e.type);
          const thumb =
            e.type === "image"
              ? (x.getFiles()[e.fileId]?.dataURL as string | undefined)
              : undefined;
          return {
            id: e.id,
            name: base,
            type: e.type,
            locked: !!e.locked,
            hidden: !!customDataOf(e)?.hidden,
            selected: !!st.selectedElementIds[e.id],
            ...(thumb ? { thumb } : {}),
            meta:
              e.type === "image"
                ? `${Math.round(Number(customDataOf(e)?.naturalWidth ?? e.width))}×${Math.round(Number(customDataOf(e)?.naturalHeight ?? e.height))}`
                : (TYPE_NAME[e.type] ?? e.type),
          };
        })
        .reverse(); // 上层在前
    })();
    const selectLayer = (id: string) =>
      api()?.updateScene({
        appState: { selectedElementIds: { [id]: true } } as XAny,
      });
    const locateLayer = async (id: string) => {
      const x = api();
      const el = findEl(id);
      if (!x || !el) return;
      selectLayer(id);
      markProgrammaticScroll();
      x.scrollToContent(el, {
        fitToContent: false,
        animate: true,
        duration: 350,
      });
    };
    const toggleLayerFlag = (id: string, flag: "lock" | "hidden") => {
      void withCapture((all) =>
        all.map((e) => {
          if (e.id !== id) return e;
          if (flag === "lock") return bump(e, { locked: !e.locked });
          const cd = customDataOf(e) ?? {};
          if (cd.hidden) {
            const { hidden: _h, prevOpacity, prevLocked, ...rest } = cd;
            return bump(e, {
              opacity: typeof prevOpacity === "number" ? prevOpacity : 100,
              locked: !!prevLocked,
              customData: rest,
            });
          }
          return bump(e, {
            opacity: 0,
            locked: true,
            customData: {
              ...cd,
              hidden: true,
              prevOpacity: e.opacity ?? 100,
              prevLocked: !!e.locked,
            },
          });
        }),
      );
    };
    const moveLayer = (id: string, dir: "up" | "down") => {
      selectLayer(id);
      // 选中状态应用后再触发层级快捷键
      requestAnimationFrame(() =>
        zOrder(dir === "up" ? "forward" : "backward"),
      );
    };

    const touch = () => {
      lastGesture.current = Date.now();
    };

    return (
      <div
        className="canvas-wrap"
        ref={wrapRef}
        onWheelCapture={touch}
        onPointerDownCapture={touch}
        onPointerMoveCapture={(e) => {
          if (e.buttons) lastGesture.current = Date.now();
        }}
        onKeyDownCapture={touch}
      >
        <Excalidraw
          theme={theme}
          langCode="zh-CN"
          initialData={initialData.current}
          excalidrawAPI={onApi}
          onChange={handleChange}
          onScrollChange={handleScroll}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              clearCanvas: false,
              export: false,
              toggleTheme: false,
            },
            tools: { image: true },
          }}
        />
        <CanvasDock
          chrome={chrome}
          onTool={setTool}
          onZoom={zoomBy}
          onUndo={() => clickNative("撤销")}
          onRedo={() => clickNative("重做")}
          onUnlockAll={unlockAll}
          layersOpen={layersOpen}
          onToggleLayers={() => setLayersOpen((o) => !o)}
        />
        {emptyCanvas && (
          <output className="canvas-empty">
            {working ? (
              <>
                <span className="spinner spinner-lg" aria-hidden />
                <strong>Agent 正在理解需求</strong>
                <span>生成开始后，占位框会先出现在这里</span>
              </>
            ) : (
              <>
                <strong>画布还是空的</strong>
                <span>在右侧描述想画的内容，生成的图片会出现在这里</span>
                <span>也可以把图片拖进来或直接粘贴</span>
              </>
            )}
          </output>
        )}
        {layersOpen && (
          <LayersPanel
            items={layers}
            onClose={() => setLayersOpen(false)}
            onSelect={selectLayer}
            onLocate={(id) => void locateLayer(id)}
            onToggleLock={(id) => toggleLayerFlag(id, "lock")}
            onToggleHidden={(id) => toggleLayerFlag(id, "hidden")}
            onMove={moveLayer}
          />
        )}
        {toolbar && (
          <SelectionToolbar
            x={toolbar.x}
            y={toolbar.y}
            flip={toolbar.flip}
            menuBelow={toolbar.menuBelow}
            count={toolbar.ids.length}
            locked={toolbar.locked}
            onReference={() =>
              propsRef.current.onReferenceElements(toolbar.ids)
            }
            onDuplicate={() => fireKey({ key: "d", code: "KeyD" })}
            onDelete={deleteSelected}
            onZ={zOrder}
            onLock={toggleLock}
            onDownload={() => void toolbarDownload()}
            onEdit={(label) => {
              const id = toolbar.ids[0];
              if (id) propsRef.current.onEdit(label, id);
            }}
          />
        )}
      </div>
    );
  },
);
