"use client";

import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** 点击外部或按 Esc 关闭；焦点回到触发按钮由调用方处理。 */
export function useDismiss(
  open: boolean,
  onClose: () => void,
  ref: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, ref]);
}

/** 弹层与视口边缘至少留出的距离 */
const EDGE = 8;

export function Popover({
  open,
  onClose,
  trigger,
  children,
  className,
  align = "left",
  placement = "below",
}: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
  align?: "left" | "right";
  placement?: "below" | "above";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);
  // 竖直方向：优先 placement，放不下再换到另一侧；两侧都放不下就取大的一侧并限制高度、内部滚动
  const [vert, setVert] = useState<{
    side: "below" | "above";
    maxH?: number | undefined;
  }>({
    side: placement,
  });
  useDismiss(open, onClose, ref);
  useLayoutEffect(() => {
    if (!open) {
      setFlip(false);
      setVert({ side: placement });
      return;
    }
    const measure = () => {
      const panel = panelRef.current;
      const host = ref.current;
      if (!panel || !host) return;
      const r = panel.getBoundingClientRect();
      if (r.right > window.innerWidth - 8 && r.left >= 8) setFlip(true);
      const t = host.getBoundingClientRect();
      const gap = 8 + EDGE;
      const room = {
        below: window.innerHeight - t.bottom - gap,
        above: t.top - gap,
      };
      const need = panel.scrollHeight + 2; // 含边框
      const other = placement === "below" ? "above" : "below";
      const side =
        room[placement] >= need
          ? placement
          : room[other] >= need || room[other] > room[placement]
            ? other
            : placement;
      setVert({
        side,
        maxH: room[side] >= need ? undefined : Math.max(160, room[side]),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, placement]);
  const side = flip ? (align === "left" ? "right" : "left") : align;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      {trigger}
      {open && (
        <div
          ref={panelRef}
          className={`popover ${className ?? ""}`}
          style={{
            [side]: 0,
            ...(vert.side === "below"
              ? { top: "calc(100% + 8px)" }
              : { bottom: "calc(100% + 8px)" }),
            ...(vert.maxH ? { maxHeight: vert.maxH, overflowY: "auto" } : {}),
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
