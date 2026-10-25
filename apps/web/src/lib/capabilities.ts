"use client";

import { useEffect, useState } from "react";

import { type CapabilitiesResponse, getApi } from "./api";

// 同一页面内多个组件共用一次请求；60 秒后再次打开设置面板会重新读取，服务端调整模型档位后不用刷新整页
const TTL_MS = 60_000;
let cached: { at: number; promise: Promise<CapabilitiesResponse> } | undefined;

function fetchCapabilities(): Promise<CapabilitiesResponse> {
  if (!cached || Date.now() - cached.at > TTL_MS) {
    const promise = getApi().getCapabilities();
    cached = { at: Date.now(), promise };
    promise.catch(() => {
      if (cached?.promise === promise) cached = undefined;
    });
  }
  return cached.promise;
}

/** 服务端能力（可选模型、模式）。读取失败时返回 null，界面显示“正在读取”，不使用写死的默认档位。 */
export function useCapabilities(): CapabilitiesResponse | null {
  const [caps, setCaps] = useState<CapabilitiesResponse | null>(null);
  useEffect(() => {
    let alive = true;
    fetchCapabilities().then(
      (c) => alive && setCaps(c),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
  return caps;
}
