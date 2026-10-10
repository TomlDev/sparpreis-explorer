import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { bahnDeLink, viaPlan, type DbLinkVia } from "@/lib/dbLink";
import { resolveRichId } from "@/lib/rail/proforma";
import { getPreferences } from "@/lib/repo/settings";

export const runtime = "nodejs";

/**
 * "Bei DB prüfen": resolve the bahn.de station ids (bahn.de finds nothing for
 * bare names), add the Zwischenhalte of pro-forma / via-priced results and the
 * user's BahnCard / class, then redirect.
 */
export async function GET(req: Request) {
  ensureReady();
  const q = new URL(req.url).searchParams;
  const from = (q.get("from") ?? "").slice(0, 200);
  const to = (q.get("to") ?? "").slice(0, 200);
  const dep = q.get("dep");
  if (!from || !to) return NextResponse.json({ error: "from/to fehlt" }, { status: 400 });
  const ids = async (name: string) => {
    try {
      const rich = await resolveRichId(name);
      const eva = rich?.match(/@L=(\d+)@/)?.[1];
      return rich && eva ? { soid: rich, soei: eva } : undefined;
    } catch {
      return undefined;
    }
  };
  const [origin, dest] = await Promise.all([ids(from), ids(to)]);
  const when = dep && !Number.isNaN(Date.parse(dep)) ? dep : null;
  // The Fernverkehr section the app priced → Zwischenhalte (+ products per section).
  const fvFrom = q.get("fvFrom");
  const fvTo = q.get("fvTo");
  const plan = viaPlan(q.get("kind") ?? "", fvFrom && fvTo ? { fromName: fvFrom.slice(0, 200), toName: fvTo.slice(0, 200) } : null, from, to);
  let vias: DbLinkVia[] | undefined;
  if (plan) {
    const resolved = await Promise.all(plan.vias.map(async (v) => ({ ...v, lid: (await ids(v.name))?.soid })));
    // a Zwischenhalt bahn.de can't resolve would break the search — then without vias
    if (resolved.every((v) => v.lid)) vias = resolved.map((v) => ({ ...v, lid: v.lid! }));
  }
  const prefs = getPreferences();
  const traveller = { bahncard: prefs.bahncard, klasse: prefs.klasse, deutschlandTicket: prefs.deutschlandTicket };
  const first = vias || (plan && !plan.vias.length) ? plan!.firstProducts : undefined;
  return NextResponse.redirect(bahnDeLink(from, to, when, { origin, dest }, { ...(vias ? { vias } : {}), firstProducts: first, traveller }), 302);
}
