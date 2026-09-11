import type { SVGProps } from "react";

/**
 * A single, consistent outline icon set for the landing experience.
 *
 * Kept as inline SVGs rather than pulling in an icon dependency: every glyph
 * shares a 24-box, 1.6 stroke weight, round caps and joins, and paints in
 * `currentColor`, so they inherit their size and colour from context and stay
 * visually of a piece. `Icon` is the shared frame; the exports below are just
 * its paths.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...props }: IconProps & { children: React.ReactNode }) {
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

/** Brand mark — an agent "spark" node, used in the header and footer. */
export function BrandMark({ size = 22, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d="M12 2.5l1.9 4.8a3 3 0 001.8 1.8L20.5 11l-4.8 1.9a3 3 0 00-1.8 1.8L12 19.5l-1.9-4.8a3 3 0 00-1.8-1.8L3.5 11l4.8-1.9a3 3 0 001.8-1.8L12 2.5z"
        fill="currentColor"
      />
      <circle cx="18.5" cy="18.5" r="2.4" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

export const SparkleIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l1.6 4.2a3 3 0 001.7 1.7L19.5 10.5l-4.2 1.6a3 3 0 00-1.7 1.7L12 18l-1.6-4.2a3 3 0 00-1.7-1.7L4.5 10.5l4.2-1.6a3 3 0 001.7-1.7L12 3z" />
    <path d="M19 15.5l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5.5-1.4z" />
  </Icon>
);

export const ImportIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v11" />
    <path d="M8 10l4 4 4-4" />
    <path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
  </Icon>
);

export const GlobeIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a15 15 0 010 18a15 15 0 010-18z" />
  </Icon>
);

export const LayersIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3 13l9 5 9-5" />
  </Icon>
);

export const CompareIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 3v18" />
    <path d="M12 8l4 4-4 4" opacity="0.6" />
  </Icon>
);

export const ChatEditIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5h16v10H9l-4 4V5z" />
    <path d="M9 10h6" />
    <path d="M9 7h3" />
  </Icon>
);

export const PuzzleIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 4h6v3a2 2 0 104 0V9h1v6h-3a2 2 0 100 4h3v1H9v-3a2 2 0 10-4 0v3H4V9h3a2 2 0 100-4H4V4h5z" />
  </Icon>
);

export const ImageIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.8" />
    <path d="M4 17l5-5 4 4 3-3 4 4" />
  </Icon>
);

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Icon>
);

export const HistoryIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 12a8.5 8.5 0 103-6.5L3 8" />
    <path d="M3 4v4h4" />
    <path d="M12 8v4l3 2" />
  </Icon>
);

export const SendIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 3L10.5 13.5" />
    <path d="M21 3l-6.5 18-4-8-8-4L21 3z" />
  </Icon>
);

export const RocketIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 4c3 0 6 3 6 6-2 3-5 5-8 6l-4-4c1-3 3-6 6-8z" />
    <circle cx="14.5" cy="9.5" r="1.6" />
    <path d="M8 16l-3 3M6 12l-2 2M12 18l-2 2" />
  </Icon>
);

export const ArrowRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12h14" />
    <path d="M13 6l6 6-6 6" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 6L9 17l-5-5" />
  </Icon>
);

export const BoltIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
  </Icon>
);

export const ShieldIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />
    <path d="M9 12l2 2 4-4" />
  </Icon>
);

/** Capability id → icon, so the grid stays keyed to the real product data. */
export const CAPABILITY_ICONS: Record<string, (p: IconProps) => React.ReactElement> = {
  REPLICATE_WEB_PAGE: GlobeIcon,
  IMPORT_FIGMA: ImportIcon,
  START_FROM_BASE: LayersIcon,
  DESIGN_FIDELITY: CompareIcon,
  MODIFY_SITE: ChatEditIcon,
  ADD_FUNCTIONALITY: PuzzleIcon,
  MANAGE_IMAGERY: ImageIcon,
  RESEARCH_OR_INSPIRATION: SearchIcon,
  VERSION_AND_PREVIEW: HistoryIcon,
  REQUEST_PUBLISH: SendIcon,
  DEPLOY_SITE: RocketIcon,
};
