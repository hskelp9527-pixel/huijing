"use client";

import { X } from "lucide-react";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import { cx } from "../../lib/utils";

interface ToastItem {
  id: number;
  text: string;
  tone: "info" | "error";
  action?: { label: string; run: () => void };
}
interface ToastApi {
  show(
    text: string,
    opts?: {
      tone?: "info" | "error";
      action?: ToastItem["action"];
      ms?: number;
    },
  ): void;
}
const Ctx = createContext<ToastApi>({ show: () => {} });
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback(
    (id: number) => setItems((l) => l.filter((t) => t.id !== id)),
    [],
  );
  const api = useMemo<ToastApi>(
    () => ({
      show(text, opts = {}) {
        const id = ++seq.current;
        setItems((l) => [
          ...l.slice(-3),
          {
            id,
            text,
            tone: opts.tone ?? "info",
            ...(opts.action ? { action: opts.action } : {}),
          },
        ]);
        setTimeout(() => dismiss(id), opts.ms ?? 5000);
      },
    }),
    [dismiss],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <output className="toasts" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={cx("toast", t.tone === "error" && "toast-error")}
          >
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action?.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="关闭提示"
              onClick={() => dismiss(t.id)}
              style={{
                marginLeft: t.action ? 0 : "auto",
                textDecoration: "none",
              }}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </output>
    </Ctx.Provider>
  );
}
