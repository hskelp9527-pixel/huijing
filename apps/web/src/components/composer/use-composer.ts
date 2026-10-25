"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import {
  ApiError,
  MAX_REFERENCES,
  MAX_UPLOAD_BYTES,
  UPLOAD_MIMES,
  getApi,
} from "../../lib/api";
import type { GenSettings, SettingsKey } from "../../lib/api";
import {
  errorMessage,
  newId,
  readJson,
  removeKey,
  writeJson,
} from "../../lib/utils";
import {
  type ComposerImage,
  type ComposerState,
  buildPayload,
  checkSubmit,
  composerReducer,
  emptyComposer,
} from "./composer-model";

export interface CanvasRefInput {
  elementId?: string;
  name: string;
  previewUrl: string;
  width: number;
  height: number;
  appearanceKey?: string;
  /** 取得（必要时先上传）源图 Asset ID */
  resolveSourceAssetId: () => Promise<string>;
}

interface Draft {
  text: string;
  settings: Required<GenSettings>;
  explicit: SettingsKey[];
  submissionId?: string | undefined;
}

export type ComposerController = ReturnType<typeof useComposer>;

/**
 * 管理一份 Composer 状态：文字、图片（上传/引用）、设置，附件上传与引用冻结，草稿持久化。
 * draftKey 相同则文字和设置在刷新后恢复（图片附件不持久化）。
 */
export function useComposer(
  draftKey: string | null,
  onNotice?: (msg: string) => void,
) {
  const [state, dispatch] = useReducer(
    composerReducer,
    undefined,
    emptyComposer,
  );
  const uploads = useRef(new Map<string, AbortController>());
  const filesRef = useRef(new Map<string, File>());
  const freezeInputs = useRef(new Map<string, CanvasRefInput>());
  const stateRef = useRef(state);
  stateRef.current = state;
  const notice = useRef(onNotice);
  notice.current = onNotice;

  // 恢复草稿
  useEffect(() => {
    if (!draftKey) return;
    const d = readJson<Draft>(draftKey);
    if (d && (d.text || d.explicit?.length)) {
      dispatch({
        type: "restore",
        text: d.text,
        settings: d.settings,
        explicit: d.explicit,
        ...(d.submissionId ? { submissionId: d.submissionId } : {}),
      });
    }
  }, [draftKey]);

  // 保存草稿（防抖）
  useEffect(() => {
    if (!draftKey) return;
    const t = setTimeout(() => {
      if (!state.text && state.explicit.length === 0) removeKey(draftKey);
      else
        writeJson(draftKey, {
          text: state.text,
          settings: state.settings,
          explicit: state.explicit,
          submissionId: state.submissionId,
        } satisfies Draft);
    }, 400);
    return () => clearTimeout(t);
  }, [
    draftKey,
    state.text,
    state.settings,
    state.explicit,
    state.submissionId,
  ]);

  useEffect(
    () => () => {
      for (const c of uploads.current.values()) c.abort();
    },
    [],
  );

  const startUpload = useCallback(async (id: string, file: File) => {
    const ctl = new AbortController();
    uploads.current.set(id, ctl);
    dispatch({ type: "patch", id, patch: { status: "uploading" } });
    try {
      const api = getApi();
      const asset = await api.uploadAsset(file, { signal: ctl.signal });
      // 上传的图片也冻结成快照，才能带用途/排序作为 reference 提交
      const snapshot = await api.createSnapshot(
        {
          sourceAssetId: asset.id,
          appearance: {},
          renderKey: `upload:${asset.id}`,
        },
        undefined,
        { signal: ctl.signal },
      );
      dispatch({
        type: "patch",
        id,
        patch: {
          status: "ready",
          asset,
          snapshot,
          width: asset.width,
          height: asset.height,
        },
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      dispatch({
        type: "patch",
        id,
        patch: { status: "failed", error: errorMessage(e, "上传失败") },
      });
    } finally {
      uploads.current.delete(id);
    }
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      const room = MAX_REFERENCES - stateRef.current.images.length;
      const accepted: ComposerImage[] = [];
      let skipped = 0;
      for (const file of files) {
        if (!(UPLOAD_MIMES as readonly string[]).includes(file.type)) {
          notice.current?.(`「${file.name}」不是 PNG / JPEG / WebP 图片`);
          continue;
        }
        if (accepted.length >= room) {
          skipped++;
          continue;
        }
        const id = newId();
        const tooBig = file.size > MAX_UPLOAD_BYTES;
        filesRef.current.set(id, file);
        accepted.push({
          id,
          kind: "upload",
          name: file.name || "粘贴的图片",
          previewUrl: URL.createObjectURL(file),
          status: tooBig ? "failed" : "uploading",
          ...(tooBig ? { error: "图片超过 20MB，请压缩后再试" } : {}),
          purpose: "general",
        });
      }
      if (skipped)
        notice.current?.(
          `参考图最多 ${MAX_REFERENCES} 张，多余的 ${skipped} 张没有加入`,
        );
      if (!accepted.length) return;
      dispatch({ type: "add", images: accepted });
      for (const img of accepted) {
        const file = filesRef.current.get(img.id);
        if (img.status === "uploading" && file) void startUpload(img.id, file);
      }
    },
    [startUpload],
  );

  const retryUpload = useCallback(
    (id: string) => {
      const file = filesRef.current.get(id);
      const img = stateRef.current.images.find((i) => i.id === id);
      if (!file || !img) return;
      if (file.size > MAX_UPLOAD_BYTES) return;
      void startUpload(id, file);
    },
    [startUpload],
  );

  const removeImage = useCallback((id: string) => {
    uploads.current.get(id)?.abort();
    uploads.current.delete(id);
    const img = stateRef.current.images.find((i) => i.id === id);
    if (img?.kind === "upload") URL.revokeObjectURL(img.previewUrl);
    filesRef.current.delete(id);
    dispatch({ type: "remove", id });
  }, []);

  /** 冻结一个画布引用：此刻的外观快照。选择不等于引用，只有调用它才会加入。 */
  const freeze = useCallback(async (id: string, input: CanvasRefInput) => {
    freezeInputs.current.set(id, input);
    try {
      const sourceAssetId = await input.resolveSourceAssetId();
      const snapshot = await getApi().createSnapshot({
        sourceAssetId,
        appearance: {},
        renderKey: `${sourceAssetId}:${input.appearanceKey ?? "base"}`,
      });
      dispatch({
        type: "patch",
        id,
        patch: {
          status: "ready",
          snapshot,
          previewUrl: input.previewUrl,
          width: snapshot.width,
          height: snapshot.height,
          ...(input.appearanceKey
            ? { appearanceKey: input.appearanceKey }
            : {}),
        },
      });
    } catch (e) {
      dispatch({
        type: "patch",
        id,
        patch: { status: "failed", error: errorMessage(e, "固定引用版本失败") },
      });
    }
  }, []);

  const addCanvasReference = useCallback(
    (input: CanvasRefInput, purpose: ComposerImage["purpose"] = "general") => {
      const cur = stateRef.current.images;
      if (input.elementId && cur.some((i) => i.elementId === input.elementId)) {
        notice.current?.("这张图已经在引用里了");
        return;
      }
      if (cur.length >= MAX_REFERENCES) {
        notice.current?.(`参考图最多 ${MAX_REFERENCES} 张`);
        return;
      }
      const id = newId();
      dispatch({
        type: "add",
        images: [
          {
            id,
            kind: "canvas",
            name: input.name,
            previewUrl: input.previewUrl,
            width: input.width,
            height: input.height,
            status: "freezing",
            purpose,
            ...(input.elementId ? { elementId: input.elementId } : {}),
            ...(input.appearanceKey
              ? { appearanceKey: input.appearanceKey }
              : {}),
          },
        ],
      });
      void freeze(id, input);
    },
    [freeze],
  );

  /** 把已有引用更新到画布对象的当前版本 */
  const updateReference = useCallback(
    (id: string, input: CanvasRefInput) => {
      dispatch({
        type: "patch",
        id,
        patch: {
          status: "freezing",
          previewUrl: input.previewUrl,
          ...(input.appearanceKey
            ? { appearanceKey: input.appearanceKey }
            : {}),
        },
      });
      void freeze(id, input);
    },
    [freeze],
  );

  const retryFreeze = useCallback(
    (id: string) => {
      const input = freezeInputs.current.get(id);
      if (!input) return;
      dispatch({ type: "patch", id, patch: { status: "freezing" } });
      void freeze(id, input);
    },
    [freeze],
  );

  const actions = useMemo(
    () => ({
      setText: (text: string) => dispatch({ type: "text", text }),
      setSetting: <K extends SettingsKey>(key: K, value: GenSettings[K]) =>
        dispatch({ type: "setting", key, value }),
      setPurpose: (id: string, purpose: ComposerImage["purpose"]) =>
        dispatch({ type: "patch", id, patch: { purpose } }),
      move: (id: string, dir: -1 | 1) => dispatch({ type: "move", id, dir }),
      keepOldReference: (id: string, key: string) =>
        dispatch({ type: "patch", id, patch: { ackKey: key } }),
      removeImage,
      addFiles,
      retryUpload,
      addCanvasReference,
      updateReference,
      retryFreeze,
      /** 锁定本次提交：返回载荷快照，期间输入框只读 */
      beginSubmit(viewportCenter?: { x: number; y: number }) {
        const cur = stateRef.current;
        const submissionId = cur.submissionId ?? newId();
        dispatch({ type: "phase", phase: "submitting", submissionId });
        return { payload: buildPayload(cur, viewportCenter), submissionId };
      },
      /** 提交失败或用户取消本地等待：保留内容，沿用 submissionId */
      endSubmit: () => dispatch({ type: "phase", phase: "editing" }),
      /** 提交已确认：清空 */
      clear() {
        for (const i of stateRef.current.images)
          if (i.kind === "upload") URL.revokeObjectURL(i.previewUrl);
        filesRef.current.clear();
        dispatch({ type: "reset" });
        if (draftKey) removeKey(draftKey);
      },
    }),
    [
      removeImage,
      addFiles,
      retryUpload,
      addCanvasReference,
      updateReference,
      retryFreeze,
      draftKey,
    ],
  );

  const check = checkSubmit(state);
  return { state: state as ComposerState, actions, check };
}

export { ApiError };
