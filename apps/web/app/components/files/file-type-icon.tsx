import type { ComponentProps } from "react";
import { File, FileText, ImageIcon } from "~/components/icons";
import { cn } from "~/lib/utils";
import { FileBrandLogo, type FileBrandLogoName } from "./file-brand-logos";

type FileTypeIconName =
  | "document"
  | "file"
  | "image"
  | "json"
  | "markdown"
  | "pdf"
  | "presentation"
  | "spreadsheet"
  | "text"
  | "xml"
  | "yaml";

interface FileType {
  readonly icon: typeof File;
  readonly label: string;
  readonly name: FileTypeIconName;
  readonly className: string;
  readonly logo?: FileBrandLogoName;
}

const TYPES: Record<FileTypeIconName, FileType> = {
  pdf: { icon: File, label: "PDF", name: "pdf", className: "", logo: "pdf" },
  document: {
    icon: File,
    label: "Document",
    name: "document",
    className: "",
    logo: "document",
  },
  spreadsheet: {
    icon: File,
    label: "Spreadsheet",
    name: "spreadsheet",
    className: "",
    logo: "spreadsheet",
  },
  presentation: {
    icon: File,
    label: "Presentation",
    name: "presentation",
    className: "",
    logo: "presentation",
  },
  json: {
    icon: File,
    label: "JSON",
    name: "json",
    className: "",
    logo: "json",
  },
  markdown: {
    icon: File,
    label: "Markdown",
    name: "markdown",
    className: "",
    logo: "markdown",
  },
  yaml: {
    icon: File,
    label: "YAML",
    name: "yaml",
    className: "",
    logo: "yaml",
  },
  xml: {
    icon: File,
    label: "XML",
    name: "xml",
    className: "",
    logo: "xml",
  },
  image: {
    icon: ImageIcon,
    label: "Image",
    name: "image",
    className: "text-violet-600 dark:text-violet-400",
  },
  text: {
    icon: FileText,
    label: "Text",
    name: "text",
    className: "text-muted-foreground",
  },
  file: { icon: File, label: "File", name: "file", className: "text-muted-foreground" },
};

function extension(filename: string): string {
  return filename.toLowerCase().split(".").pop() ?? "";
}

function fileType(input: { readonly mediaType: string; readonly filename: string }): FileType {
  const mediaType = input.mediaType.toLowerCase().split(";")[0]?.trim() ?? "";
  const ext = extension(input.filename);

  if (mediaType === "application/pdf" || ext === "pdf") return TYPES.pdf;
  if (mediaType.startsWith("image/")) return TYPES.image;
  if (
    mediaType.includes("presentation") ||
    mediaType === "application/vnd.ms-powerpoint" ||
    ["ppt", "pptx", "odp"].includes(ext)
  ) {
    return TYPES.presentation;
  }
  if (
    mediaType.includes("spreadsheet") ||
    mediaType === "application/vnd.ms-excel" ||
    mediaType === "text/csv" ||
    ["csv", "xls", "xlsx", "ods"].includes(ext)
  ) {
    return TYPES.spreadsheet;
  }
  if (
    mediaType.includes("wordprocessingml") ||
    mediaType === "application/msword" ||
    ["doc", "docx", "odt"].includes(ext)
  ) {
    return TYPES.document;
  }
  if (mediaType === "application/json" || mediaType.endsWith("+json") || ext === "json") {
    return TYPES.json;
  }
  if (mediaType === "text/markdown" || ["md", "mdx", "markdown"].includes(ext)) {
    return TYPES.markdown;
  }
  if (
    ["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml"].includes(mediaType) ||
    ["yaml", "yml"].includes(ext)
  ) {
    return TYPES.yaml;
  }
  if (
    mediaType === "application/xml" ||
    mediaType === "text/xml" ||
    mediaType.endsWith("+xml") ||
    ext === "xml"
  ) {
    return TYPES.xml;
  }
  if (mediaType.startsWith("text/") || ext === "txt") return TYPES.text;
  return TYPES.file;
}

export function fileTypeIconName(input: {
  readonly mediaType: string;
  readonly filename: string;
}): FileTypeIconName {
  return fileType(input).name;
}

export function fileTypeLabel(input: {
  readonly mediaType: string;
  readonly filename: string;
}): string {
  return fileType(input).label;
}

export function FileTypeIcon({
  mediaType,
  filename,
  className,
  ...props
}: {
  readonly mediaType: string;
  readonly filename: string;
} & Omit<ComponentProps<typeof File>, "children">) {
  const type = fileType({ mediaType, filename });
  const sharedProps = {
    ...props,
    className: cn("size-4 shrink-0", type.className, className),
    "aria-label": props["aria-label"] ?? `${type.label} file`,
  };
  if (type.logo) return <FileBrandLogo {...sharedProps} name={type.logo} />;
  const Icon = type.icon;
  return <Icon {...sharedProps} />;
}
