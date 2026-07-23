import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV === "development";
const embedAllowedOrigins = process.env.EMBED_ALLOWED_ORIGINS
  ?? "'self' https://imsda.org https://www.imsda.org";
const squareProductionEnabled = process.env.SQUARE_ENVIRONMENT === "production"
  && process.env.SQUARE_ENABLE_PRODUCTION === "true";
const squareWebOrigin = squareProductionEnabled
  ? "https://web.squarecdn.com"
  : "https://sandbox.web.squarecdn.com";
const squarePciOrigin = squareProductionEnabled
  ? "https://pci-connect.squareup.com"
  : "https://pci-connect.squareupsandbox.com";
const squareTelemetryOrigin = "https://o160250.ingest.sentry.io";
const squareFontOrigins = [
  "https://square-fonts-production-f.squarecdn.com",
  "https://d1g145x70srn7h.cloudfront.net",
].join(" ");

function contentSecurityPolicy(frameAncestors: string) {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${squareWebOrigin}${isDevelopment ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'unsafe-inline' ${squareWebOrigin}`,
    "img-src 'self' blob: data:",
    `font-src 'self' data: ${squareFontOrigins}`,
    `connect-src 'self' ${squareWebOrigin} ${squarePciOrigin} ${squareTelemetryOrigin}`,
    `frame-src 'self' ${squareWebOrigin}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

const sharedSecurityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy("'none'"),
  },
];

const privateRegistrationHeaders = [
  { key: "Cache-Control", value: "private, no-store, max-age=0" },
  { key: "Pragma", value: "no-cache" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          ...sharedSecurityHeaders,
          ...(process.env.NODE_ENV === "production"
            ? [{
                key: "Strict-Transport-Security",
                value: "max-age=31536000; includeSubDomains",
              }]
            : []),
        ],
      },
      {
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        source: "/embed/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: contentSecurityPolicy(embedAllowedOrigins),
          },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        source: "/manage/:path*",
        headers: privateRegistrationHeaders,
      },
      {
        source: "/api/public/manage/:path*",
        headers: privateRegistrationHeaders,
      },
      {
        source: "/check-in",
        headers: [
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=(), browsing-topics=()",
          },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
};

export default nextConfig;
