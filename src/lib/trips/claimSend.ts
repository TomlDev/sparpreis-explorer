import nodemailer from "nodemailer";
import { mailLogin } from "./mailSync";

/**
 * The filled-in passenger-rights form by e-mail to DB. DB takes claims by mail at
 * this address (bahn.de FAQ "EU-Formular": PDF attachments); it's sent from the
 * mailbox the app reads, with the claimant as Reply-To and in CC (their copy).
 */
export const CLAIM_MAIL_TO = "EUAntragFGR@deutschebahn.com";

export interface ClaimMail {
  subject: string;
  text: string;
  pdf: { name: string; bytes: Buffer };
  /** claimant's address: Reply-To and CC */
  replyTo: string;
  fromName: string;
}

function transport() {
  const login = mailLogin();
  if (!login) throw new Error("Zum Senden fehlt ein Postfach – in den Einstellungen unter „Mail“ eintragen.");
  return {
    from: login.user,
    t: nodemailer.createTransport({
      host: login.host,
      port: 465,
      secure: true,
      auth: { user: login.user, pass: login.pass },
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    }),
  };
}

/** Can the app send mail (login at the SMTP server, nothing sent)? */
export async function verifyClaimMail(): Promise<void> {
  const { t } = transport();
  await t.verify();
}

export async function sendClaimMail(m: ClaimMail): Promise<{ messageId: string; from: string }> {
  const { t, from } = transport();
  const info = await t.sendMail({
    from: { name: m.fromName, address: from },
    to: CLAIM_MAIL_TO,
    cc: m.replyTo,
    replyTo: m.replyTo,
    subject: m.subject,
    text: m.text,
    attachments: [{ filename: m.pdf.name, content: m.pdf.bytes, contentType: "application/pdf" }],
  });
  if (info.rejected?.length) throw new Error(`Mailserver hat abgelehnt: ${info.rejected.join(", ")}`);
  return { messageId: info.messageId, from };
}
