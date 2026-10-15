// Subscriber-only webinar library: the catalogue, signed playback links and
// each week's "This week in 10 minutes" PDF.
import type { Config, Context } from "@netlify/functions";
import {
  db,
  env,
  escapeHtml,
  getCatalogue,
  handleError,
  HttpError,
  json,
  pdfDownloadName,
  pdfKey,
  pdfResponse,
  randomToken,
  rateLimit,
  readJson,
  REQUEST_KINDS,
  requestKey,
  listRequests,
  type ClientRequest,
  type RequestKind,
  requireMember,
  saveCatalogue,
  saveUser,
  str,
  type Webinar,
} from "../lib/core.mts";
import { getVideo, signedEmbedUrl } from "../lib/bunny.mts";
import { mailReady, sendMail } from "../lib/mail.mts";

const KIND_LABEL: Record<RequestKind, string> = { question: "Question", topic: "Topic for a future webinar", adhoc: "Ad hoc request" };

// What a subscriber sees of their own requests (never the internal note).
const clientView = (r: ClientRequest) => ({
  id: r.id, kind: r.kind, webinarId: r.webinarId || null, webinarTitle: r.webinarTitle || null,
  message: r.message, status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt,
});

// Published webinars only reach clients once Bunny has finished processing
// them. Anything still pending is checked against Bunny (rarely more than one).
async function clientVisible(): Promise<Webinar[]> {
  const catalogue = await getCatalogue();
  let changed = false;
  for (const w of catalogue.filter((x) => x.published && !x.ready).slice(0, 5)) {
    try {
      const v = await getVideo(w.id);
      if (v.status === 4) {
        w.ready = true;
        if (v.length) w.lengthSec = v.length;
        changed = true;
      }
    } catch {
      // Video service unavailable: leave it pending and try again next time.
    }
  }
  if (changed) await saveCatalogue(catalogue);
  return catalogue.filter((w) => w.published && w.ready);
}

export default async (req: Request, _context: Context) => {
  try {
    const url = new URL(req.url);
    const action = url.pathname.replace(/^\/api\/members\/?/, "");
    const { user } = await requireMember(req);

    if (action === "requests" && req.method === "POST") {
      const body = await readJson(req);
      await rateLimit("request-user", user.id, 15, 60 * 60);
      const kind = str(body.kind, 20) as RequestKind;
      if (!REQUEST_KINDS.includes(kind)) throw new HttpError(400, "Please choose what kind of request this is.");
      const message = str(body.message, 4000);
      if (message.length < 3) throw new HttpError(400, "Please write your question or request.");
      const wid = str(body.webinarId, 64);
      const webinar = wid ? (await getCatalogue()).find((w) => w.id === wid && w.published) : undefined;
      const now = new Date().toISOString();
      const r: ClientRequest = {
        id: `${now.slice(0, 10)}-${randomToken(8)}`, uid: user.id, name: user.name, firm: user.firm, email: user.email,
        kind, webinarId: webinar?.id, webinarTitle: webinar?.title, message, status: "new", createdAt: now, updatedAt: now,
      };
      await db().setJSON(requestKey(r.id), r);
      if (mailReady()) {
        // Best effort: a failed alert must not lose the request.
        const to = env("REQUEST_ALERT_TO") || env("MAIL_FROM")!;
        await sendMail({
          to, saveToSentItems: false,
          subject: `New ${KIND_LABEL[kind].toLowerCase()} from ${user.name} (${user.firm})`,
          html: `<div style="font:15px/1.5 Calibri,Arial,sans-serif;color:#1C3E4D"><p><b>${escapeHtml(KIND_LABEL[kind])}</b> from ${escapeHtml(user.name)}, ${escapeHtml(user.firm)} (${escapeHtml(user.email)})${webinar ? `<br>About: ${escapeHtml(webinar.title)}` : ""}</p><p style="white-space:pre-wrap;border-left:3px solid #1E707A;padding-left:12px">${escapeHtml(message)}</p><p>Manage it in the webinar console under Requests.</p></div>`,
        }).catch((err) => console.error("request alert failed", err));
      }
      return json({ request: clientView(r) }, 201);
    }

    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

    if (action === "requests") {
      const mine = (await listRequests()).filter((r) => r.uid === user.id).map(clientView);
      return json({ requests: mine });
    }

    if (action === "webinars") {
      const published = await clientVisible();
      const items = published.map((w) => ({
        id: w.id,
        title: w.title,
        weekOf: w.weekOf,
        summary: w.summary,
        topics: w.topics,
        lengthSec: w.lengthSec ?? null,
        hasPdf: !!w.pdf,
      }));
      const watched = new Set((user.views || []).map((v) => v.id));
      return json({
        user: { name: user.name, firm: user.firm, email: user.email },
        webinars: items.map((w) => ({ ...w, watched: watched.has(w.id) })),
      });
    }

    if (action === "play") {
      const id = str(url.searchParams.get("id"), 64);
      const webinar = (await getCatalogue()).find((w) => w.id === id && w.published && w.ready);
      if (!webinar) throw new HttpError(404, "That webinar is not available.");
      const signed = signedEmbedUrl(webinar.id);
      user.views = [...(user.views || []), { id: webinar.id, at: new Date().toISOString() }].slice(-200);
      await saveUser(user);
      return json({ embedUrl: signed.url, expiresAt: signed.expiresAt, title: webinar.title });
    }

    if (action === "pdf") {
      const id = str(url.searchParams.get("id"), 64);
      const webinar = (await getCatalogue()).find((w) => w.id === id && w.published && w.ready && w.pdf);
      if (!webinar) throw new HttpError(404, "That summary is not available.");
      const bytes = (await db().get(pdfKey(webinar.id), { type: "arrayBuffer" })) as ArrayBuffer | null;
      if (!bytes) throw new HttpError(404, "That summary is not available.");
      user.downloads = [...(user.downloads || []), { id: webinar.id, at: new Date().toISOString() }].slice(-200);
      await saveUser(user);
      return pdfResponse(bytes, pdfDownloadName(webinar), "attachment");
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return handleError(err);
  }
};

export const config: Config = {
  path: ["/api/members/webinars", "/api/members/play", "/api/members/pdf", "/api/members/requests"],
};
