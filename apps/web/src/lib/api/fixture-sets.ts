import { publicTemplates } from "@loomic/shared/edge";

import {
  makeFrameElement,
  makeImageElement,
  makeTextElement,
} from "../canvas/elements";
import { frameRects } from "../sets/layout";
import {
  type CreateSetRequest,
  type CreateSetResponse,
  type PatchAnalysisBody,
  type RegenerateScope,
  type SellingPoint,
  type SetAnalysis,
  type SetDetail,
  type SetShotStatus,
  type SetTemplate,
  shotBusy,
} from "../sets/types";
import { ApiError, type Asset, type CanvasElement } from "./contract";
import { hash, makeShotSvg, shrinkDataUrl } from "./fixture-art";

/**
 * 套图后端的浏览器内模拟，行为和事件与真实 M6 接口同型（类型全部来自 shared）：
 * analyzing → generating → completed/partial，逐张完成、可失败、额度按张预扣、每天套数有限；
 * 状态变化通过 set.state / set.analyzed / set.shot 事件推送。
 * 画布上写入的文字图层与真实后端一样「粗」：只有位置、文字和 customData，字号/字体/底条由前端排版（lib/sets/typeset.ts）统一处理。
 * 触发演示场景：补充说明里含「失败」时最后一张首次生成失败（可重试）。
 */

interface ShotRec {
  shotId: string;
  state: SetShotStatus["state"];
  gen: number;
  taskId: string;
  frameElementId: string;
  imageElementId: string;
  textElementIds: string[];
  assetId?: string;
  error?: SetShotStatus["error"];
}
export interface SetRec {
  setId: string;
  projectId: string;
  threadId: string;
  templateId: string;
  lang: "zh" | "en";
  note: string;
  productThumb: string;
  state: SetDetail["state"];
  analysis?: SetAnalysis;
  shots: ShotRec[];
}

export interface SetHost {
  sets: Record<string, SetRec>;
  assets: Record<string, Asset>;
  uid(prefix: string): string;
  /** 新建项目 + 线程，返回 ID */
  createProject(title: string, setId: string): { projectId: string; threadId: string };
  /** 写入/更新画布元素并发 canvas.ops（source: task） */
  upsert(projectId: string, elements: CanvasElement[]): void;
  getElement(projectId: string, id: string): CanvasElement | undefined;
  setCover(projectId: string, url: string): void;
  emit(projectId: string, type: "set.state" | "set.analyzed" | "set.shot", payload: unknown): void;
  /** 今日还能出几张图 / 几套 */
  remaining(): number;
  setsRemaining(): number;
  chargeSet(): void;
  charge(n: number, projectId: string): void;
  refund(n: number, projectId: string): void;
  save(): void;
  addAsset(asset: Asset): void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DELAY = { analyze: 1600, queue: 450, shot: 2200 };
const MAX_SHOT_REGEN = 3;

const TEMPLATES: SetTemplate[] = publicTemplates();
export const templateOf = (id: string): SetTemplate | undefined =>
  TEMPLATES.find((t) => t.id === id);

/** 与后端 textContent 同规则：source 形如 productName | category | audience | sellingPoints.N.title|detail */
function textContent(a: SetAnalysis, source: string, maxChars: number): string {
  const parts = source.split(".");
  const value =
    parts[0] === "sellingPoints"
      ? (a.sellingPoints[Number(parts[1])]?.[parts[2] as "title" | "detail"] ?? "")
      : String(a[parts[0] as "productName" | "category" | "audience"] ?? "");
  return [...value].slice(0, maxChars).join("");
}
/** 与后端 textElements 同样「粗」的默认摆放（真实后端另有一版，前端排版会统一重排） */
function rawTextRect(
  area: string,
  frame: { x: number; y: number; width: number; height: number },
  slots: number,
  index: number,
) {
  const vertical = area === "left" || area === "right";
  const x = frame.x + (area === "right" ? frame.width * 0.72 : 12);
  const y = frame.y + (area === "bottom" ? frame.height * 0.72 : 12);
  const width = vertical ? frame.width * 0.26 - 12 : frame.width - 24;
  const height = (vertical ? frame.height - 24 : frame.height * 0.28 - 12) / Math.max(1, slots);
  return { x, y: y + index * height, width, height };
}

function analyze(lang: "zh" | "en", note: string): SetAnalysis {
  const zh = lang === "zh";
  const points: SellingPoint[] = zh
    ? [
        { title: "防水耐用", detail: "IP67 防水等级，雨天户外也不怕" },
        { title: "轻量便携", detail: "整机仅 320 克，随手放进背包" },
        { title: "长效保温", detail: "12 小时保温，热饮喝一整天" },
        { title: "安全材质", detail: "食品级不锈钢，放心入口" },
        { title: "简约设计", detail: "一体成型，质感耐看" },
      ]
    : [
        { title: "Waterproof", detail: "IP67 rated, built for rain and trails" },
        { title: "Lightweight", detail: "Only 320 g, slips into any bag" },
        { title: "12h Insulation", detail: "Keeps drinks hot all day" },
        { title: "Food-grade Steel", detail: "Safe, clean and long lasting" },
        { title: "Clean Design", detail: "One-piece build, refined finish" },
      ];
  let audience = zh ? "户外徒步人群" : "Outdoor hikers";
  // 用户补充一句时，把它当成第一卖点和人群（真实后端由视觉模型结合补充说明提炼）
  const feat = note.match(/主打\s*([^，,。;；\s]+)/)?.[1];
  const who = note.match(/给\s*([^，,。;；]+)$/)?.[1]?.trim();
  if (feat && zh)
    points[0] = {
      title: [...feat].slice(0, 8).join(""),
      detail: `${[...feat].slice(0, 10).join("")}，经得起日常使用`,
    };
  if (who && zh) audience = [...who].slice(0, 16).join("");
  return {
    productName: zh ? "便携保温杯" : "Portable Insulated Bottle",
    category: zh ? "户外用品" : "Outdoor",
    audience,
    sellingPoints: points,
  };
}

const HUES = [28, 200, 340, 150, 260, 48, 180];

export class FixtureSets {
  constructor(private readonly h: SetHost) {}

  listTemplates(): SetTemplate[] {
    return JSON.parse(JSON.stringify(TEMPLATES)) as SetTemplate[];
  }

  async create(req: CreateSetRequest): Promise<CreateSetResponse> {
    const tpl = templateOf(req.templateId);
    if (!tpl) throw new ApiError("NOT_FOUND", "没有这个模板", { status: 404 });
    if (req.sourceAssetIds.length < 1 || req.sourceAssetIds.length > 3)
      throw new ApiError("INVALID_INPUT", "请上传 1–3 张商品图", {
        status: 422,
      });
    const first = this.h.assets[req.sourceAssetIds[0] ?? ""];
    if (!first)
      throw new ApiError("NOT_FOUND", "找不到上传的商品图", { status: 404 });
    if (this.h.setsRemaining() < 1)
      throw new ApiError(
        "QUOTA_EXCEEDED",
        "今天的套数已经用完，北京时间零点重置后再来",
        { status: 429, details: { remaining: 0, need: tpl.shots.length } },
      );
    const need = tpl.shots.length;
    const left = this.h.remaining();
    if (need > left)
      throw new ApiError(
        "QUOTA_EXCEEDED",
        left > 0
          ? `今天还能生成 ${left} 张，这套需要 ${need} 张。换一个张数更少的模板，或明天再来`
          : "今天的额度已经用完，北京时间零点重置后再来",
        { status: 429, details: { remaining: left, need } },
      );
    const lang = tpl.lang === "auto" ? (req.lang ?? "zh") : tpl.lang;
    const setId = this.h.uid("set");
    const { projectId, threadId } = this.h.createProject(tpl.name, setId);
    this.h.chargeSet();
    this.h.charge(need, projectId);
    const frames = frameRects(tpl.shots);
    const shots: ShotRec[] = tpl.shots.map((s) => ({
      shotId: s.id,
      state: "queued",
      gen: 0,
      taskId: this.h.uid("task"),
      frameElementId: `frame_${setId}_${s.id}`,
      imageElementId: `image_${setId}_${s.id}`,
      textElementIds: [],
    }));
    const rec: SetRec = {
      setId,
      projectId,
      threadId,
      templateId: tpl.id,
      lang,
      note: (req.note ?? "").trim(),
      productThumb: await shrinkDataUrl(first.url, 420),
      state: "analyzing",
      shots,
    };
    this.h.sets[setId] = rec;
    // 先摆出整套 frame（占位），分析和出图逐步填入
    this.h.upsert(
      projectId,
      tpl.shots.map((s, i) =>
        makeFrameElement({
          id: shots[i]?.frameElementId ?? "",
          name: s.name,
          rect: frames[i] ?? { x: 0, y: 0, width: 360, height: 360 },
          customData: { setId, shotId: s.id },
        }),
      ),
    );
    if (req.sellingPoints?.length)
      rec.analysis = {
        ...analyze(lang, rec.note),
        sellingPoints: req.sellingPoints,
      };
    this.h.save();
    void this.run(rec);
    return { setId, projectId, threadId };
  }

  get(setId: string): SetDetail {
    const rec = this.h.sets[setId];
    if (!rec) throw new ApiError("NOT_FOUND", "套图不存在", { status: 404 });
    return {
      setId,
      projectId: rec.projectId,
      threadId: rec.threadId,
      templateId: rec.templateId,
      lang: rec.lang,
      state: rec.state,
      ...(rec.analysis
        ? { analysis: JSON.parse(JSON.stringify(rec.analysis)) as SetAnalysis }
        : {}),
      shots: rec.shots.map((s) => this.shotView(s)),
    };
  }

  /** 单张重出：每套最多 3 次，不占套数，按 1 张预扣 */
  async regenerate(setId: string, shotId: string): Promise<void> {
    const rec = this.h.sets[setId];
    const shot = rec?.shots.find((s) => s.shotId === shotId);
    if (!rec || !shot)
      throw new ApiError("NOT_FOUND", "没有这张图", { status: 404 });
    if (shotBusy(shot))
      throw new ApiError("RUN_ACTIVE", "这张图正在生成", { status: 409 });
    if (shot.gen >= MAX_SHOT_REGEN)
      throw new ApiError("QUOTA_EXCEEDED", `这一张最多重新生成 ${MAX_SHOT_REGEN} 次`, {
        status: 429,
      });
    this.charge(rec, 1);
    this.restart(rec, shot, 0);
    this.refreshState(rec);
    this.h.save();
  }

  /** 重出失败的 / 整套重出：按张预扣，额度不足整体拒绝 */
  async regenerateSet(setId: string, scope: RegenerateScope): Promise<void> {
    const rec = this.h.sets[setId];
    if (!rec) throw new ApiError("NOT_FOUND", "套图不存在", { status: 404 });
    const targets = rec.shots.filter(
      (s) => !shotBusy(s) && (scope === "all" || s.state === "failed"),
    );
    if (!targets.length)
      throw new ApiError("INVALID_INPUT", "没有需要重新生成的图", { status: 409 });
    this.charge(rec, targets.length);
    targets.forEach((s, i) => this.restart(rec, s, i * DELAY.queue));
    this.refreshState(rec);
    this.h.save();
  }

  /** 改商品名/人群/卖点：只更新对应文字图层，不重出图 */
  async patchAnalysis(setId: string, body: PatchAnalysisBody): Promise<void> {
    const rec = this.h.sets[setId];
    if (!rec?.analysis)
      throw new ApiError("INVALID_INPUT", "请等待商品分析完成", { status: 409 });
    rec.analysis = {
      ...rec.analysis,
      ...(body.sellingPoints ? { sellingPoints: body.sellingPoints } : {}),
      ...(body.productName !== undefined ? { productName: body.productName } : {}),
      ...(body.audience !== undefined ? { audience: body.audience } : {}),
    };
    this.reflowTexts(rec);
    this.h.emit(rec.projectId, "set.analyzed", { setId, analysis: rec.analysis });
    this.h.save();
  }

  /** 页面刷新会中断模拟：未完成的张标为可重试失败，分析缺失则补上 */
  recover() {
    for (const rec of Object.values(this.h.sets)) {
      if (rec.state !== "analyzing" && rec.state !== "generating") continue;
      if (!rec.analysis) {
        rec.analysis = analyze(rec.lang, rec.note);
        this.writeTexts(rec);
      }
      for (const s of rec.shots)
        if (shotBusy(s)) {
          s.state = "failed";
          s.error = {
            code: "PROVIDER_ERROR",
            message: "演示数据：页面刷新中断了这张的生成，可以重新生成",
            retryable: true,
          };
        }
      this.computeState(rec);
    }
  }

  // ───────── 内部 ─────────
  private shotView(s: ShotRec): SetShotStatus {
    return {
      shotId: s.shotId,
      state: s.state,
      taskId: s.taskId,
      frameElementId: s.frameElementId,
      ...(s.state === "completed" ? { imageElementId: s.imageElementId } : {}),
      textElementIds: [...s.textElementIds],
      ...(s.error ? { error: s.error } : {}),
    };
  }
  private emitShot(rec: SetRec, s: ShotRec) {
    this.h.emit(rec.projectId, "set.shot", { setId: rec.setId, ...this.shotView(s) });
  }
  private charge(rec: SetRec, n: number) {
    if (this.h.remaining() < n)
      throw new ApiError(
        "QUOTA_EXCEEDED",
        `今天还能生成 ${this.h.remaining()} 张，这次需要 ${n} 张`,
        { status: 429, details: { remaining: this.h.remaining(), need: n } },
      );
    this.h.charge(n, rec.projectId);
  }
  private restart(rec: SetRec, shot: ShotRec, delay: number) {
    shot.state = "queued";
    delete shot.error;
    shot.gen += 1;
    shot.taskId = this.h.uid("task");
    this.emitShot(rec, shot);
    void this.generateShot(rec, shot, delay);
  }
  private computeState(rec: SetRec): SetDetail["state"] {
    const st = rec.shots.map((s) => s.state);
    if (st.some((s) => shotBusy({ state: s })))
      rec.state = rec.analysis ? "generating" : "analyzing";
    else if (st.every((s) => s === "completed")) rec.state = "completed";
    else if (st.every((s) => s === "failed")) rec.state = "failed";
    else rec.state = "partial";
    return rec.state;
  }
  private refreshState(rec: SetRec) {
    const before = rec.state;
    const after = this.computeState(rec);
    if (before !== after || after === "generating")
      this.h.emit(rec.projectId, "set.state", { setId: rec.setId, state: after });
  }

  private async run(rec: SetRec) {
    if (!rec.analysis) {
      await sleep(DELAY.analyze);
      rec.analysis = analyze(rec.lang, rec.note);
    }
    this.writeTexts(rec);
    this.h.emit(rec.projectId, "set.analyzed", { setId: rec.setId, analysis: rec.analysis });
    rec.state = "generating";
    this.h.emit(rec.projectId, "set.state", { setId: rec.setId, state: "generating" });
    this.h.save();
    // 并行出图：错开启动时间，完成顺序也不固定
    await Promise.all(
      rec.shots.map((s, i) => this.generateShot(rec, s, i * DELAY.queue)),
    );
  }

  private async generateShot(rec: SetRec, shot: ShotRec, delay: number) {
    const gen = shot.gen;
    await sleep(delay);
    if (shot.gen !== gen) return;
    shot.state = "running";
    this.emitShot(rec, shot);
    const idx = rec.shots.indexOf(shot);
    await sleep(
      DELAY.shot +
        (hash(`${shot.shotId}${gen}`) % 1800) +
        (rec.shots.length - idx) * 150,
    );
    if (shot.gen !== gen) return; // 已被新的重出取代
    const failDemo =
      /失败/.test(rec.note) && gen === 0 && idx === rec.shots.length - 1;
    if (failDemo) {
      shot.state = "failed";
      shot.error = {
        code: "PROVIDER_ERROR",
        message: "模型暂时没有返回结果，不扣额度，可以重新生成这张",
        retryable: true,
      };
      this.h.refund(1, rec.projectId);
    } else this.commitShot(rec, shot);
    this.emitShot(rec, shot);
    this.refreshState(rec);
    this.h.save();
  }

  private commitShot(rec: SetRec, shot: ShotRec) {
    const tpl = templateOf(rec.templateId);
    const def = tpl?.shots.find((s) => s.id === shot.shotId);
    const frameEl = this.h.getElement(rec.projectId, shot.frameElementId);
    if (!tpl || !def || !frameEl) return;
    const k = 1600 / Math.max(frameEl.width, frameEl.height);
    const pw = Math.round(frameEl.width * k);
    const ph = Math.round(frameEl.height * k);
    const idx = tpl.shots.indexOf(def);
    const url = makeShotSvg({
      kind: def.kind,
      textArea: def.textArea ?? "none",
      width: pw,
      height: ph,
      product: rec.productThumb,
      hue: HUES[idx % HUES.length] ?? 28,
      variant: shot.gen,
    });
    const assetId = this.h.uid("asset");
    this.h.addAsset({
      id: assetId,
      url,
      width: pw,
      height: ph,
      sha256: Array.from(
        { length: 64 },
        (_, i) => ((hash(assetId + i) >> 3) & 15).toString(16),
      ).join(""),
      mime: "image/png",
    });
    shot.assetId = assetId;
    const old = this.h.getElement(rec.projectId, shot.imageElementId);
    const img = makeImageElement({
      id: shot.imageElementId,
      fileId: assetId,
      rect: {
        x: frameEl.x,
        y: frameEl.y,
        width: frameEl.width,
        height: frameEl.height,
      },
      frameId: shot.frameElementId,
      customData: {
        taskId: shot.taskId,
        slotIndex: idx,
        naturalWidth: pw,
        naturalHeight: ph,
        setId: rec.setId,
        shotId: shot.shotId,
      },
    });
    // 重出时沿用旧元素的位置和版本，用户拖动过的位置不丢
    this.h.upsert(rec.projectId, [
      old
        ? {
            ...img,
            x: old.x,
            y: old.y,
            width: old.width,
            height: old.height,
            version: old.version,
          }
        : img,
    ]);
    shot.state = "completed";
    delete shot.error;
    if (!rec.shots.some((s) => s !== shot && s.state === "completed"))
      this.h.setCover(rec.projectId, url);
  }

  /** 首次写入全部文字图层（分析完成后）：与真实后端一样只给位置和内容 */
  private writeTexts(rec: SetRec) {
    const tpl = templateOf(rec.templateId);
    const analysis = rec.analysis;
    if (!tpl || !analysis) return;
    const els: CanvasElement[] = [];
    tpl.shots.forEach((def, i) => {
      const shot = rec.shots[i];
      const frame = this.h.getElement(rec.projectId, shot?.frameElementId ?? "");
      if (!shot || !frame) return;
      const area = def.textArea ?? "top";
      shot.textElementIds = [];
      if (area === "none") return;
      def.textSlots.forEach((slot, n) => {
        const id = `text_${rec.setId}_${def.id}_${n}`;
        const text = textContent(analysis, slot.source, slot.maxChars);
        shot.textElementIds.push(id);
        els.push(
          makeTextElement({
            id,
            rect: rawTextRect(area, frame, def.textSlots.length, n),
            text,
            originalText: text,
            fontSize: 20,
            fontFamily: 5,
            color: "#202020",
            lineHeight: 1.25,
            frameId: shot.frameElementId,
            customData: {
              setId: rec.setId,
              shotId: def.id,
              role: slot.role,
              source: slot.source,
              textArea: area,
            },
          }),
        );
      });
    });
    this.h.upsert(rec.projectId, els);
  }

  /** 改分析后：只换文字（用户在画布上手改过文字的图层不覆盖） */
  private reflowTexts(rec: SetRec) {
    const tpl = templateOf(rec.templateId);
    const analysis = rec.analysis;
    if (!tpl || !analysis) return;
    const updates: CanvasElement[] = [];
    for (const def of tpl.shots)
      def.textSlots.forEach((slot, n) => {
        const el = this.h.getElement(rec.projectId, `text_${rec.setId}_${def.id}_${n}`);
        const text = textContent(analysis, slot.source, slot.maxChars);
        if (!el || el.isDeleted || !text) return;
        updates.push({ ...el, text, originalText: text } as CanvasElement);
      });
    if (updates.length) this.h.upsert(rec.projectId, updates);
  }
}
