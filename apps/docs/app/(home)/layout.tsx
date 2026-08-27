import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/lib/layout.shared";

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <HomeLayout
      {...baseOptions()}
      links={[
        {
          text: "docs",
          url: "/docs",
        },
        {
          text: "deploy",
          url: "/deploy",
        },
        {
          text: <span className="font-medium text-fd-primary">install</span>,
          url: "/#install",
        },
      ]}
    >
      {children}
    </HomeLayout>
  );
}
