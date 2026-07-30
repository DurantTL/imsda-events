import { EMBED_HOST_SCRIPT } from "@/modules/forms/embed-scripts";

export const dynamic = "force-static";

export function GET() {
  return new Response(`${EMBED_HOST_SCRIPT}\n`, {
    headers: {
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      "Content-Type": "application/javascript; charset=utf-8",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
