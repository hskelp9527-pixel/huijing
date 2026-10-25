import type { SnapshotResult } from "../../lib/api/client";
import {
  type Asset,
  DEFAULT_MODEL,
  type GenSettings,
  MAX_REFERENCES,
  type MessageMeta,
  type MessageRequest,
  type ReferencePurpose,
  type SettingsKey,
} from "../../lib/api/contract";
import { must } from "../../lib/utils";

/** Composer 的结构化数据：文字 + 有序图片（上传附件 / 画布引用）+ 设置。首页和工作区共用同一份。 */
export type ImageStatus = "uploading" | "freezing" | "ready" | "failed";

export interface ComposerImage {
  id: string;
  kind: "upload" | "canvas";
  name: string;
  previewUrl: string;
  width?: number;
  height?: number;
  status: ImageStatus;
  error?: string;
  purpose: ReferencePurpose;
  // 上传附件
  asset?: Asset;
  // 画布引用（点“引用”时冻结）
  elementId?: string;
  appearanceKey?: string;
  snapshot?: SnapshotResult;
  /** 用户选择“保持旧版”时记下的外观键，之后只在再次变化时才提示 */
  ackKey?: string;
}

export interface ComposerState {
  text: string;
  images: ComposerImage[];
  settings: GenSettings;
  explicit: SettingsKey[];
  phase: "editing" | "submitting";
  submissionId?: string | undefined;
}

export const DEFAULT_SETTINGS: GenSettings = {
  count: 1,
  aspectRatio: "auto",
  quality: "standard",
  modelId: DEFAULT_MODEL,
};

export const emptyComposer = (): ComposerState => ({
  text: "",
  images: [],
  settings: { ...DEFAULT_SETTINGS },
  explicit: [],
  phase: "editing",
});

export type ComposerAction =
  | { type: "text"; text: string }
  | { type: "add"; images: ComposerImage[] }
  | { type: "patch"; id: string; patch: Partial<ComposerImage> }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; dir: -1 | 1 }
  | { type: "setting"; key: SettingsKey; value: GenSettings[SettingsKey] }
  | { type: "phase"; phase: ComposerState["phase"]; submissionId?: string }
  | {
      type: "restore";
      text: string;
      settings?: Partial<GenSettings>;
      explicit?: SettingsKey[];
      submissionId?: string;
    }
  | { type: "reset" };

export function composerReducer(
  s: ComposerState,
  a: ComposerAction,
): ComposerState {
  // 内容一变就作废旧 submissionId：同一 submissionId 只对应同一份内容
  const edited = (n: Partial<ComposerState>): ComposerState => ({
    ...s,
    ...n,
    submissionId: undefined,
  });
  switch (a.type) {
    case "text":
      return edited({ text: a.text });
    case "add":
      return edited({ images: [...s.images, ...a.images] });
    case "patch": {
      const changes = Object.keys(a.patch).some(
        (k) => k !== "ackKey" && k !== "status" && k !== "error",
      );
      const images = s.images.map((i) =>
        i.id === a.id ? { ...i, ...a.patch } : i,
      );
      return changes ? edited({ images }) : { ...s, images };
    }
    case "remove":
      return edited({ images: s.images.filter((i) => i.id !== a.id) });
    case "move": {
      const idx = s.images.findIndex((i) => i.id === a.id);
      const to = idx + a.dir;
      if (idx < 0 || to < 0 || to >= s.images.length) return s;
      const images = [...s.images];
      const moving = must(images[idx]);
      const other = must(images[to]);
      images[idx] = other;
      images[to] = moving;
      return edited({ images });
    }
    case "setting":
      return edited({
        settings: { ...s.settings, [a.key]: a.value },
        explicit: s.explicit.includes(a.key)
          ? s.explicit
          : [...s.explicit, a.key],
      });
    case "phase":
      return {
        ...s,
        phase: a.phase,
        submissionId:
          a.phase === "submitting"
            ? (a.submissionId ?? s.submissionId)
            : s.submissionId,
      };
    case "restore":
      return {
        ...s,
        text: a.text,
        settings: { ...s.settings, ...(a.settings ?? {}) },
        explicit: a.explicit ?? s.explicit,
        submissionId: a.submissionId,
      };
    case "reset":
      // 发送后清空内容，但保留用户选过的生成设置（数量/比例/清晰度/模型）
      return { ...emptyComposer(), settings: s.settings, explicit: s.explicit };
  }
}

export type SubmitCheck =
  | { ok: true }
  | { ok: false; reason: string; silent?: boolean };

/** 能否发送；不能时给出具体指向哪一项的原因 */
export function checkSubmit(s: ComposerState): SubmitCheck {
  if (s.phase === "submitting")
    return { ok: false, reason: "正在发送…", silent: true };
  const uploading = s.images.find((i) => i.status === "uploading");
  if (uploading)
    return {
      ok: false,
      reason: `「${uploading.name}」还在上传，完成后才能发送`,
    };
  const failed = s.images.find((i) => i.status === "failed");
  if (failed)
    return {
      ok: false,
      reason: `「${failed.name}」${failed.kind === "upload" ? "上传失败" : "引用失败"}，请重试或删除后再发送`,
    };
  const freezing = s.images.find((i) => i.status === "freezing");
  if (freezing)
    return { ok: false, reason: `正在固定「${freezing.name}」的引用版本…` };
  if (!s.text.trim())
    return { ok: false, reason: "先写下你的需求", silent: true };
  if (s.images.length > MAX_REFERENCES)
    return { ok: false, reason: `参考图最多 ${MAX_REFERENCES} 张` };
  return { ok: true };
}

/**
 * 序列化为接口载荷。所有图片（上传附件与画布引用）都先冻结成快照，统一作为 references 提交：
 * 后端的 image part 不带用途，只有 reference 有 purpose/order。order 是在统一列表里的位置。
 * meta 是只存在本机的回显信息（后端不返回参考图和设置）。
 */
export function buildPayload(
  s: ComposerState,
  viewportCenter?: { x: number; y: number },
): { request: Omit<MessageRequest, "clientMessageId">; meta: MessageMeta } {
  const references: NonNullable<MessageRequest["references"]> = [];
  const metaRefs: MessageMeta["references"] = [];
  s.images.forEach((img, order) => {
    if (!img.snapshot) return;
    references.push({
      snapshotId: img.snapshot.id,
      purpose: img.purpose,
      order,
    });
    metaRefs.push({
      snapshotId: img.snapshot.id,
      assetId: img.snapshot.assetId,
      purpose: img.purpose,
      order,
      width: img.snapshot.width,
      height: img.snapshot.height,
      ...(img.elementId ? { elementId: img.elementId } : {}),
      ...(img.kind === "canvas" ? { previewUrl: img.previewUrl } : {}),
    });
  });
  const source = metaRefs.find((r) => r.elementId);
  return {
    request: {
      parts: [{ type: "text", text: s.text.trim() }],
      references,
      settings: { ...s.settings },
      settingsExplicitKeys: [...s.explicit],
      ...(viewportCenter ? { viewportCenter } : {}),
    },
    meta: {
      attachments: [],
      references: metaRefs,
      settings: { ...s.settings },
      explicit: [...s.explicit],
      ...(viewportCenter ? { viewportCenter } : {}),
      ...(source?.elementId ? { sourceElementId: source.elementId } : {}),
    },
  };
}

export function settingsSummary(
  st: GenSettings,
  modelLabelOf: (id: string) => string,
  compact = false,
): string {
  const q = st.quality === "high" ? "2K" : "1K";
  // 紧凑形态（右栏输入框）：比例是“自动”时省略，保证一行放得下
  if (compact)
    return [
      `${st.count} 张`,
      st.aspectRatio === "auto" ? null : st.aspectRatio,
      q,
      modelLabelOf(st.modelId),
    ]
      .filter(Boolean)
      .join(" · ");
  const ratio = st.aspectRatio === "auto" ? "自动比例" : st.aspectRatio;
  return `${st.count} 张 · ${ratio} · ${q} · ${modelLabelOf(st.modelId)}`;
}
