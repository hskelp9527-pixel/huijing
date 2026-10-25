"use client";

import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { type Me, type Quota, getApi } from "./api";

/**
 * 匿名访客会话：没有登录。后端首次请求自动下发匿名 cookie，GET /api/me 返回访客身份和今日额度。
 * 这里只负责读取一次、提供额度，并在任何生成/重出之后由调用方 setQuota 同步。
 */
type Status = "loading" | "ready" | "error";
interface SessionApi {
  status: Status;
  me: Me | null;
  quota: Quota | null;
  /** 今日还能生成几张；额度未读到时为 null */
  remaining: number | null;
  /** 今日还可生成几套（/api/me 的 quota.setsRemaining）；后端未就绪或未读到时为 null，界面退回按张数展示 */
  setsRemaining: number | null;
  setQuota(q: Quota): void;
  /** 重新读取 /api/me（例如额度被其他窗口消耗后） */
  refresh(): Promise<void>;
  retry(): void;
}
const Ctx = createContext<SessionApi | null>(null);
export function useSession(): SessionApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession 需要 SessionProvider");
  return v;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [nonce, setNonce] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce 是有意的重新读取触发条件
  useEffect(() => {
    const ctl = new AbortController();
    setStatus("loading");
    getApi()
      .getSession({ signal: ctl.signal })
      .then((m) => {
        setMe(m);
        setQuota(m?.quota ?? null);
        setStatus(m ? "ready" : "error");
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setStatus("error");
      });
    return () => ctl.abort();
  }, [nonce]);

  const value = useMemo<SessionApi>(
    () => ({
      status,
      me,
      quota,
      remaining: quota ? quota.remaining : null,
      setsRemaining: quota?.setsRemaining ?? null,
      setQuota,
      async refresh() {
        const m = await getApi().getSession();
        if (m) {
          setMe(m);
          setQuota(m.quota);
        }
      },
      retry: () => setNonce((n) => n + 1),
    }),
    [status, me, quota],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 会话读取失败时显示重试；读取中显示加载。没有登录跳转：访客身份由后端自动建立。 */
export function SessionGate({ children }: { children: ReactNode }) {
  const { status, retry } = useSession();
  if (status === "error")
    return (
      <div className="empty-state" style={{ minHeight: "60vh" }}>
        <h3>暂时连不上服务</h3>
        <p>网络似乎不太稳定。</p>
        <button type="button" className="btn btn-primary" onClick={retry}>
          重试
        </button>
      </div>
    );
  if (status !== "ready")
    return (
      <output
        style={{ display: "grid", placeItems: "center", minHeight: "60vh" }}
        aria-label="加载中"
      >
        <div className="spinner spinner-lg" />
      </output>
    );
  return <>{children}</>;
}
