// CWD staff console API: manage client accounts and the webinar library.
import type { Config, Context } from "@netlify/functions";
import {
  assertSameOrigin,
  clearAdminCookie,
  createInvite,
  createMagicLink,
  type ClientRequest,
  listRequests,
  REQUEST_STATUSES,
  requestKey,
  type RequestStatus,
  siteUrl,
  db,
  emailKey,
  env,
  getCatalogue,
  getUser,
  getUserByEmail,
  handleError,
  HttpError,
  isAdmin,
  isEmail,
  json,
  listUsers,
  normEmail,
  PDF_MAX_BYTES,
  pdfDownloadName,
  pdfKey,
  pdfResponse,
  randomToken,
  rateLimit,
  readJson,
  requireAdmin,
  requireEnv,
  safeEqual,
  saveCatalogue,
  saveUser,
  startAdminSession,
  str,
  type User,
  userKey,
  type Webinar,
} from "../lib/core.mts";
import {
  bunnyConfigured,
  createVideo,
  deleteVideo,
  isGuid,
  listVideos,
  signedEmbedUrl,
  STATUS_LABEL,
  uploadCredentials,
} from "../lib/bunny.mts";
import { mailConfigured, mailReady, sendMail } from "../lib/mail.mts";
import { weeklyEmailHtml, weeklySubject } from "../lib/weekly-email.mts";

const now = () => new Date().toISOString();

function adminUserView(u: User) {
  const lastView = (u.views || []).at(-1);
  const ips = new Set((u.logins || []).filter((l) => Date.now() - Date.parse(l.at) < 30 * 864e5).map((l) => l.ip));
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    firm: u.firm,
    active: u.active,
    passwordSet: !!u.passwordHash,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
    activeSessions: (u.sessions || []).length,
    distinctIps30d: ips.size,
    views: (u.views || []).length,
    lastViewedAt: lastView?.at || null,
    lastViewedId: lastView?.id || null,
    pdfDownloads: (u.downloads || []).length,
  };
}

function webinarInput(body: Record<string, unknown>) {
  const title = str(body.title, 200);
  const weekOf = str(body.weekOf, 10);
  if (!title) throw new HttpError(400, "A title is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) throw new HttpError(400, "Please give the week date.");
  const topics = Array.isArray(body.topics)
    ? body.topics.map((t) => str(t, 200)).filter(Boolean).slice(0, 8)
    : str(body.topics, 2000).split("\n").map((t) => t.trim()).filter(Boolean).slice(0, 8);
  return {
    title,
    weekOf,
    summary: str(body.summary, 3000),
    topics,
    published: body.published !== false,
  };
}

export default async (req: Request, context: Context) => {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/api\/admin\/?/, "").split("/").filter(Boolean);
    const [resource, id, sub] = parts;
    const m = req.method;

    // ------------------------------------------------ admin session
    if (resource === "login" && m === "POST") {
      const body = await readJson<{ password?: string }>(req);
      await rateLimit("admin-login", context.ip || "unknown", 10, 15 * 60);
      const expected = requireEnv("ADMIN_PASSWORD");
      requireEnv("SESSION_SECRET");
      if (!safeEqual(String(body.password || ""), expected)) throw new HttpError(401, "Password not recognised.");
      return json({ ok: true }, 200, { "Set-Cookie": startAdminSession(req) });
    }
    if (resource === "logout" && m === "POST") {
      await readJson(req).catch(() => ({}));
      return json({ ok: true }, 200, { "Set-Cookie": clearAdminCookie(req) });
    }
    if (resource === "me" && m === "GET") {
      return isAdmin(req) ? json({ admin: true }) : json({ admin: false }, 401);
    }

    requireAdmin(req);

    // ------------------------------------------------ setup status
    if (resource === "status" && m === "GET") {
      return json({
        bunny: bunnyConfigured(),
        siteUrl: env("SITE_URL") || null,
        maxSessionsPerUser: Number(env("MAX_SESSIONS_PER_USER") || 3),
        mail: mailConfigured(),
      });
    }

    // ------------------------------------------------ clients
    if (resource === "users") {
      if (!id && m === "GET") {
        const users = (await listUsers()).map(adminUserView);
        users.sort((a, b) => a.firm.localeCompare(b.firm) || a.name.localeCompare(b.name));
        return json({ users });
      }
      if (!id && m === "POST") {
        const body = await readJson(req);
        const email = normEmail(str(body.email, 254));
        const name = str(body.name, 120);
        const firm = str(body.firm, 120);
        if (!isEmail(email)) throw new HttpError(400, "Please enter a valid email address.");
        if (!name || !firm) throw new HttpError(400, "Name and firm are required.");
        if (await getUserByEmail(email)) throw new HttpError(409, "A client with that email already exists.");
        const user: User = {
          id: randomToken(12),
          email,
          name,
          firm,
          active: true,
          createdAt: now(),
          sessions: [],
          logins: [],
          views: [],
        };
        await saveUser(user);
        await db().set(emailKey(email), user.id);
        const invite = await createInvite(user, req);
        return json({ user: adminUserView(user), invite }, 201);
      }

      const user = id ? await getUser(id) : null;
      if (!user) throw new HttpError(404, "Client not found.");

      if (!sub && m === "PATCH") {
        const body = await readJson(req);
        if (body.name !== undefined) user.name = str(body.name, 120) || user.name;
        if (body.firm !== undefined) user.firm = str(body.firm, 120) || user.firm;
        if (body.active !== undefined) {
          user.active = body.active === true;
          if (!user.active) user.sessions = [];
        }
        await saveUser(user);
        return json({ user: adminUserView(user) });
      }
      if (sub === "invite" && m === "POST") {
        await readJson(req).catch(() => ({}));
        return json({ invite: await createInvite(user, req) });
      }
      if (sub === "signout" && m === "POST") {
        await readJson(req).catch(() => ({}));
        user.sessions = [];
        await saveUser(user);
        return json({ user: adminUserView(user) });
      }
      if (!sub && m === "DELETE") {
        const store = db();
        await store.delete(userKey(user.id));
        await store.delete(emailKey(user.email));
        return json({ ok: true });
      }
    }

    if (resource === "firms" && id === "status" && m === "POST") {
      const body = await readJson(req);
      const firm = str(body.firm, 120);
      const active = body.active === true;
      const users = (await listUsers()).filter((u) => u.firm === firm);
      if (!users.length) throw new HttpError(404, "No clients found for that firm.");
      for (const u of users) {
        u.active = active;
        if (!active) u.sessions = [];
        await saveUser(u);
      }
      return json({ updated: users.length });
    }

    // ------------------------------------------------ questions & requests
    if (resource === "requests") {
      if (!id && m === "GET") return json({ requests: await listRequests() });
      const r = id && /^[A-Za-z0-9_-]{8,64}$/.test(id) ? ((await db().get(requestKey(id), { type: "json" })) as ClientRequest | null) : null;
      if (!r) throw new HttpError(404, "Request not found.");
      if (!sub && m === "PATCH") {
        const body = await readJson(req);
        if (body.status !== undefined) {
          const st = str(body.status, 20) as RequestStatus;
          if (!REQUEST_STATUSES.includes(st)) throw new HttpError(400, "Unknown status.");
          r.status = st;
        }
        if (body.note !== undefined) r.note = str(body.note, 4000);
        r.updatedAt = now();
        await db().setJSON(requestKey(r.id), r);
        return json({ request: r });
      }
      if (!sub && m === "DELETE") {
        await db().delete(requestKey(r.id));
        return json({ ok: true });
      }
    }

    // ------------------------------------------------ webinars
    if (resource === "webinars") {
      const catalogue = await getCatalogue();

      if (!id && m === "GET") {
        let bunny: Awaited<ReturnType<typeof listVideos>> = [];
        let bunnyError: string | null = null;
        try {
          bunny = await listVideos();
        } catch (e) {
          bunnyError = e instanceof Error ? e.message : "Video service unavailable.";
        }
        const byId = new Map(bunny.map((v) => [v.guid, v]));
        let changed = false;
        const webinars = catalogue.map((w) => {
          const v = byId.get(w.id);
          if (v?.length && w.lengthSec !== v.length) {
            w.lengthSec = v.length;
            changed = true;
          }
          if (v && (v.status === 4) !== !!w.ready) {
            w.ready = v.status === 4;
            changed = true;
          }
          return {
            ...w,
            videoStatus: v ? STATUS_LABEL[v.status] || `Status ${v.status}` : bunnyError ? "Unknown" : "Missing in Bunny",
            ready: v?.status === 4,
            encodeProgress: v?.encodeProgress ?? null,
          };
        });
        if (changed) await saveCatalogue(catalogue);
        const linked = new Set(catalogue.map((w) => w.id));
        const unlinked = bunny
          .filter((v) => !linked.has(v.guid))
          .map((v) => ({ id: v.guid, title: v.title, dateUploaded: v.dateUploaded, status: STATUS_LABEL[v.status] || `Status ${v.status}` }));
        return json({ webinars, unlinked, bunnyError });
      }

      // New webinar: create the Bunny video and return one-time upload credentials.
      if (!id && m === "POST") {
        const input = webinarInput(await readJson(req));
        const video = await createVideo(`${input.weekOf} | ${input.title}`);
        const w: Webinar = { id: video.guid, ...input, ready: false, createdAt: now(), updatedAt: now() };
        await saveCatalogue([...catalogue, w]);
        return json({ webinar: w, upload: uploadCredentials(video.guid) }, 201);
      }

      // Link a video that was uploaded directly in the Bunny dashboard.
      if (id === "import" && m === "POST") {
        const body = await readJson(req);
        const videoId = str(body.videoId, 64);
        if (!isGuid(videoId)) throw new HttpError(400, "Invalid video ID.");
        if (catalogue.some((w) => w.id === videoId)) throw new HttpError(409, "That video is already in the library.");
        const w: Webinar = { id: videoId, ...webinarInput(body), createdAt: now(), updatedAt: now() };
        await saveCatalogue([...catalogue, w]);
        return json({ webinar: w }, 201);
      }

      const w = catalogue.find((x) => x.id === id);
      if (!w) throw new HttpError(404, "Webinar not found.");

      if (!sub && m === "PATCH") {
        const body = await readJson(req);
        if (body.published !== undefined && Object.keys(body).length === 1) {
          w.published = body.published === true;
        } else {
          Object.assign(w, webinarInput(body));
        }
        w.updatedAt = now();
        await saveCatalogue(catalogue);
        return json({ webinar: w });
      }
      if (sub === "upload" && m === "POST") {
        await readJson(req).catch(() => ({}));
        return json({ upload: uploadCredentials(w.id) });
      }
      if (sub === "play" && m === "GET") {
        return json(signedEmbedUrl(w.id));
      }

      // "This week in 10 minutes" PDF: one per webinar, sent as the raw request body.
      if (sub === "pdf" && m === "PUT") {
        assertSameOrigin(req);
        if (!(req.headers.get("content-type") || "").includes("application/pdf")) {
          throw new HttpError(415, "Please choose a PDF file.");
        }
        const declared = Number(req.headers.get("content-length") || 0);
        if (declared > PDF_MAX_BYTES) throw new HttpError(413, "That PDF is too large (4 MB maximum).");
        const bytes = await req.arrayBuffer();
        if (!bytes.byteLength) throw new HttpError(400, "That file is empty.");
        if (bytes.byteLength > PDF_MAX_BYTES) throw new HttpError(413, "That PDF is too large (4 MB maximum).");
        const head = new TextDecoder().decode(new Uint8Array(bytes.slice(0, 5)));
        if (head !== "%PDF-") throw new HttpError(415, "That file is not a valid PDF.");
        const name = str(decodeURIComponent(req.headers.get("x-file-name") || ""), 200) || pdfDownloadName(w);
        await db().set(pdfKey(w.id), bytes);
        w.pdf = { name, size: bytes.byteLength, uploadedAt: now() };
        w.updatedAt = now();
        await saveCatalogue(catalogue);
        return json({ webinar: w });
      }
      if (sub === "pdf" && m === "GET") {
        const bytes = (await db().get(pdfKey(w.id), { type: "arrayBuffer" })) as ArrayBuffer | null;
        if (!bytes || !w.pdf) throw new HttpError(404, "No PDF attached to this webinar.");
        return pdfResponse(bytes, pdfDownloadName(w), "inline");
      }
      if (sub === "pdf" && m === "DELETE") {
        assertSameOrigin(req);
        await db().delete(pdfKey(w.id));
        delete w.pdf;
        w.updatedAt = now();
        await saveCatalogue(catalogue);
        return json({ webinar: w });
      }

      // Weekly email: the console asks for the recipient list, then sends one
      // email per call, spaced out to stay inside Microsoft 365's 30-a-minute limit.
      if (sub === "email" && m === "POST") {
        const body = await readJson(req);
        const action = str(body.action, 20);
        if (!w.published || !w.ready) throw new HttpError(400, "Publish this webinar and let the video finish processing before emailing it.");
        if (action === "recipients") {
          const users = (await listUsers()).filter((u) => u.active);
          users.sort((a, b) => a.firm.localeCompare(b.firm) || a.name.localeCompare(b.name));
          return json({
            mailReady: mailReady(),
            from: env("MAIL_FROM") || null,
            recipients: users.map((u) => ({ id: u.id, name: u.name, firm: u.firm, email: u.email, sentAt: w.emailLog?.[u.id] || null })),
          });
        }
        const site = siteUrl(req);
        if (action === "test") {
          const to = env("MAIL_FROM");
          if (!to) throw new HttpError(503, "MAIL_FROM is not set in Netlify.");
          const plain = `${site}/members/?w=${encodeURIComponent(w.id)}`;
          await sendMail({
            to, saveToSentItems: false, subject: `[TEST] ${weeklySubject(w)}`,
            html: weeklyEmailHtml({ w, firstName: "Michael", test: true, links: { watch: plain, pdf: w.pdf ? plain : undefined, ask: plain + "#ask" } }),
          });
          return json({ ok: true, to });
        }
        if (action === "send") {
          const u = await getUser(str(body.userId, 64));
          if (!u || !u.active) throw new HttpError(404, "Subscriber not found or not active.");
          const token = await createMagicLink(u, w.id);
          const go = (n: string) => `${site}/members/go.html#t=${token}&n=${n}`;
          await sendMail({
            to: u.email, toName: u.name, subject: weeklySubject(w),
            html: weeklyEmailHtml({ w, firstName: u.name.split(" ")[0] || u.name, links: { watch: go("watch"), pdf: w.pdf ? go("pdf") : undefined, ask: go("ask") } }),
          });
          // re-read so parallel sends don't overwrite each other's log entries
          const fresh = await getCatalogue();
          const fw = fresh.find((x) => x.id === w.id);
          if (fw) { fw.emailLog = { ...(fw.emailLog || {}), [u.id]: now() }; await saveCatalogue(fresh); }
          return json({ ok: true, sentAt: now() });
        }
        throw new HttpError(400, "Unknown email action.");
      }

      if (!sub && m === "DELETE") {
        await db().delete(pdfKey(w.id));
        if (url.searchParams.get("deleteVideo") === "1") await deleteVideo(w.id);
        await saveCatalogue(catalogue.filter((x) => x.id !== w.id));
        return json({ ok: true });
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return handleError(err);
  }
};

export const config: Config = {
  path: ["/api/admin/*"],
};
