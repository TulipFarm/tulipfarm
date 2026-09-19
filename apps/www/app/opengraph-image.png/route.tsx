import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { SITE_URL, siteDescription, siteHeadline } from "@/lib/site";

export const dynamic = "force-static";

export async function GET() {
  const logo = await readFile(join(process.cwd(), "public/logo-128.png"));
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        width: "100%",
        height: "100%",
        padding: "58px 72px",
        background: "#ffffff",
        color: "#23252a",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 30 }}>
        {/* biome-ignore lint/performance/noImgElement: Static ImageResponse requires a native image. */}
        <img
          src={`data:image/png;base64,${logo.toString("base64")}`}
          width={52}
          height={52}
          alt=""
        />
        <span>TulipFarm</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div
          style={{
            display: "flex",
            maxWidth: 650,
            fontSize: 88,
            lineHeight: 1.03,
            letterSpacing: -4,
          }}
        >
          {siteHeadline}
        </div>
        <div
          style={{
            display: "flex",
            maxWidth: 920,
            fontSize: 24,
            lineHeight: 1.5,
            color: "#666c75",
          }}
        >
          {siteDescription}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 22,
        }}
      >
        <span style={{ color: "#666c75" }}>{new URL(SITE_URL).hostname}</span>
        <div
          style={{
            display: "flex",
            padding: "16px 28px",
            borderRadius: 10,
            background: "#b93150",
            color: "#ffffff",
          }}
        >
          Start building
        </div>
      </div>
    </div>,
    { width: 1200, height: 630 }
  );
}
