/**
 * Where to go after login (`/login?next=…`). Only same-site paths are allowed:
 * "/x?y" yes — "https://evil", "//evil", "/\evil" or "/\t/evil" (browsers drop
 * tabs/newlines → "//evil") no. Resolving against a dummy origin catches every
 * spelling that would leave the site; anything odd falls back to "/".
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/")) return "/";
  try {
    const base = "http://same.invalid";
    const u = new URL(raw, base);
    if (u.origin !== base) return "/";
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return "/";
  }
}
