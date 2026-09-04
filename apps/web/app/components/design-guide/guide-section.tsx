import type { ReactNode } from "react";

type GuideSectionProps = {
  id: string;
  title: string;
  description: string;
  children?: ReactNode;
};

export function GuideSection({ id, title, description, children }: GuideSectionProps) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-20 border-b border-border py-8"
    >
      <div className="mb-5 max-w-2xl">
        <h2 id={`${id}-title`} className="text-xl font-semibold">
          {title}
        </h2>
        <p className="mt-1 text-base text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}
