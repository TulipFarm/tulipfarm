import { forwardRef, type ReactNode } from "react";
import {
  type IconComponent,
  type IconProps,
  ArrowUpRightSquare as ReiconArrowUpRightSquare,
  Check as ReiconCheck,
  ChevronDown as ReiconChevronDown,
  Code2 as ReiconCode2,
  Copy as ReiconCopy,
  MessageSquare as ReiconMessageSquare,
  Sparkles as ReiconSparkles,
  Text as ReiconText,
} from "reicon-react";

export type Icon = IconComponent;

function ariaHiddenFor(props: IconProps) {
  if (props["aria-hidden"] !== undefined) return props["aria-hidden"];
  return props["aria-label"] || props["aria-labelledby"] ? undefined : true;
}

function wrapIcon(Source: IconComponent, name: string): Icon {
  const Wrapped = forwardRef<SVGSVGElement, IconProps>((props, ref) => (
    <Source
      {...props}
      ref={ref}
      weight={props.weight ?? "Outline"}
      strokeWidth={props.strokeWidth ?? 1.5}
      aria-hidden={ariaHiddenFor(props)}
    />
  ));
  Wrapped.displayName = name;
  return Wrapped;
}

function localIcon(name: string, children: ReactNode): Icon {
  const Local = forwardRef<SVGSVGElement, IconProps>(
    (
      {
        color,
        secondaryColor: _secondaryColor,
        size = 24,
        weight: _weight,
        strokeWidth = 1.5,
        className,
        style,
        ...props
      },
      ref
    ) => (
      <svg
        {...props}
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className ? `reicon ${className}` : "reicon"}
        style={color == null ? style : { color, ...style }}
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        aria-hidden={ariaHiddenFor(props)}
      >
        {children}
      </svg>
    )
  );
  Local.displayName = name;
  return Local;
}

export const Check = wrapIcon(ReiconCheck, "Check");
export const ChevronDown = wrapIcon(ReiconChevronDown, "ChevronDown");
export const CodeXml = wrapIcon(ReiconCode2, "CodeXml");
export const Copy = wrapIcon(ReiconCopy, "Copy");
export const ExternalLink = wrapIcon(ReiconArrowUpRightSquare, "ExternalLink");
export const MessageSquare = wrapIcon(ReiconMessageSquare, "MessageSquare");
export const Sparkles = wrapIcon(ReiconSparkles, "Sparkles");
export const Text = wrapIcon(ReiconText, "Text");

export const GitFork = localIcon(
  "GitFork",
  <>
    <circle cx="12" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <circle cx="18" cy="6" r="3" />
    <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9M12 12v3" />
  </>
);
