import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sparpreis-Explorer",
    short_name: "Sparpreis",
    description: "Günstige DB-Tickets finden und Bahnfahrten festhalten.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#EC0016",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
