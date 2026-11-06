/* biome-ignore-all lint/a11y/noSvgWithoutTitle: Decorative icons; every control supplies its own accessible name. */
import type { SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement>;

const baseProps: IconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: "false",
  role: "presentation",
};

function Icon({ children, ...props }: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      {children}
    </svg>
  );
}

export function LogoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 14.5v-5M10.5 17V7M14 15.5v-7M17.5 13V9" strokeWidth={2.2} />
    </Icon>
  );
}

export function GridIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </Icon>
  );
}

export function PlaylistIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6.5h10M4 11.5h10M4 16.5h6" />
      <circle cx="17.5" cy="16.5" r="2.5" />
      <path d="M20 16.5V7l-2.5.7" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.5 5.8v12.4L19 12 8.5 5.8Z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="7" y="5.5" width="3.5" height="13" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="13.5" y="5.5" width="3.5" height="13" rx="1.2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function SkipIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 5.8v12.4L15 12 6 5.8Z" fill="currentColor" stroke="none" />
      <path d="M18 5.5v13" strokeWidth={2.2} />
    </Icon>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function ShuffleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h3.2c1.3 0 2.5.7 3.2 1.8l3.2 6.4c.7 1.1 1.9 1.8 3.2 1.8H20" />
      <path d="M17 14.5 20 17l-3 2.5" />
      <path d="M4 17h3.2c1.1 0 2.1-.5 2.9-1.3" />
      <path d="M13.9 8.3c.7-.8 1.7-1.3 2.7-1.3H20" />
      <path d="M17 4.5 20 7l-3 2.5" />
    </Icon>
  );
}

export function RepeatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M17 4.5 20 7.5l-3 3" />
      <path d="M4 12V9.5A2 2 0 0 1 6 7.5h14" />
      <path d="M7 19.5 4 16.5l3-3" />
      <path d="M20 12v2.5a2 2 0 0 1-2 2H4" />
    </Icon>
  );
}

export function VolumeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 9.5h3l4-3.5v12l-4-3.5H4Z" />
      <path d="M14.5 9a4.3 4.3 0 0 1 0 6" />
      <path d="M17.3 6.5a8 8 0 0 1 0 11" />
    </Icon>
  );
}

export function PowerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5v8" />
      <path d="M6.8 6.7a7.5 7.5 0 1 0 10.4 0" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
    </Icon>
  );
}

export function ChevronUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6.5 14.5 5.5-5.5 5.5 5.5" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.5 6.5 9 12l5.5 5.5" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />
    </Icon>
  );
}

export function XIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    </Icon>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.5 19.5 4.3-1 10-10a2.1 2.1 0 0 0-3-3l-10 10-1.3 4Z" />
      <path d="m13.5 7.5 3 3" />
    </Icon>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V4.8h5V7" />
      <path d="M6.5 7l.8 12.2a1.8 1.8 0 0 0 1.8 1.7h5.8a1.8 1.8 0 0 0 1.8-1.7L17.5 7" />
      <path d="M10.2 11v6M13.8 11v6" />
    </Icon>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function MusicIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 18.5V6.2l9-1.7v11.8" />
      <circle cx="6.5" cy="18.5" r="2.5" />
      <circle cx="15.5" cy="16.3" r="2.5" />
    </Icon>
  );
}

export function ListIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11" />
      <path d="M4.2 6.5h.01M4.2 12h.01M4.2 17.5h.01" strokeWidth={2.4} />
    </Icon>
  );
}

export function HistoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8L3.8 8.6" />
      <path d="M3.8 4.5v4.1h4.1" />
      <path d="M12 8v4.4l3 1.8" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </Icon>
  );
}

export function LogOutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.5 4.5H6.3A1.8 1.8 0 0 0 4.5 6.3v11.4a1.8 1.8 0 0 0 1.8 1.8h3.2" />
      <path d="M13 8.5 16.5 12 13 15.5" />
      <path d="M8 12h8.5" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Icon>
  );
}

export function AlertTriangleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4.5 21 20H3L12 4.5Z" />
      <path d="M12 10v4.5" />
      <path d="M12 17.4h.01" strokeWidth={2.4} />
    </Icon>
  );
}

export function ExternalLinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.5 4.5H19.5V10.5" />
      <path d="M19.5 4.5 11 13" />
      <path d="M9.5 6.5H6.3A1.8 1.8 0 0 0 4.5 8.3v9.4a1.8 1.8 0 0 0 1.8 1.8h9.4a1.8 1.8 0 0 0 1.8-1.8v-3.2" />
    </Icon>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 13.8a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 1 0-5.7-5.7L11.4 7" />
      <path d="M14 10.2a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.2-1.2" />
    </Icon>
  );
}
