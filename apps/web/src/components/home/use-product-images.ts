"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { MAX_UPLOAD_BYTES, UPLOAD_MIMES, getApi } from "../../lib/api";
import { errorMessage, newId } from "../../lib/utils";

export const MAX_PRODUCT_IMAGES = 3;

export interface ProductImage {
  id: string;
  name: string;
  previewUrl: string;
  status: "uploading" | "ready" | "failed";
  assetId?: string;
  error?: string;
}

/**
 * 首页商品图：拖入 / 粘贴 / 选择，1–3 张，加入后立即上传（生成时直接用 assetId）。
 * 失败可重试，删除会中止进行中的上传并释放预览地址。
 */
export function useProductImages(notice: (m: string) => void) {
  const [images, setImages] = useState<ProductImage[]>([]);
  const ref = useRef<ProductImage[]>([]);
  ref.current = images;
  const files = useRef(new Map<string, File>());
  const ctls = useRef(new Map<string, AbortController>());
  const noticeRef = useRef(notice);
  noticeRef.current = notice;

  const patch = useCallback((id: string, p: Partial<ProductImage>) => {
    setImages((l) => l.map((i) => (i.id === id ? { ...i, ...p } : i)));
  }, []);

  const upload = useCallback(
    async (id: string) => {
      const file = files.current.get(id);
      if (!file) return;
      const ctl = new AbortController();
      ctls.current.set(id, ctl);
      patch(id, { status: "uploading" });
      try {
        const asset = await getApi().uploadAsset(file, { signal: ctl.signal });
        patch(id, { status: "ready", assetId: asset.id });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        console.warn("[home] 商品图上传失败", file.name, e);
        patch(id, { status: "failed", error: errorMessage(e, "上传失败") });
      } finally {
        ctls.current.delete(id);
      }
    },
    [patch],
  );

  const add = useCallback(
    (incoming: File[]) => {
      const room = MAX_PRODUCT_IMAGES - ref.current.length;
      const accepted: ProductImage[] = [];
      let skipped = 0;
      for (const f of incoming) {
        if (!(UPLOAD_MIMES as readonly string[]).includes(f.type)) {
          noticeRef.current(`「${f.name}」不是 PNG / JPEG / WebP 图片`);
          continue;
        }
        if (accepted.length >= room) {
          skipped++;
          continue;
        }
        const id = newId();
        files.current.set(id, f);
        const tooBig = f.size > MAX_UPLOAD_BYTES;
        accepted.push({
          id,
          name: f.name || "粘贴的图片",
          previewUrl: URL.createObjectURL(f),
          status: tooBig ? "failed" : "uploading",
          ...(tooBig ? { error: "图片超过 20MB，请压缩后再试" } : {}),
        });
      }
      if (skipped)
        noticeRef.current(
          `商品图最多 ${MAX_PRODUCT_IMAGES} 张，多余的 ${skipped} 张没有加入`,
        );
      if (!accepted.length) return;
      setImages((l) => [...l, ...accepted]);
      for (const a of accepted) if (a.status === "uploading") void upload(a.id);
    },
    [upload],
  );

  const remove = useCallback((id: string) => {
    ctls.current.get(id)?.abort();
    ctls.current.delete(id);
    files.current.delete(id);
    const img = ref.current.find((i) => i.id === id);
    if (img) URL.revokeObjectURL(img.previewUrl);
    setImages((l) => l.filter((i) => i.id !== id));
  }, []);

  const clear = useCallback(() => {
    for (const i of ref.current) URL.revokeObjectURL(i.previewUrl);
    for (const c of ctls.current.values()) c.abort();
    files.current.clear();
    ctls.current.clear();
    setImages([]);
  }, []);

  // 页面级粘贴：剪贴板里有图片就加入（纯文字粘贴不受影响）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const fs = Array.from(e.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (!fs.length) return;
      e.preventDefault();
      add(fs);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [add]);

  // 卸载时中止上传
  useEffect(
    () => () => {
      for (const c of ctls.current.values()) c.abort();
    },
    [],
  );

  return {
    images,
    add,
    remove,
    clear,
    retry: (id: string) => void upload(id),
    full: images.length >= MAX_PRODUCT_IMAGES,
    uploading: images.some((i) => i.status === "uploading"),
    failed: images.some((i) => i.status === "failed"),
    assetIds: images.flatMap((i) => (i.assetId ? [i.assetId] : [])),
  };
}
