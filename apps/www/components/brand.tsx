import Image from "next/image";

export function TulipMark({ size = 32 }: { size?: number }) {
  return <Image src="/logo-128.png" width={size} height={size} alt="" aria-hidden="true" />;
}

export function Brand() {
  return (
    <a className="brand" href="/" aria-label="TulipFarm home">
      <TulipMark />
      <span>TulipFarm</span>
    </a>
  );
}
