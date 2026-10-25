"use client";

import type { EdgeEvent } from "@loomic/shared/edge";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type ConnectionState, getApi } from "../../lib/api";
import { type SetDetail, type SetTemplate, shotBusy } from "../../lib/sets/types";
import { errorMessage } from "../../lib/utils";

export { shotBusy };

export type SetEvent = Extract<EdgeEvent, { type: "set.state" | "set.analyzed" | "set.shot" }>;
export const isSetEvent = (ev: EdgeEvent): ev is SetEvent =>
  ev.type === "set.state" || ev.type === "set.analyzed" || ev.type === "set.shot";

/** 项目事件流（useWorkspace 提供）：套图相关事件和连接状态 */
export interface SetFeed {
  subscribeSet(listener: (ev: SetEvent) => void): () => void;
  conn: ConnectionState;
}

let templatesPromise: Promise<SetTemplate[]> | undefined;
const loadTemplates = () => {
  templatesPromise ??= getApi().listTemplates();
  templatesPromise.catch(() => {
    templatesPromise = undefined;
  });
  return templatesPromise;
};

/** 把一个事件合进当前视图；不属于这套图的事件忽略 */
export function applySetEvent(d: SetDetail, ev: SetEvent): SetDetail {
  if (ev.payload.setId !== d.setId) return d;
  switch (ev.type) {
    case "set.state": {
      const { error, state } = ev.payload;
      return { ...d, state, ...(error ? { error: { ...error } } : { error: undefined }) };
    }
    case "set.analyzed":
      return { ...d, analysis: ev.payload.analysis };
    case "set.shot": {
      const { setId: _drop, ...shot } = ev.payload;
      const has = d.shots.some((s) => s.shotId === shot.shotId);
      return {
        ...d,
        shots: has
          ? d.shots.map((s) => (s.shotId === shot.shotId ? shot : s))
          : [...d.shots, shot],
      };
    }
  }
}

/**
 * 套图会话：首次读取 GET /api/sets/:id，之后只靠项目事件流（set.state / set.analyzed / set.shot）更新，不轮询。
 * 事件流断线重连成功后补读一次；读取期间收到事件会在读完后再补读一次，避免用旧快照盖掉新状态。
 * `reload` 给「重出 / 改卖点」之后兜底用（事件流正常时通常用不上）。
 */
export function useSetSession(setId: string | null, feed: SetFeed) {
  const [detail, setDetail] = useState<SetDetail | null>(null);
  const [template, setTemplate] = useState<SetTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const inflight = useRef(false);
  const dirty = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const failures = useRef(0);

  const load = useCallback(async () => {
    if (!setId) return;
    if (inflight.current) {
      dirty.current = true;
      return;
    }
    inflight.current = true;
    dirty.current = false;
    clearTimeout(retryTimer.current);
    try {
      const d = await getApi().getSet(setId);
      if (!alive.current) return;
      failures.current = 0;
      setDetail(d);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      failures.current += 1;
      console.warn("[set] 读取套图失败", setId, e);
      setError(errorMessage(e, "读取套图失败"));
      // 接口未就绪或网络抖动：退避重试（4s、8s…最多 30s），事件流到达时也会触发重读
      retryTimer.current = setTimeout(
        () => void load(),
        Math.min(30000, 4000 * 2 ** Math.min(failures.current - 1, 3)),
      );
    } finally {
      inflight.current = false;
      if (dirty.current && alive.current) void load();
    }
  }, [setId]);

  useEffect(() => {
    alive.current = true;
    setDetail(null);
    setError(null);
    void load();
    return () => {
      alive.current = false;
      clearTimeout(retryTimer.current);
    };
  }, [load]);

  // 事件流：直接合进视图；读取进行中收到的事件，读完后再补读一次
  const { subscribeSet } = feed;
  useEffect(() => {
    if (!setId) return;
    return subscribeSet((ev) => {
      if (ev.payload.setId !== setId) return;
      if (inflight.current) dirty.current = true;
      setDetail((d) => (d ? applySetEvent(d, ev) : d));
    });
  }, [setId, subscribeSet]);

  // 断线重连成功后补读一次
  const prevConn = useRef<ConnectionState>(feed.conn);
  useEffect(() => {
    const was = prevConn.current;
    prevConn.current = feed.conn;
    if (feed.conn === "open" && was === "reconnecting") {
      console.info("[set] 事件流重连，补读套图", setId);
      void load();
    }
  }, [feed.conn, load, setId]);

  const templateId = detail?.templateId;
  useEffect(() => {
    if (!templateId) return;
    let off = false;
    loadTemplates()
      .then((l) => {
        if (!off) setTemplate(l.find((t) => t.id === templateId) ?? null);
      })
      .catch((e) => console.warn("[set] 读取模板失败", e));
    return () => {
      off = true;
    };
  }, [templateId]);

  const busyCount = useMemo(
    () => detail?.shots.filter(shotBusy).length ?? 0,
    [detail],
  );
  return { detail, template, error, reload: load, busyCount };
}
