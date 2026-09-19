import { forwardRef } from "react";
import type { IconComponent, IconProps } from "reicon-react/createIcon";
import { Add } from "reicon-react/icons/Add";
import { ArrowRight as ReiconArrowRight } from "reicon-react/icons/ArrowRight";
import { ArrowUp as ReiconArrowUp } from "reicon-react/icons/ArrowUp";
import { ArrowUpRightSquare } from "reicon-react/icons/ArrowUpRightSquare";
import { Check as ReiconCheck } from "reicon-react/icons/Check";
import { ChevronDown as ReiconChevronDown } from "reicon-react/icons/ChevronDown";
import { Code2 } from "reicon-react/icons/Code2";
import { Copy as ReiconCopy } from "reicon-react/icons/Copy";
import { Menu as ReiconMenu } from "reicon-react/icons/Menu";
import { MessageSquare as ReiconMessageSquare } from "reicon-react/icons/MessageSquare";
import { Play as ReiconPlay } from "reicon-react/icons/Play";
import { RotateLeft } from "reicon-react/icons/RotateLeft";
import { ShieldCheck as ReiconShieldCheck } from "reicon-react/icons/ShieldCheck";
import { Sparkles as ReiconSparkles } from "reicon-react/icons/Sparkles";
import { Text as ReiconText } from "reicon-react/icons/Text";
import { X as ReiconX } from "reicon-react/icons/X";

function icon(Source: IconComponent) {
  return forwardRef<SVGSVGElement, IconProps>((props, ref) => (
    <Source
      {...props}
      ref={ref}
      weight={props.weight ?? "Outline"}
      strokeWidth={props.strokeWidth ?? 1.5}
      aria-hidden={props["aria-hidden"] ?? !props["aria-label"]}
    />
  ));
}

export const ArrowRight = icon(ReiconArrowRight);
export const ArrowUp = icon(ReiconArrowUp);
export const Check = icon(ReiconCheck);
export const ChevronDown = icon(ReiconChevronDown);
export const CodeXml = icon(Code2);
export const Copy = icon(ReiconCopy);
export const ExternalLink = icon(ArrowUpRightSquare);
export const Menu = icon(ReiconMenu);
export const MessageSquare = icon(ReiconMessageSquare);
export const Play = icon(ReiconPlay);
export const Plus = icon(Add);
export const RotateCcw = icon(RotateLeft);
export const ShieldCheck = icon(ReiconShieldCheck);
export const Sparkles = icon(ReiconSparkles);
export const Text = icon(ReiconText);
export const X = icon(ReiconX);
