const dataUrlCache = new Map<string, Promise<string>>();

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("读取图片失败"));
    r.readAsDataURL(blob);
  });
}

/** 把图片地址（同源 /api/assets/:id 或 data URL）转成 data URL，供 Excalidraw 的 BinaryFiles 使用 */
export function toDataUrl(url: string): Promise<string> {
  if (url.startsWith("data:")) return Promise.resolve(url);
  let p = dataUrlCache.get(url);
  if (!p) {
    p = fetch(url, { credentials: "same-origin" }).then(async (res) => {
      if (!res.ok) throw new Error(`图片加载失败（${res.status}）`);
      return blobToDataUrl(await res.blob());
    });
    p.catch(() => dataUrlCache.delete(url));
    dataUrlCache.set(url, p);
  }
  return p;
}

export async function dataUrlToFile(
  dataUrl: string,
  name: string,
): Promise<File> {
  const blob = await (await fetch(dataUrl)).blob();
  return new File([blob], name, { type: blob.type });
}

/** 生成小预览（引用胶囊、消息里的冻结预览用），避免把大图塞进状态和草稿 */
export function makeThumb(dataUrl: string, maxEdge = 320): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || maxEdge;
      const h = img.naturalHeight || maxEdge;
      const k = Math.min(1, maxEdge / Math.max(w, h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * k));
      canvas.height = Math.max(1, Math.round(h * k));
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(dataUrl);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
