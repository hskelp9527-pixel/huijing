"use client";

import {
  AlertTriangle,
  FilePlus2,
  ImagePlus,
  RotateCw,
  Sparkles,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  ApiError,
  type ProjectSummary,
  getApi,
} from "../../lib/api";
import { templateCoverSvg } from "../../lib/sets/templates";
import type { SetTemplate } from "../../lib/sets/types";
import { SessionGate, useSession } from "../../lib/session";
import {
  cx,
  errorMessage,
  readJson,
  relativeTime,
  writeJson,
} from "../../lib/utils";
import { QuotaPill, ThemeToggle } from "../ui/app-chrome";
import { BrandMark, PRODUCT_NAME } from "../ui/brand";
import { useToast } from "../ui/toast";
import { MAX_PRODUCT_IMAGES, useProductImages } from "./use-product-images";

export function HomeView() {
  return (
    <SessionGate>
      <HomeInner />
    </SessionGate>
  );
}

const LANG_LABEL = { zh: "中文", en: "英文", auto: "跟随输入" } as const;
const DRAFT_KEY = "draft:home:v2";

function HomeInner() {
  const router = useRouter();
  const toast = useToast();
  const { remaining, setsRemaining, refresh } = useSession();
  const pics = useProductImages((m) => toast.show(m));
  const [templates, setTemplates] = useState<SetTemplate[] | null>(null);
  const [tplError, setTplError] = useState<string | null>(null);
  const [tplNonce, setTplNonce] = useState(0);
  const [templateId, setTemplateId] = useState<string | null>(
    () => readJson<{ templateId: string | null }>(DRAFT_KEY)?.templateId ?? null,
  );
  const [note, setNote] = useState(
    () => readJson<{ note: string }>(DRAFT_KEY)?.note ?? "",
  );
  const [drag, setDrag] = useState(false);
  const [creating, setCreating] = useState(false);
  const [submitError, setSubmitError] = useState<{
    message: string;
    quota: boolean;
  } | null>(null);
  const inflight = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    writeJson(DRAFT_KEY, { templateId, note });
  }, [templateId, note]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tplNonce 是有意的重新读取触发条件
  useEffect(() => {
    const ctl = new AbortController();
    setTplError(null);
    getApi()
      .listTemplates({ signal: ctl.signal })
      .then((l) => {
        setTemplates(l);
        // 草稿里的模板已被下线：清掉选择
        setTemplateId((cur) => (cur && l.some((t) => t.id === cur) ? cur : null));
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setTplError(errorMessage(e, "读取模板失败"));
      });
    return () => ctl.abort();
  }, [tplNonce]);

  const tpl = useMemo(
    () => templates?.find((t) => t.id === templateId) ?? null,
    [templates, templateId],
  );
  const need = tpl?.shots.length ?? 0;
  const noSets = setsRemaining === 0;
  const noQuota = noSets || (remaining !== null && need > 0 && need > remaining);

  // 不可点击的原因（给按钮下方的提示）
  const blocked: string | null =
    pics.images.length === 0
      ? "先上传至少一张商品图"
      : pics.uploading
        ? "商品图还在上传…"
        : pics.failed
          ? "有图片上传失败，重试或删除后再生成"
          : !tpl
            ? "再选一个模板"
            : noQuota
              ? noSets
                ? "今天的套数已经用完，北京时间零点重置后再来"
                : remaining === 0
                  ? "今天的额度已经用完，北京时间零点重置后再来"
                  : `今天还能生成 ${remaining} 张，这套需要 ${need} 张，换一个张数更少的模板`
              : null;

  const submit = useCallback(async () => {
    if (inflight.current || blocked || !tpl) return;
    inflight.current = true;
    setCreating(true);
    setSubmitError(null);
    try {
      const res = await getApi().createSet({
        sourceAssetIds: pics.assetIds,
        templateId: tpl.id,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      void refresh();
      pics.clear();
      router.push(
        `/p?id=${encodeURIComponent(res.projectId)}&thread=${encodeURIComponent(res.threadId)}&set=${encodeURIComponent(res.setId)}`,
      );
    } catch (e) {
      console.warn("[home] 创建套图失败", e);
      setCreating(false);
      inflight.current = false;
      const quota = e instanceof ApiError && e.code === "QUOTA_EXCEEDED";
      if (quota) void refresh();
      setSubmitError({ message: errorMessage(e, "创建失败"), quota });
    }
  }, [blocked, tpl, pics, note, router, refresh]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    pics.add(
      Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/")),
    );
  };

  return (
    <div className="home">
      <header className="home-top">
        <span className="brand">
          <BrandMark /> {PRODUCT_NAME}
        </span>
        <nav className="home-nav" aria-label="全局">
          <QuotaPill />
          <ThemeToggle />
        </nav>
      </header>

      <main id="main" className="home-main">
        <section className="make" aria-labelledby="make-title">
          <div className="make-head">
            <h1 id="make-title">一张商品图，出一整套电商图</h1>
            <p>
              上传商品图，选一个模板，一键生成。标题和卖点是画布上可编辑的文字，改错字不用重出图。
            </p>
          </div>

          <div className="make-step">
            <h2>
              <span className="step-no">1</span> 商品图
              <small>
                {pics.images.length}/{MAX_PRODUCT_IMAGES}，拖入、粘贴或点击选择
              </small>
            </h2>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: 拖放区的键盘入口是里面的按钮 */}
            <div
              className={cx("drop", drag && "is-drag", pics.images.length > 0 && "has-items")}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                  setDrag(false);
              }}
              onDrop={onDrop}
            >
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={(e) => {
                  pics.add(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              {pics.images.length === 0 ? (
                <button
                  type="button"
                  className="drop-empty"
                  onClick={() => fileInput.current?.click()}
                >
                  <ImagePlus size={28} aria-hidden />
                  <b>把商品图拖到这里</b>
                  <span>也可以直接粘贴（Ctrl/⌘ + V），或点击选择文件</span>
                  <small>PNG / JPEG / WebP，单张不超过 20MB，最多 {MAX_PRODUCT_IMAGES} 张</small>
                </button>
              ) : (
                <ul className="thumbs" aria-label="已上传的商品图">
                  {pics.images.map((img) => (
                    <li key={img.id} className={cx("thumb", img.status === "failed" && "is-failed")}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.previewUrl} alt={img.name} />
                      {img.status === "uploading" && (
                        <span className="thumb-state">
                          <span className="spinner" aria-hidden /> 上传中
                        </span>
                      )}
                      {img.status === "failed" && (
                        <span className="thumb-state thumb-err" title={img.error}>
                          <AlertTriangle size={13} aria-hidden /> 失败
                          {!img.error?.includes("20MB") && (
                            <button type="button" onClick={() => pics.retry(img.id)}>
                              重试
                            </button>
                          )}
                        </span>
                      )}
                      <button
                        type="button"
                        className="thumb-x"
                        aria-label={`删除 ${img.name}`}
                        onClick={() => pics.remove(img.id)}
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                  {!pics.full && (
                    <li>
                      <button
                        type="button"
                        className="thumb thumb-add"
                        onClick={() => fileInput.current?.click()}
                      >
                        <ImagePlus size={20} aria-hidden />
                        <span>添加</span>
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>
          </div>

          <div className="make-step">
            <h2>
              <span className="step-no">2</span> 模板
              <small>每张图单独出，按张数计额度</small>
            </h2>
            {tplError ? (
              <div className="notice notice-error" role="alert">
                <span>{tplError}</span>
                <button type="button" className="btn btn-sm" onClick={() => setTplNonce((n) => n + 1)}>
                  重试
                </button>
              </div>
            ) : templates === null ? (
              <div className="tpl-grid" aria-busy="true">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="skeleton" style={{ height: 210, borderRadius: 14 }} />
                ))}
              </div>
            ) : (
              <div className="tpl-grid" role="radiogroup" aria-label="选择模板">
                {templates.map((t) => {
                  const selected = t.id === templateId;
                  const over = noSets || (remaining !== null && t.shots.length > remaining);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={cx("tpl", selected && "is-selected", over && "is-over")}
                      onClick={() => setTemplateId(t.id)}
                    >
                      <span className="tpl-cover">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={t.coverUrl ?? templateCoverSvg(t)} alt="" />
                      </span>
                      <span className="tpl-name">{t.name}</span>
                      <span className="tpl-meta">
                        <b>{t.shots.length} 张</b>
                        <i>{LANG_LABEL[t.lang]}</i>
                        {over && <em>额度不够</em>}
                      </span>
                      <span className="tpl-desc">{t.description}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="make-step">
            <h2>
              <span className="step-no">3</span> 补充一句
              <small>可选，不填也能出</small>
            </h2>
            <input
              className="input make-note"
              value={note}
              maxLength={120}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) void submit();
              }}
              placeholder="可选：补充卖点或人群，比如 主打防水，给户外徒步"
              aria-label="补充卖点或人群（可选）"
            />
          </div>

          <div className="make-go">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              disabled={!!blocked || creating}
              onClick={() => void submit()}
              aria-describedby="make-hint"
            >
              {creating ? <span className="spinner" aria-hidden /> : <Sparkles size={17} aria-hidden />}
              {creating ? "正在创建…" : "一键生成"}
            </button>
            <p id="make-hint" className={cx("make-hint", noQuota && "is-warn")}>
              {blocked ??
                `将生成 ${need} 张${
                  setsRemaining !== null
                    ? `，占 1 套（今日还可生成 ${setsRemaining} 套）`
                    : remaining !== null
                      ? `，消耗 ${need} 张额度（今日还可生成 ${remaining} 张）`
                      : ""
                }`}
            </p>
          </div>
          {submitError && (
            <div className="notice notice-error" role="alert">
              <span>
                {submitError.message}
                {submitError.quota ? "" : "。选择的图片和模板还在，可以直接重试。"}
              </span>
              {!submitError.quota && (
                <button type="button" className="btn btn-sm" onClick={() => void submit()}>
                  <RotateCw size={13} /> 重试
                </button>
              )}
            </div>
          )}
        </section>

        <RecentProjects />
      </main>
    </div>
  );
}

function RecentProjects() {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [creating, setCreating] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce 是有意的重新读取触发条件
  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    setItems(null);
    getApi()
      .listProjects({ signal: ctl.signal })
      .then(setItems)
      .catch((e) => {
        if (e?.name !== "AbortError") setError(errorMessage(e, "读取最近项目失败"));
      });
    return () => ctl.abort();
  }, [nonce]);

  const createBlank = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const p = await getApi().createProject();
      router.push(`/p?id=${encodeURIComponent(p.id)}`);
    } catch (e) {
      toast.show(errorMessage(e, "创建失败"), { tone: "error" });
      setCreating(false);
    }
  };

  return (
    <section className="recent" aria-labelledby="recent-title">
      <div className="recent-head">
        <h2 id="recent-title">最近项目</h2>
        <button type="button" className="btn btn-sm btn-ghost" onClick={createBlank} disabled={creating}>
          {creating ? <span className="spinner" aria-hidden /> : <FilePlus2 size={15} />} 新建空白项目
        </button>
      </div>
      {error ? (
        <div className="notice notice-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => setNonce((n) => n + 1)}>
            重试
          </button>
        </div>
      ) : items === null ? (
        <ul className="recent-grid" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="project-card">
              <div className="skeleton" style={{ aspectRatio: "4/3" }} />
              <div className="skeleton" style={{ height: 14, width: "60%", marginTop: 10 }} />
            </li>
          ))}
        </ul>
      ) : items.length === 0 ? (
        <div className="empty-state recent-empty">
          <h3>还没有项目</h3>
          <p>在上面传一张商品图，选个模板，第一套图就会出现在这里。</p>
        </div>
      ) : (
        <ul className="recent-grid">
          {items.slice(0, 8).map((p) => {
            const setId = p.setId;
            return (
              <li key={p.id}>
                <Link
                  className="project-card"
                  href={`/p?id=${encodeURIComponent(p.id)}${p.lastThreadId ? `&thread=${encodeURIComponent(p.lastThreadId)}` : ""}${setId ? `&set=${encodeURIComponent(setId)}` : ""}`}
                >
                  <div className="project-cover">
                    {p.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.coverUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="project-cover-empty">空白画布</span>
                    )}
                  </div>
                  <div className="project-meta">
                    <b title={p.title}>{p.title}</b>
                    <small>{relativeTime(p.updatedAt)}</small>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
