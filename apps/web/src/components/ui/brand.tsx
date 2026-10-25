export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--ink)" />
      <path
        d="M9 12V9h3M20 9h3v3M23 20v3h-3M12 23H9v-3"
        fill="none"
        stroke="var(--ink-inverse)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="16" r="4.2" fill="var(--accent)" />
    </svg>
  );
}
export const PRODUCT_NAME = "绘境";
