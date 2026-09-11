import type { SVGProps } from "react";

/**
 * The studio's own icon set, kept independent of the landing page's — same
 * frame convention (24-box, 1.6 stroke, round caps/joins, currentColor) so it
 * reads as one family without coupling the two routes together.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const DesktopIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M8 20h8" />
    <path d="M12 16v4" />
  </Icon>
);

export const ExpandIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 4H4v5" />
    <path d="M15 20h5v-5" />
    <path d="M20 4l-7 7" />
    <path d="M4 20l7-7" />
  </Icon>
);

export const TabletIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M11.5 17.5h1" />
  </Icon>
);

export const MobileIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="7.5" y="2.5" width="9" height="19" rx="2" />
    <path d="M11 19h2" />
  </Icon>
);

export const RowIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="7" width="7" height="10" rx="1.2" />
    <rect x="14" y="7" width="7" height="10" rx="1.2" />
  </Icon>
);

export const GridIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="8" height="8" rx="1.2" />
    <rect x="13" y="3" width="8" height="8" rx="1.2" />
    <rect x="3" y="13" width="8" height="8" rx="1.2" />
    <rect x="13" y="13" width="8" height="8" rx="1.2" />
  </Icon>
);

export const StackIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5" y="3" width="14" height="6" rx="1.2" />
    <rect x="5" y="11" width="14" height="6" rx="1.2" />
    <rect x="5" y="19" width="14" height="2" rx="1" opacity="0.55" />
  </Icon>
);

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
);

export const SendIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 3L10.5 13.5" />
    <path d="M21 3l-6.5 18-4-8-8-4L21 3z" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12" />
    <path d="M18 6L6 18" />
  </Icon>
);

/** A filled square — the universal "stop the running response" affordance. */
export const StopIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </Icon>
);

export const HistoryIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 12a8.5 8.5 0 103-6.5L3 8" />
    <path d="M3 4v4h4" />
    <path d="M12 8v4l3 2" />
  </Icon>
);

export const PageIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 3h7l4 4v14H7z" />
    <path d="M14 3v4h4" />
  </Icon>
);

/** The preview panel's empty state — a screen with a play triangle, since a
    site preview is something you watch come to life, not just a document. */
export const PreviewGlyph = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M8 21h8" />
    <path d="M12 17v4" />
    <path d="M10.5 8.3v4.4l3.8-2.2z" fill="currentColor" stroke="none" />
  </Icon>
);

export const ChatGlyph = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5h16v10H9l-4 4V5z" />
    <path d="M8.5 9h7" />
    <path d="M8.5 12h4" />
  </Icon>
);

export const ReloadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 12a8.5 8.5 0 0114.5-6" />
    <path d="M18 3v4.5h-4.5" />
    <path d="M20.5 12a8.5 8.5 0 01-14.5 6" />
    <path d="M6 21v-4.5h4.5" />
  </Icon>
);

export const ExternalLinkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 5H5a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-4" />
    <path d="M14 4h6v6" />
    <path d="M20 4l-9.5 9.5" />
  </Icon>
);

export const ImageIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" stroke="none" />
    <path d="M3 16l5-5 4 4 6-6 3 3" />
  </Icon>
);

export const SparklesIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 2l1.4 3.6a3 3 0 001.8 1.8L19 9l-3.6 1.4a3 3 0 00-1.8 1.8L12 16l-1.4-3.6a3 3 0 00-1.8-1.8L5 9l3.6-1.4a3 3 0 001.8-1.8L12 2z" />
    <path d="M5 16l.6 1.4a2 2 0 00.8.8l1.4.6-1.4.6a2 2 0 00-.8.8L5 22l-.6-1.4a2 2 0 00-.8-.8l-1.4-.6 1.4-.6a2 2 0 00.8-.8L5 16z" />
  </Icon>
);

export const PaletteIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3a9 8.5 0 100 17c1 0 1.6-.6 1.6-1.4 0-.4-.2-.7-.4-1-.3-.3-.4-.6-.4-1 0-.8.6-1.4 1.4-1.4H16a4 4 0 004-4c0-4.4-3.6-8.2-8-8.2z" />
    <circle cx="7.3" cy="11.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="9.8" cy="7.2" r="1" fill="currentColor" stroke="none" />
    <circle cx="14.8" cy="7.2" r="1" fill="currentColor" stroke="none" />
    <circle cx="16.8" cy="11.5" r="1" fill="currentColor" stroke="none" />
  </Icon>
);

/** The agent mark — same "spark" used on the landing page's brand, so the
    studio reads as the same product mid-task rather than a different tool. */
export const SparkMark = (p: IconProps) => (
  <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...p}>
    <path
      d="M12 2.5l1.9 4.8a3 3 0 001.8 1.8L20.5 11l-4.8 1.9a3 3 0 00-1.8 1.8L12 19.5l-1.9-4.8a3 3 0 00-1.8-1.8L3.5 11l4.8-1.9a3 3 0 001.8-1.8L12 2.5z"
      fill="currentColor"
    />
  </svg>
);
