import type { SVGProps } from "react";

export type IconName = "camera" | "plus" | "upload" | "photo" | "queue" | "check" | "chevron-left" | "chevron-right" | "arrow-right" | "download" | "refresh" | "trash" | "logout" | "close" | "sparkles";
const paths: Record<IconName, React.ReactNode> = {
  camera: <><path d="M14.5 4h-5L7.8 7H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2.8z"/><circle cx="12" cy="13.5" r="3.5"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  upload: <><path d="M12 16V3m-4 4 4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></>,
  photo: <><rect x="4" y="3" width="16" height="18" rx="3"/><circle cx="12" cy="9" r="2.4"/><path d="M7.5 17a4.5 4.5 0 0 1 9 0"/></>,
  queue: <><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h4"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  "chevron-left": <path d="m14.5 6-6 6 6 6"/>,
  "chevron-right": <path d="m9.5 6 6 6-6 6"/>,
  "arrow-right": <path d="M4 12h16m-6-6 6 6-6 6"/>,
  download: <path d="M12 3v12m-4-4 4 4 4-4M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>,
  refresh: <><path d="M20 10a8 8 0 0 0-14-4L3 9m0-5v5h5M4 14a8 8 0 0 0 14 4l3-3m0 5v-5h-5"/></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></>,
  logout: <><path d="M10 4H5v16h5M9 12h12m-4-4 4 4-4 4"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/><path d="M20 2v4m-2-2h4"/></>,
};

export default function Icon({ name, size = 20, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
