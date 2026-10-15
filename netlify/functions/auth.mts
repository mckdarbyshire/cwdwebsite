// Client sign-in, sign-out, first-time password setup from an invite link,
// and one-click access from the personal links in the weekly email.
import type { Config, Context } from "@netlify/functions";
import {
  clearMemberCookie,
  clearRateLimit,
  db,
  getMember,
  getUserByEmail,
  handleError,
  hashPassword,
  HttpError,
  json,
  normEmail,
  publicUser,
  rateLimit,
  readInvite,
  readMagicLink,
  readJson,
  saveUser,
  startMemberSession,
  str,
  verifyPassword,
} from "../lib/core.mts";

const MIN_PASSWORD = 10;
const BAD_LOGIN = "Email or password not recognised.";

export default async (req: Request, context: Context) => {
  try {
    const action = new URL(req.url).pathname.replace(/^\/api\/auth\/?/, "");
    const ip = context.ip;

    if (action === "me" && req.method === "GET") {
      const m = await getMember(req);
      return m ? json({ user: publicUser(m.user) }) : json({ user: null }, 401);
    }

    if (action === "login" && req.method === "POST") {
      const body = await readJson<{ email?: string; password?: string }>(req);
      const email = normEmail(str(body.email, 254));
      const password = typeof body.password === "string" ? body.password.slice(0, 200) : "";
      if (!email || !password) throw new HttpError(400, "Enter your email and password.");
      await rateLimit("login-ip", ip || "unknown", 30, 15 * 60);
      await rateLimit("login-email", email, 8, 15 * 60);
      const user = await getUserByEmail(email);
      const ok = await verifyPassword(password, user?.passwordHash);
      if (!user || !ok) throw new HttpError(401, BAD_LOGIN);
      if (!user.active) {
        throw new HttpError(403, "This account is not currently active. Please contact CWD Research Consulting.");
      }
      await clearRateLimit("login-email", email);
      const setCookie = await startMemberSession(user, req, ip);
      return json({ user: publicUser(user) }, 200, { "Set-Cookie": setCookie });
    }

    if (action === "logout" && req.method === "POST") {
      await readJson(req).catch(() => ({}));
      const m = await getMember(req);
      if (m) {
        m.user.sessions = m.user.sessions.filter((s) => s.sid !== m.sid);
        await saveUser(m.user);
      }
      return json({ ok: true }, 200, { "Set-Cookie": clearMemberCookie(req) });
    }

    // Invite links carry the token in the URL fragment; the page posts it here.
    if (action === "invite" && req.method === "POST") {
      const body = await readJson<{ token?: string; password?: string; acceptTerms?: boolean; check?: boolean }>(req);
      await rateLimit("invite-ip", ip || "unknown", 30, 15 * 60);
      const inv = await readInvite(str(body.token, 100));
      if (!inv) throw new HttpError(410, "This link has expired or has already been used. Please ask CWD for a new one.");
      const { user, key } = inv;
      if (body.check) return json({ user: publicUser(user) });

      const password = typeof body.password === "string" ? body.password : "";
      if (password.length < MIN_PASSWORD || password.length > 200) {
        throw new HttpError(400, `Please choose a password of at least ${MIN_PASSWORD} characters.`);
      }
      if (password.toLowerCase().includes(user.email.split("@")[0].toLowerCase())) {
        throw new HttpError(400, "Please choose a password that does not contain your email name.");
      }
      if (body.acceptTerms !== true) throw new HttpError(400, "Please confirm you accept the terms of access.");
      if (!user.active) throw new HttpError(403, "This account is not currently active. Please contact CWD Research Consulting.");

      user.passwordHash = await hashPassword(password);
      user.termsAcceptedAt = new Date().toISOString();
      user.sessions = []; // a password (re)set signs out every other device
      await db().delete(key); // invite links are single use
      const setCookie = await startMemberSession(user, req, ip);
      return json({ user: publicUser(user) }, 200, { "Set-Cookie": setCookie });
    }

    // Personal links from the weekly email: the landing page posts the token here.
    if (action === "magic" && req.method === "POST") {
      const body = await readJson<{ token?: string; next?: string }>(req);
      await rateLimit("magic-ip", ip || "unknown", 60, 15 * 60);
      const link = await readMagicLink(str(body.token, 100));
      if (!link) throw new HttpError(410, "This link has expired. Please sign in, or reply to the email for a fresh link.");
      const { user, wid } = link;
      if (!user.active) throw new HttpError(403, "This account is not currently active. Please contact CWD Research Consulting.");
      const next = str(body.next, 10);
      const dest = next === "pdf" ? `/members/?w=${encodeURIComponent(wid)}#pdf`
        : next === "ask" ? `/members/?w=${encodeURIComponent(wid)}#ask`
        : `/members/?w=${encodeURIComponent(wid)}`;
      // Already signed in on this device as the same person: keep that session.
      const current = await getMember(req);
      if (current && current.user.id === user.id) return json({ next: dest });
      const setCookie = await startMemberSession(user, req, ip);
      return json({ next: dest }, 200, { "Set-Cookie": setCookie });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return handleError(err);
  }
};

export const config: Config = {
  path: ["/api/auth/me", "/api/auth/login", "/api/auth/logout", "/api/auth/invite", "/api/auth/magic"],
};
