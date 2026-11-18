"use client";

import { FlaskConical, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { API_MODE } from "../../lib/api";
import { useSession } from "../../lib/session";

/** 2026-11-18 起线上改为演示模式：API 消耗过大，生成功能已取消（后端 index.ts 的 GENERATION_ROUTES 一并拦截）。 */
const DEMO_REASON =
  "当前为演示模式：页面内容均为模拟数据，不具备真实生成能力。原因：API 消耗过大，生成功能已取消。";

/** 演示模式标记。首页/登录页悬浮在顶部居中；工作区放进顶栏（inline），避免和项目名挤在一起。 */
export function DemoBadge({ inline = false }: { inline?: boolean }) {
  const pathname = usePathname();
  if (API_MODE !== "fixture") return null;
  const inWorkspace = pathname.startsWith("/p");
  if (inline !== inWorkspace) return null;
  return (
    <div
      className={inline ? "demo-badge demo-badge-inline" : "demo-badge"}
      role="note"
      title={DEMO_REASON}
    >
      <FlaskConical size={13} aria-hidden />{" "}
      <span>演示数据{inline ? "" : " · API 消耗过大，生成功能已取消"}</span>
    </div>
  );
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === "dark";
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={dark ? "切换到亮色模式" : "切换到暗色模式"}
      title={dark ? "亮色模式" : "暗色模式"}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}

/** 顶部额度：匿名访客每天可生成的套数（后端未提供套数时退回张数） */
export function QuotaPill() {
  const { quota, remaining, setsRemaining } = useSession();
  if (!quota || remaining === null) return null;
  if (setsRemaining !== null)
    return (
      <span
        className={`badge quota-pill ${setsRemaining === 0 ? "badge-danger" : setsRemaining === 1 ? "badge-warn" : ""}`}
        title={`每天可生成 2 套，北京时间零点重置。单张重新生成不占套数（今日图片额度还剩 ${remaining} 张）`}
      >
        今日还可生成 {setsRemaining} 套
      </span>
    );
  const low = remaining <= 3;
  return (
    <span
      className={`badge quota-pill ${remaining === 0 ? "badge-danger" : low ? "badge-warn" : ""}`}
      title={`每天 ${quota.limit} 张，北京时间零点重置`}
    >
      今日还可生成 {remaining} 张
    </span>
  );
}
