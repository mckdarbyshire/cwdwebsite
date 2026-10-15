// The weekly webinar email: table layout and inline styles so it renders in Outlook.
import { escapeHtml as e, MAGIC_TTL_DAYS, type Webinar } from "./core.mts";

const NAVY = "#1C3E4D", TEAL = "#1E707A", BODY = "#3E5560", MUTED = "#6B7B81", LIGHT = "#F4F8F8", LINE = "#D5E3E6";
const FONT = "Calibri, Arial, Helvetica, sans-serif";

function fmtWeek(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function weeklySubject(w: Webinar): string {
  return `This week's webinar: ${w.title}`;
}

export function weeklyEmailHtml(opts: { w: Webinar; firstName: string; links: { watch: string; pdf?: string; ask: string }; test?: boolean }): string {
  const { w, firstName, links } = opts;
  const topics = (w.topics || []).map((t) =>
    `<tr><td valign="top" style="padding:0 10px 6px 0;color:${TEAL};font:700 16px ${FONT}">&#8226;</td><td style="padding:0 0 6px 0;color:${BODY};font:15px/1.45 ${FONT}">${e(t)}</td></tr>`).join("");
  const pdfRow = links.pdf
    ? `<tr><td style="padding:0 0 10px 0;font:15px/1.45 ${FONT}"><a href="${e(links.pdf)}" style="color:${TEAL};font-weight:700;text-decoration:none">Download This week in 10 minutes (PDF) &#8250;</a></td></tr>` : "";
  const testBanner = opts.test
    ? `<tr><td style="padding:10px 24px;background:#FFF4D6;color:#7A5A00;font:13px ${FONT}">Test send: the links in this copy open the normal sign-in page rather than signing anyone in.</td></tr>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(w.title)}</title></head>
<body style="margin:0;padding:0;background:${LIGHT}">
<div style="display:none;max-height:0;overflow:hidden">${e(w.summary || w.title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${LIGHT}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border:1px solid ${LINE};border-radius:12px">
${testBanner}
<tr><td style="background:${NAVY};padding:22px 28px;border-radius:12px 12px 0 0">
  <div style="color:#AED2DA;font:700 12px ${FONT};letter-spacing:2px;text-transform:uppercase">CWD Research Consulting &#183; Weekly Markets Webinar</div>
  <div style="color:#F4F8F8;font:14px ${FONT};padding-top:6px">Week of ${e(fmtWeek(w.weekOf))}</div>
</td></tr>
<tr><td style="padding:28px 28px 8px 28px">
  <div style="color:${BODY};font:15px/1.5 ${FONT};padding-bottom:14px">Dear ${e(firstName)},</div>
  <div style="color:${NAVY};font:700 24px/1.25 Cambria, Georgia, serif;padding-bottom:12px">${e(w.title)}</div>
  ${w.summary ? `<div style="color:${BODY};font:15px/1.55 ${FONT};padding-bottom:14px">${e(w.summary)}</div>` : ""}
  ${topics ? `<table role="presentation" cellpadding="0" cellspacing="0" style="padding-bottom:8px">${topics}</table>` : ""}
</td></tr>
<tr><td style="padding:8px 28px 22px 28px">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${TEAL};border-radius:8px">
    <a href="${e(links.watch)}" style="display:inline-block;padding:13px 26px 13px 16px;color:#FFFFFF;font:700 16px/24px ${FONT};text-decoration:none"><span style="display:inline-block;width:24px;height:24px;border-radius:12px;background:#FFFFFF;color:${TEAL};font:9px/24px Arial, Helvetica, sans-serif;text-align:center;vertical-align:middle;text-indent:2px;mso-line-height-rule:exactly">&#9654;&#65038;</span><span style="display:inline-block;vertical-align:middle;padding-left:12px">Watch this week's webinar</span></a>
  </td></tr></table>
  <div style="color:${MUTED};font:13px ${FONT};padding-top:10px">One click, no password needed. You can also browse every past session.</div>
</td></tr>
<tr><td style="padding:0 28px 6px 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${LINE}"><tr><td style="padding-top:18px"></td></tr>
  ${pdfRow}
  <tr><td style="padding:0 0 10px 0;font:15px/1.45 ${FONT}"><a href="${e(links.ask)}" style="color:${TEAL};font-weight:700;text-decoration:none">Ask a question or make a request &#8250;</a>
  <div style="color:${BODY};font:14px/1.5 ${FONT};padding-top:4px">Anything you would like explained, a topic for next week, or an ad hoc piece of work. You can also simply reply to this email.</div></td></tr>
</table></td></tr>
<tr><td style="padding:18px 28px 26px 28px;color:${BODY};font:15px/1.5 ${FONT}">Best wishes,<br>Michael<br><span style="color:${MUTED}">CWD Research Consulting</span></td></tr>
<tr><td style="padding:16px 28px 22px 28px;background:${LIGHT};border-radius:0 0 12px 12px;color:${MUTED};font:12px/1.5 ${FONT}">
  These links are personal to you and work for ${MAGIC_TTL_DAYS} days, so please do not forward this email. Colleagues at your firm can be given their own access: just reply and ask.<br><br>
  For professional investors only. The Weekly Markets Webinar is general market commentary, not a personal recommendation or investment advice.
</td></tr>
</table></td></tr></table></body></html>`;
}
