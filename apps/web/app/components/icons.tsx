import { forwardRef, type ReactNode } from "react";
import type { IconComponent, IconProps } from "reicon-react/createIcon";
import { Activity as ReiconActivity } from "reicon-react/icons/Activity";
import { Add as ReiconAdd } from "reicon-react/icons/Add";
import { AlertCircle as ReiconAlertCircle } from "reicon-react/icons/AlertCircle";
import { AlertTriangle as ReiconAlertTriangle } from "reicon-react/icons/AlertTriangle";
import { ArrowDown as ReiconArrowDown } from "reicon-react/icons/ArrowDown";
import { ArrowLeft as ReiconArrowLeft } from "reicon-react/icons/ArrowLeft";
import { ArrowRight as ReiconArrowRight } from "reicon-react/icons/ArrowRight";
import { ArrowSwapHorizontal as ReiconArrowSwapHorizontal } from "reicon-react/icons/ArrowSwapHorizontal";
import { ArrowsUp as ReiconArrowsUp } from "reicon-react/icons/ArrowsUp";
import { ArrowToDownLeft as ReiconArrowToDownLeft } from "reicon-react/icons/ArrowToDownLeft";
import { ArrowToDownRight as ReiconArrowToDownRight } from "reicon-react/icons/ArrowToDownRight";
import { ArrowUp as ReiconArrowUp } from "reicon-react/icons/ArrowUp";
import { ArrowUpRight as ReiconArrowUpRight } from "reicon-react/icons/ArrowUpRight";
import { ArrowUpRightSquare as ReiconArrowUpRightSquare } from "reicon-react/icons/ArrowUpRightSquare";
import { AtSign as ReiconAtSign } from "reicon-react/icons/AtSign";
import { Ban as ReiconBan } from "reicon-react/icons/Ban";
import { Bold as ReiconBold } from "reicon-react/icons/Bold";
import { Bolt as ReiconBolt } from "reicon-react/icons/Bolt";
import { BookOpen as ReiconBookOpen } from "reicon-react/icons/BookOpen";
import { Box as ReiconBox } from "reicon-react/icons/Box";
import { BranchDown as ReiconBranchDown } from "reicon-react/icons/BranchDown";
import { Bug as ReiconBug } from "reicon-react/icons/Bug";
import { Building2 as ReiconBuilding2 } from "reicon-react/icons/Building2";
import { Calendar as ReiconCalendar } from "reicon-react/icons/Calendar";
import { Check as ReiconCheck } from "reicon-react/icons/Check";
import { CheckCircle as ReiconCheckCircle } from "reicon-react/icons/CheckCircle";
import { ChevronDown as ReiconChevronDown } from "reicon-react/icons/ChevronDown";
import { ChevronExpandY as ReiconChevronExpandY } from "reicon-react/icons/ChevronExpandY";
import { ChevronRight as ReiconChevronRight } from "reicon-react/icons/ChevronRight";
import { Clock as ReiconClock } from "reicon-react/icons/Clock";
import { Code as ReiconCode } from "reicon-react/icons/Code";
import { Code2 as ReiconCode2 } from "reicon-react/icons/Code2";
import { Copy as ReiconCopy } from "reicon-react/icons/Copy";
import { Cpu as ReiconCpu } from "reicon-react/icons/Cpu";
import { Database as ReiconDatabase } from "reicon-react/icons/Database";
import { Download as ReiconDownload } from "reicon-react/icons/Download";
import { Edit as ReiconEdit } from "reicon-react/icons/Edit";
import { Eye as ReiconEye } from "reicon-react/icons/Eye";
import { EyeOff as ReiconEyeOff } from "reicon-react/icons/EyeOff";
import { File as ReiconFile } from "reicon-react/icons/File";
import { FileRemove as ReiconFileRemove } from "reicon-react/icons/FileRemove";
import { FileText as ReiconFileText } from "reicon-react/icons/FileText";
import { Flag as ReiconFlag } from "reicon-react/icons/Flag";
import { Folder as ReiconFolder } from "reicon-react/icons/Folder";
import { FolderMove as ReiconFolderMove } from "reicon-react/icons/FolderMove";
import { Gauge as ReiconGauge } from "reicon-react/icons/Gauge";
import { Gear as ReiconGear } from "reicon-react/icons/Gear";
import { Globe as ReiconGlobe } from "reicon-react/icons/Globe";
import { Hand as ReiconHand } from "reicon-react/icons/Hand";
import { Hierarchy3 as ReiconHierarchy3 } from "reicon-react/icons/Hierarchy3";
import { History as ReiconHistory } from "reicon-react/icons/History";
import { Image as ReiconImage } from "reicon-react/icons/Image";
import { Inbox as ReiconInbox } from "reicon-react/icons/Inbox";
import { InfoCircle as ReiconInfoCircle } from "reicon-react/icons/InfoCircle";
import { Italic as ReiconItalic } from "reicon-react/icons/Italic";
import { Key as ReiconKey } from "reicon-react/icons/Key";
import { Laptop as ReiconLaptop } from "reicon-react/icons/Laptop";
import { Layers as ReiconLayers } from "reicon-react/icons/Layers";
import { Layout as ReiconLayout } from "reicon-react/icons/Layout";
import { Library as ReiconLibrary } from "reicon-react/icons/Library";
import { Link as ReiconLink } from "reicon-react/icons/Link";
import { Link2 as ReiconLink2 } from "reicon-react/icons/Link2";
import { Loader as ReiconLoader } from "reicon-react/icons/Loader";
import { Lock as ReiconLock } from "reicon-react/icons/Lock";
import { LockKeyhole as ReiconLockKeyhole } from "reicon-react/icons/LockKeyhole";
import { Logout as ReiconLogout } from "reicon-react/icons/Logout";
import { Maximize2 as ReiconMaximize2 } from "reicon-react/icons/Maximize2";
import { Menu as ReiconMenu } from "reicon-react/icons/Menu";
import { MessageAdd as ReiconMessageAdd } from "reicon-react/icons/MessageAdd";
import { MessageCircle as ReiconMessageCircle } from "reicon-react/icons/MessageCircle";
import { MessageSquare as ReiconMessageSquare } from "reicon-react/icons/MessageSquare";
import { Minimize as ReiconMinimize } from "reicon-react/icons/Minimize";
import { Mobile as ReiconMobile } from "reicon-react/icons/Mobile";
import { Monitor as ReiconMonitor } from "reicon-react/icons/Monitor";
import { Moon as ReiconMoon } from "reicon-react/icons/Moon";
import { MoreH as ReiconMoreH } from "reicon-react/icons/MoreH";
import { Nodes as ReiconNodes } from "reicon-react/icons/Nodes";
import { Palette as ReiconPalette } from "reicon-react/icons/Palette";
import { Paperclip as ReiconPaperclip } from "reicon-react/icons/Paperclip";
import { PenLine as ReiconPenLine } from "reicon-react/icons/PenLine";
import { Play as ReiconPlay } from "reicon-react/icons/Play";
import { Plug as ReiconPlug } from "reicon-react/icons/Plug";
import { Puzzle as ReiconPuzzle } from "reicon-react/icons/Puzzle";
import { Radio as ReiconRadio } from "reicon-react/icons/Radio";
import { Record as ReiconRecord } from "reicon-react/icons/Record";
import { RecoveryConvert as ReiconRecoveryConvert } from "reicon-react/icons/RecoveryConvert";
import { Refresh as ReiconRefresh } from "reicon-react/icons/Refresh";
import { RotateLeft as ReiconRotateLeft } from "reicon-react/icons/RotateLeft";
import { RotateRight as ReiconRotateRight } from "reicon-react/icons/RotateRight";
import { RouteTrack as ReiconRouteTrack } from "reicon-react/icons/RouteTrack";
import { Search as ReiconSearch } from "reicon-react/icons/Search";
import { Settings as ReiconSettings } from "reicon-react/icons/Settings";
import { Share as ReiconShare } from "reicon-react/icons/Share";
import { ShieldAlert as ReiconShieldAlert } from "reicon-react/icons/ShieldAlert";
import { ShieldCheck as ReiconShieldCheck } from "reicon-react/icons/ShieldCheck";
import { ShieldOff as ReiconShieldOff } from "reicon-react/icons/ShieldOff";
import { ShieldX as ReiconShieldX } from "reicon-react/icons/ShieldX";
import { SidebarLeft2 as ReiconSidebarLeft2 } from "reicon-react/icons/SidebarLeft2";
import { SidebarRight2 as ReiconSidebarRight2 } from "reicon-react/icons/SidebarRight2";
import { Slash as ReiconSlash } from "reicon-react/icons/Slash";
import { SlashCircle as ReiconSlashCircle } from "reicon-react/icons/SlashCircle";
import { Sparkles as ReiconSparkles } from "reicon-react/icons/Sparkles";
import { Star as ReiconStar } from "reicon-react/icons/Star";
import { Stop3 as ReiconStop3 } from "reicon-react/icons/Stop3";
import { Sun as ReiconSun } from "reicon-react/icons/Sun";
import { Tablet as ReiconTablet } from "reicon-react/icons/Tablet";
import { TerminalSquare as ReiconTerminalSquare } from "reicon-react/icons/TerminalSquare";
import { Text as ReiconText } from "reicon-react/icons/Text";
import { ThreeDCube as ReiconThreeDCube } from "reicon-react/icons/ThreeDCube";
import { ThumbsDown as ReiconThumbsDown } from "reicon-react/icons/ThumbsDown";
import { ThumbsUp as ReiconThumbsUp } from "reicon-react/icons/ThumbsUp";
import { Trash2 as ReiconTrash2 } from "reicon-react/icons/Trash2";
import { Upload as ReiconUpload } from "reicon-react/icons/Upload";
import { User as ReiconUser } from "reicon-react/icons/User";
import { User4 as ReiconUser4 } from "reicon-react/icons/User4";
import { UserAdd as ReiconUserAdd } from "reicon-react/icons/UserAdd";
import { Users as ReiconUsers } from "reicon-react/icons/Users";
import { X as ReiconX } from "reicon-react/icons/X";
import { XCircle as ReiconXCircle } from "reicon-react/icons/XCircle";

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

export const Activity = wrapIcon(ReiconActivity, "Activity");
export const AlertCircle = wrapIcon(ReiconAlertCircle, "AlertCircle");
export const AlertTriangle = wrapIcon(ReiconAlertTriangle, "AlertTriangle");
export const ArrowDown = wrapIcon(ReiconArrowDown, "ArrowDown");
export const ArrowLeft = wrapIcon(ReiconArrowLeft, "ArrowLeft");
export const ArrowRight = wrapIcon(ReiconArrowRight, "ArrowRight");
export const ArrowRightLeft = wrapIcon(ReiconArrowSwapHorizontal, "ArrowRightLeft");
export const ArrowUp = wrapIcon(ReiconArrowUp, "ArrowUp");
export const ArrowUpRight = wrapIcon(ReiconArrowUpRight, "ArrowUpRight");
export const AtSign = wrapIcon(ReiconAtSign, "AtSign");
export const Ban = wrapIcon(ReiconBan, "Ban");
export const Bold = wrapIcon(ReiconBold, "Bold");
export const BookOpen = wrapIcon(ReiconBookOpen, "BookOpen");
export const BookText = wrapIcon(ReiconBookOpen, "BookText");
export const Box = wrapIcon(ReiconBox, "Box");
export const Boxes = wrapIcon(ReiconThreeDCube, "Boxes");
export const Braces = wrapIcon(ReiconCode2, "Braces");
export const Bug = wrapIcon(ReiconBug, "Bug");
export const Building2 = wrapIcon(ReiconBuilding2, "Building2");
export const Calendar = wrapIcon(ReiconCalendar, "Calendar");
export const Check = wrapIcon(ReiconCheck, "Check");
export const CheckCircle2 = wrapIcon(ReiconCheckCircle, "CheckCircle2");
export const ChevronDown = wrapIcon(ReiconChevronDown, "ChevronDown");
export const ChevronRight = wrapIcon(ReiconChevronRight, "ChevronRight");
export const ChevronsUp = wrapIcon(ReiconArrowsUp, "ChevronsUp");
export const ChevronsUpDown = wrapIcon(ReiconChevronExpandY, "ChevronsUpDown");
export const Circle = wrapIcon(ReiconRecord, "Circle");
export const CircleAlert = wrapIcon(ReiconAlertCircle, "CircleAlert");
export const CircleCheck = wrapIcon(ReiconCheckCircle, "CircleCheck");
export const CircleSlash = wrapIcon(ReiconSlashCircle, "CircleSlash");
export const Clock = wrapIcon(ReiconClock, "Clock");
export const Code = wrapIcon(ReiconCode, "Code");
export const Code2 = wrapIcon(ReiconCode2, "Code2");
export const CodeXml = wrapIcon(ReiconCode2, "CodeXml");
export const Cog = wrapIcon(ReiconGear, "Cog");
export const Columns3 = wrapIcon(ReiconLayout, "Columns3");
export const Copy = wrapIcon(ReiconCopy, "Copy");
export const CornerDownLeft = wrapIcon(ReiconArrowToDownLeft, "CornerDownLeft");
export const CornerDownRight = wrapIcon(ReiconArrowToDownRight, "CornerDownRight");
export const Cpu = wrapIcon(ReiconCpu, "Cpu");
export const Database = wrapIcon(ReiconDatabase, "Database");
export const DatabaseBackup = wrapIcon(ReiconRecoveryConvert, "DatabaseBackup");
export const Download = wrapIcon(ReiconDownload, "Download");
export const ExternalLink = wrapIcon(ReiconArrowUpRightSquare, "ExternalLink");
export const Eye = wrapIcon(ReiconEye, "Eye");
export const EyeOff = wrapIcon(ReiconEyeOff, "EyeOff");
export const FileClock = wrapIcon(ReiconHistory, "FileClock");
export const File = wrapIcon(ReiconFile, "File");
export const FileText = wrapIcon(ReiconFileText, "FileText");
export const FileX2 = wrapIcon(ReiconFileRemove, "FileX2");
export const Flag = wrapIcon(ReiconFlag, "Flag");
export const Folder = wrapIcon(ReiconFolder, "Folder");
export const FolderInput = wrapIcon(ReiconFolderMove, "FolderInput");
export const Gauge = wrapIcon(ReiconGauge, "Gauge");
export const GitBranch = wrapIcon(ReiconBranchDown, "GitBranch");
export const Globe = wrapIcon(ReiconGlobe, "Globe");
export const Hand = wrapIcon(ReiconHand, "Hand");
export const History = wrapIcon(ReiconHistory, "History");
export const Image = wrapIcon(ReiconImage, "Image");
export const ImageIcon = wrapIcon(ReiconImage, "ImageIcon");
export const Inbox = wrapIcon(ReiconInbox, "Inbox");
export const Info = wrapIcon(ReiconInfoCircle, "Info");
export const Italic = wrapIcon(ReiconItalic, "Italic");
export const KeyRound = wrapIcon(ReiconKey, "KeyRound");
export const Laptop = wrapIcon(ReiconLaptop, "Laptop");
export const Layers = wrapIcon(ReiconLayers, "Layers");
export const Library = wrapIcon(ReiconLibrary, "Library");
export const Link = wrapIcon(ReiconLink, "Link");
export const Link2 = wrapIcon(ReiconLink2, "Link2");
export const Loader2 = wrapIcon(ReiconLoader, "Loader2");
export const Lock = wrapIcon(ReiconLock, "Lock");
export const LockKeyhole = wrapIcon(ReiconLockKeyhole, "LockKeyhole");
export const LogOut = wrapIcon(ReiconLogout, "LogOut");
export const Maximize2 = wrapIcon(ReiconMaximize2, "Maximize2");
export const Menu = wrapIcon(ReiconMenu, "Menu");
export const MessageCircle = wrapIcon(ReiconMessageCircle, "MessageCircle");
export const MessageSquare = wrapIcon(ReiconMessageSquare, "MessageSquare");
export const MessageSquarePlus = wrapIcon(ReiconMessageAdd, "MessageSquarePlus");
export const Minimize2 = wrapIcon(ReiconMinimize, "Minimize2");
export const Monitor = wrapIcon(ReiconMonitor, "Monitor");
export const Moon = wrapIcon(ReiconMoon, "Moon");
export const MoreHorizontal = wrapIcon(ReiconMoreH, "MoreHorizontal");
export const Network = wrapIcon(ReiconNodes, "Network");
export const Palette = wrapIcon(ReiconPalette, "Palette");
export const PanelLeftClose = wrapIcon(ReiconSidebarLeft2, "PanelLeftClose");
export const PanelLeftOpen = wrapIcon(ReiconSidebarRight2, "PanelLeftOpen");
export const Paperclip = wrapIcon(ReiconPaperclip, "Paperclip");
export const Pencil = wrapIcon(ReiconEdit, "Pencil");
export const PenLine = wrapIcon(ReiconPenLine, "PenLine");
export const Play = wrapIcon(ReiconPlay, "Play");
export const Plug = wrapIcon(ReiconPlug, "Plug");
export const Plus = wrapIcon(ReiconAdd, "Plus");
export const Puzzle = wrapIcon(ReiconPuzzle, "Puzzle");
export const Radio = wrapIcon(ReiconRadio, "Radio");
export const RefreshCw = wrapIcon(ReiconRefresh, "RefreshCw");
export const RotateCcw = wrapIcon(ReiconRotateLeft, "RotateCcw");
export const RotateCw = wrapIcon(ReiconRotateRight, "RotateCw");
export const Search = wrapIcon(ReiconSearch, "Search");
export const Settings = wrapIcon(ReiconSettings, "Settings");
export const Share2 = wrapIcon(ReiconShare, "Share2");
export const ShieldAlert = wrapIcon(ReiconShieldAlert, "ShieldAlert");
export const ShieldCheck = wrapIcon(ReiconShieldCheck, "ShieldCheck");
export const ShieldOff = wrapIcon(ReiconShieldOff, "ShieldOff");
export const ShieldX = wrapIcon(ReiconShieldX, "ShieldX");
export const Slash = wrapIcon(ReiconSlash, "Slash");
export const Smartphone = wrapIcon(ReiconMobile, "Smartphone");
export const Sparkles = wrapIcon(ReiconSparkles, "Sparkles");
export const Split = wrapIcon(ReiconHierarchy3, "Split");
export const Square = wrapIcon(ReiconStop3, "Square");
export const Star = wrapIcon(ReiconStar, "Star");
export const Sun = wrapIcon(ReiconSun, "Sun");
export const Tablet = wrapIcon(ReiconTablet, "Tablet");
export const Terminal = wrapIcon(ReiconTerminalSquare, "Terminal");
export const Text = wrapIcon(ReiconText, "Text");
export const ThumbsDown = wrapIcon(ReiconThumbsDown, "ThumbsDown");
export const ThumbsUp = wrapIcon(ReiconThumbsUp, "ThumbsUp");
export const Trash2 = wrapIcon(ReiconTrash2, "Trash2");
export const TriangleAlert = wrapIcon(ReiconAlertTriangle, "TriangleAlert");
export const Upload = wrapIcon(ReiconUpload, "Upload");
export const User = wrapIcon(ReiconUser, "User");
export const UserPlus = wrapIcon(ReiconUserAdd, "UserPlus");
export const UserRound = wrapIcon(ReiconUser4, "UserRound");
export const Users = wrapIcon(ReiconUsers, "Users");
export const UsersRound = wrapIcon(ReiconUsers, "UsersRound");
export const Waypoints = wrapIcon(ReiconRouteTrack, "Waypoints");
export const Workflow = wrapIcon(ReiconHierarchy3, "Workflow");
export const X = wrapIcon(ReiconX, "X");
export const XCircle = wrapIcon(ReiconXCircle, "XCircle");
export const Zap = wrapIcon(ReiconBolt, "Zap");

export const Bot = localIcon(
  "Bot",
  <>
    <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
  </>
);

export const Brain = localIcon(
  "Brain",
  <>
    <path d="M12 18V5M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
    <path d="M17.6 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.6 1.5" />
    <path d="M18 5.13a4 4 0 0 1 2.52 5.77M18 18a4 4 0 0 0 2-7.46" />
    <path d="M19.97 17.48A4 4 0 1 1 12 18a4 4 0 1 1-7.97-.52" />
    <path d="M6 18a4 4 0 0 1-2-7.46M6 5.13a4 4 0 0 0-2.52 5.77" />
  </>
);

export const CircleDot = localIcon(
  "CircleDot",
  <>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="1" />
  </>
);

export const Flower2 = localIcon(
  "Flower2",
  <>
    <path d="M12 5a3 3 0 1 1 3 3m-3-3a3 3 0 1 0-3 3m3-3v1M9 8a3 3 0 1 0 3 3M9 8h1m5 0a3 3 0 1 1-3 3m3-3h-1m-2 3v-1" />
    <circle cx="12" cy="8" r="2" />
    <path d="M12 10v12M12 22c4.2 0 7-1.67 7-5-4.2 0-7 1.67-7 5ZM12 22c-4.2 0-7-1.67-7-5 4.2 0 7 1.67 7 5Z" />
  </>
);

export const GitPullRequest = localIcon(
  "GitPullRequest",
  <>
    <circle cx="18" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12" />
  </>
);

export const ShieldQuestion = localIcon(
  "ShieldQuestion",
  <>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z" />
    <path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3M12 17h.01" />
  </>
);

export const Webhook = localIcon(
  "Webhook",
  <>
    <path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2" />
    <path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" />
    <path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" />
  </>
);

export const DollarSign = localIcon(
  "DollarSign",
  <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
);

export const Wrench = localIcon(
  "Wrench",
  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.11-3.1c.32-.33.86-.23.98.21a6 6 0 0 1-8.26 7.06l-7.91 7.91a1 1 0 0 1-3-3l7.91-7.91a6 6 0 0 1 7.06-8.26c.43.12.54.66.22.98Z" />
);
