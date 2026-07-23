import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
  return {
    rules: {
      userAgent: "*",
      allow: ["/events/"],
      disallow: [
        "/api/",
        "/check-in",
        "/communications",
        "/embed/",
        "/event-setup",
        "/finance",
        "/forgot-password",
        "/imports",
        "/login",
        "/more",
        "/no-access",
        "/overview",
        "/people",
        "/register/",
        "/registration-builder",
        "/reset-password",
        "/staff",
      ],
    },
    sitemap: `${baseUrl.replace(/\/$/, "")}/sitemap.xml`,
  };
}
