import Script from "next/script";

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="imsda-embed-layout" data-imsda-embed-root>
        {children}
      </div>
      <Script src="/embed/embed.js" strategy="afterInteractive" />
    </>
  );
}
