import { beforeAll, describe, expect, it } from "vitest";
import { ensureReady } from "@/lib/bootstrap";
import { addMailAccount, forgetMailAccount, getMailConfig, getMailStatus, hasMailPassword, listMailAccounts, resetMailSeen, setMailConfig } from "@/lib/trips/mailSync";
import { setSetting } from "@/lib/repo/settings";

beforeAll(() => ensureReady());

describe("mehrere Postfächer", () => {
  it("hält Zugang, Stand und Fortschritt je Postfach getrennt", () => {
    setMailConfig({ host: "imap.example.org", user: "erika@example.org", folder: "INBOX", enabled: true });
    const id = addMailAccount();
    expect(listMailAccounts()).toEqual(["", id]);
    setMailConfig({ host: "imap.example.net", user: "antraege@example.net", folder: "Bahn", enabled: true, password: "geheim" }, id);
    expect(getMailConfig().user).toBe("erika@example.org");
    expect(getMailConfig(id)).toMatchObject({ user: "antraege@example.net", folder: "Bahn" });
    expect(hasMailPassword(id)).toBe(true);
    // progress (seen UIDs) belongs to one mailbox only
    setSetting(`mail:status:${id}`, { ...getMailStatus(id), seen: [5, 6] });
    expect(getMailStatus().seen).not.toContain(6);
    resetMailSeen(id);
    expect(getMailStatus(id).seen).toEqual([]);
    // a further mailbox is removed altogether, the first one only loses its access data
    forgetMailAccount(id);
    expect(listMailAccounts()).toEqual([""]);
    expect(hasMailPassword(id)).toBe(false);
    expect(() => setMailConfig({ user: "x@example.org" }, id)).toThrow(/unbekannt/);
    expect(getMailConfig().user).toBe("erika@example.org");
  });
});
