const isProd = process.env.NODE_ENV === "production";

// Everything the browser loads is same-origin (no CDNs, fonts are self-hosted),
// except OpenStreetMap tiles for the location picker.
// 'unsafe-inline' is required for Next's inline flight-data scripts, the theme
// bootstrap script in the layout and React style attributes.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tile.openstreetmap.org", // map tiles (Kontrolle eintragen)
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  // HTTPS-only site (Apache redirects :80). No includeSubDomains on purpose.
  { key: "Strict-Transport-Security", value: "max-age=15552000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // better-sqlite3 and db-vendo-client are server-only native/CJS deps.
  serverExternalPackages: ["better-sqlite3", "db-vendo-client", "mailparser", "unpdf", "imapflow", "mailauth"],
  // Screenshot/receipt uploads pass the auth proxy, which buffers bodies (default 10 MB).
  experimental: { proxyClientMaxBodySize: "25mb" },
  async headers() {
    // Dev server needs eval/websockets for HMR — only harden production.
    return isProd ? [{ source: "/:path*", headers: securityHeaders }] : [];
  },
};

export default nextConfig;
