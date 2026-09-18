import {
  ArrowUpRight,
  Code2,
  FileText,
  type Icon,
  Laptop,
  MessageCircle,
  Radio,
} from "~/components/icons";
import type { PackSummary } from "~/lib/packs";

export const PACK_CATEGORY_STYLE = {
  Sales: { icon: ArrowUpRight, ink: "text-data-4", background: "bg-data-4/10" },
  "IT Ops": { icon: Laptop, ink: "text-data-3", background: "bg-data-3/10" },
  Marketing: { icon: Radio, ink: "text-data-6", background: "bg-data-6/10" },
  "Document Ops": { icon: FileText, ink: "text-data-5", background: "bg-data-5/10" },
  Support: { icon: MessageCircle, ink: "text-data-2", background: "bg-data-2/10" },
  Engineering: { icon: Code2, ink: "text-data-1", background: "bg-data-1/10" },
} satisfies Record<PackSummary["category"], { icon: Icon; ink: string; background: string }>;

export function PackCategoryIcon({
  category,
  className,
}: {
  category: PackSummary["category"];
  className?: string;
}) {
  const Icon = PACK_CATEGORY_STYLE[category].icon;
  return <Icon className={className} aria-hidden />;
}
