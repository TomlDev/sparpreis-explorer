/**
 * Next.js start hook: run the background jobs (live tracking, mail sync, DB
 * account sync, open-data actuals) as soon as the server is up — not only once
 * the first page is requested (after a deploy the live tracking stood still
 * until someone opened the app).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureReady } = await import("@/lib/bootstrap");
  ensureReady();
}
