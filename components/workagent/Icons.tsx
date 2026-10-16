import type { CSSProperties } from "react";

const paths: Record<string, React.ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
  home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" /><path d="M9 21v-8h6v8" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
  folder: <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />,
  file: <><path d="M13 3H5v18h14V9Z" /><path d="M13 3v6h6M8 13h8M8 17h5" /></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 14h18M9 9v11M15 9v11" /></>,
  sparkle: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /><path d="m20 2 1 2 2 1-2 1-1 2-1-2-2-1 2-1Z" /></>,
  settings: <><path d="m9 3-1 3-3 1v4l-2 1 2 2v3l3 1 1 3h5l1-3 3-1v-3l3-2-3-1V7l-3-1-1-3Z" /><circle cx="11.5" cy="12" r="3" /></>,
  chat: <path d="M4 4h16v12H9l-5 4Z" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16" /></>,
  maximize: <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" />,
  restore: <path d="M3 8h5V3M16 3v5h5M21 16h-5v5M8 21v-5H3" />,
  plug: <><path d="M9 3v5m6-5v5M6 8h12v4a6 6 0 0 1-12 0ZM12 18v4" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  archive: <><path d="M4 8h16v13H4ZM2 3h20v5H2ZM9 12h6" /></>,
  edit: <><path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14Z" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
};
export function Icon({ name, size = 18, style }: { name: string; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name] ?? paths.sparkle}</svg>;
}
export function Brand({ small = false }: { small?: boolean }) {
  return <span className={`wa-brand-symbol${small ? " small" : ""}`} aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><path d="m8 13 5 17 7-13 7 13 5-17" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /><path d="m21 7 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" fill="currentColor" /></svg></span>;
}
