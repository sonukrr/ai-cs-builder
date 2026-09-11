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
