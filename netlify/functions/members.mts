// Subscriber-only webinar library: the catalogue and signed playback links.
import type { Config, Context } from "@netlify/functions";
import {
  getCatalogue,
  handleError,
  HttpError,
  json,
  requireMember,
  saveCatalogue,
  saveUser,
  str,
  type Webinar,
} from "../lib/core.mts";
import { getVideo, signedEmbedUrl } from "../lib/bunny.mts";

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
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const url = new URL(req.url);
    const action = url.pathname.replace(/^\/api\/members\/?/, "");
    const { user } = await requireMember(req);

    if (action === "webinars") {
      const published = await clientVisible();
      const items = published.map((w) => ({
        id: w.id,
        title: w.title,
        weekOf: w.weekOf,
        summary: w.summary,
        topics: w.topics,
        lengthSec: w.lengthSec ?? null,
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

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return handleError(err);
  }
};

export const config: Config = {
  path: ["/api/members/webinars", "/api/members/play"],
};
