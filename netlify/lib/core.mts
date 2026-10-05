// Shared helpers for the CWD members area (client webinar library).
// Storage: Netlify Blobs. Secrets: Netlify environment variables only.
import { getStore } from "@netlify/blobs";
import {
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: object,
) => Promise<Buffer>;

declare const Netlify: {
  env: { get(key: string): string | undefined };
  context?: { deploy?: { context?: string } } | null;
};

// ---------------------------------------------------------------- env
export function env(key: string): string | undefined {
  const v = Netlify.env.get(key);
  return v && v.trim() ? v.trim() : undefined;
}

export function requireEnv(key: string): string {
  const v = env(key);
  if (!v) throw new HttpError(503, `Server not configured: ${key} is missing.`);
  return v;
}

// ---------------------------------------------------------------- storage
// Production data lives in the global "members" store. Anything that is not
// the production deploy (local dev, deploy previews) uses "members-dev" so
// test accounts never mix with real client data.
export function db() {
  const ctx = Netlify.context?.deploy?.context;
  const name = ctx === "production" ? "members" : "members-dev";
  return getStore({ name, consistency: "strong" });
}

export type Session = {
  sid: string;
  createdAt: string;
  lastSeenAt: string;
  ip?: string;
  ua?: string;
};

export type User = {
  id: string;
  email: string;
  name: string;
  firm: string;
  active: boolean;
  passwordHash?: string;
  termsAcceptedAt?: string;
  createdAt: string;
  lastLoginAt?: string;
  sessions: Session[];
  logins: { at: string; ip?: string }[];
  views: { id: string; at: string }[];
};

export type Webinar = {
  id: string; // Bunny Stream video GUID
  title: string;
  weekOf: string; // YYYY-MM-DD
  summary: string;
  topics: string[];
  published: boolean;
  createdAt: string;
  updatedAt: string;
  lengthSec?: number;
  ready?: boolean; // true once Bunny has finished processing the video
};

export const emailKey = (email: string) => `email/${sha256(normEmail(email))}`;
export const userKey = (id: string) => `users/${id}`;

export function normEmail(e: string): string {
  return String(e || "").trim().toLowerCase();
}

export async function getUser(id: string): Promise<User | null> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  return (await db().get(userKey(id), { type: "json" })) as User | null;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const id = (await db().get(emailKey(email), { type: "text" })) as string | null;
  return id ? getUser(id) : null;
}

export async function saveUser(u: User): Promise<void> {
  await db().setJSON(userKey(u.id), u);
}

export async function listUsers(): Promise<User[]> {
  const store = db();
  const { blobs } = (await store.list({ prefix: "users/" })) as {
    blobs: { key: string }[];
  };
  const users = await Promise.all(
    blobs.map((b) => store.get(b.key, { type: "json" }) as Promise<User | null>),
  );
  return users.filter((u): u is User => !!u);
}

export async function getCatalogue(): Promise<Webinar[]> {
  const list = (await db().get("catalogue", { type: "json" })) as Webinar[] | null;
  return Array.isArray(list) ? list : [];
}

export async function saveCatalogue(list: Webinar[]): Promise<void> {
  await db().setJSON("catalogue", sortWebinars(list));
}

export function sortWebinars(list: Webinar[]): Webinar[] {
  return [...list].sort(
    (a, b) =>
      b.weekOf.localeCompare(a.weekOf) || b.createdAt.localeCompare(a.createdAt),
  );
}

// ---------------------------------------------------------------- crypto
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(pw: string, stored?: string): Promise<boolean> {
  if (!stored) {
    // Spend comparable time so missing accounts are not detectable by timing.
    await scrypt(pw, randomBytes(16), 64, SCRYPT);
    return false;
  }
  const [alg, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64url");
  const got = await scrypt(pw, Buffer.from(saltB64, "base64url"), expected.length, SCRYPT);
  return timingSafeEqual(expected, got);
}

function hmac(data: string, extra = ""): string {
  return createHmac("sha256", requireEnv("SESSION_SECRET") + extra)
    .update(data)
    .digest("base64url");
}

// ---------------------------------------------------------------- http
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

export function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers(BASE_HEADERS);
  new Headers(extra).forEach((v, k) => headers.append(k, v));
  return new Response(JSON.stringify(data), { status, headers });
}

export function handleError(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.message }, err.status);
  console.error(err);
  return json({ error: "Something went wrong. Please try again." }, 500);
}

// Rejects cross-site state-changing requests (CSRF) and non-JSON bodies.
export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  assertSameOrigin(req);
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new HttpError(415, "Expected JSON.");
  const text = await req.text();
  if (text.length > 20_000) throw new HttpError(413, "Request too large.");
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}

export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  const self = new URL(req.url).origin;
  if (origin && origin !== self) throw new HttpError(403, "Cross-site request blocked.");
  const site = req.headers.get("sec-fetch-site");
  if (!origin && site && site !== "same-origin" && site !== "none") {
    throw new HttpError(403, "Cross-site request blocked.");
  }
}

export function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function isEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
}

export function getCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

function cookie(name: string, value: string, maxAge: number, req: Request): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// ---------------------------------------------------------------- rate limit
export async function rateLimit(kind: string, id: string, max: number, windowSec: number) {
  const key = `ratelimit/${kind}/${sha256(id)}`;
  const store = db();
  const now = Date.now();
  const rec = ((await store.get(key, { type: "json" })) as {
    count: number;
    resetAt: number;
  } | null) ?? { count: 0, resetAt: now + windowSec * 1000 };
  if (rec.resetAt < now) {
    rec.count = 0;
    rec.resetAt = now + windowSec * 1000;
  }
  if (rec.count >= max) {
    const mins = Math.ceil((rec.resetAt - now) / 60000);
    throw new HttpError(429, `Too many attempts. Please try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
  }
  rec.count += 1;
  await store.setJSON(key, rec);
}

export async function clearRateLimit(kind: string, id: string) {
  await db().delete(`ratelimit/${kind}/${sha256(id)}`);
}

// ---------------------------------------------------------------- member sessions
export const MEMBER_COOKIE = "cwd_member";
const MEMBER_TTL = 30 * 24 * 3600;

export function maxSessions(): number {
  const n = Number(env("MAX_SESSIONS_PER_USER") || 3);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}

export async function startMemberSession(
  user: User,
  req: Request,
  ip?: string,
): Promise<string> {
  const now = new Date().toISOString();
  const sid = randomToken(18);
  user.sessions = [
    ...(user.sessions || []),
    { sid, createdAt: now, lastSeenAt: now, ip, ua: str(req.headers.get("user-agent"), 200) },
  ].slice(-maxSessions()); // oldest device is signed out beyond the limit
  user.lastLoginAt = now;
  user.logins = [...(user.logins || []), { at: now, ip }].slice(-25);
  await saveUser(user);
  const exp = Math.floor(Date.now() / 1000) + MEMBER_TTL;
  const payload = `${user.id}.${sid}.${exp}`;
  return cookie(MEMBER_COOKIE, `${payload}.${hmac(payload)}`, MEMBER_TTL, req);
}

export function clearMemberCookie(req: Request): string {
  return cookie(MEMBER_COOKIE, "", 0, req);
}

export async function getMember(req: Request): Promise<{ user: User; sid: string } | null> {
  const raw = getCookie(req, MEMBER_COOKIE);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const [uid, sid, expStr, sig] = parts;
  if (!safeEqual(sig, hmac(`${uid}.${sid}.${expStr}`))) return null;
  if (Number(expStr) < Date.now() / 1000) return null;
  const user = await getUser(uid);
  if (!user || !user.active || !user.passwordHash) return null;
  const session = (user.sessions || []).find((s) => s.sid === sid);
  if (!session) return null;
  // Touch lastSeen at most every 10 minutes to limit writes.
  if (Date.now() - Date.parse(session.lastSeenAt) > 10 * 60 * 1000) {
    session.lastSeenAt = new Date().toISOString();
    await saveUser(user);
  }
  return { user, sid };
}

export async function requireMember(req: Request) {
  const m = await getMember(req);
  if (!m) throw new HttpError(401, "Please sign in.");
  return m;
}

// ---------------------------------------------------------------- admin sessions
export const ADMIN_COOKIE = "cwd_admin";
const ADMIN_TTL = 12 * 3600;

// The admin password is part of the signing key, so changing ADMIN_PASSWORD
// in Netlify immediately signs out every admin session.
const adminKey = () => sha256(requireEnv("ADMIN_PASSWORD"));

export function startAdminSession(req: Request): string {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_TTL;
  const payload = `admin.${randomToken(12)}.${exp}`;
  return cookie(ADMIN_COOKIE, `${payload}.${hmac(payload, adminKey())}`, ADMIN_TTL, req);
}

export function clearAdminCookie(req: Request): string {
  return cookie(ADMIN_COOKIE, "", 0, req);
}

export function isAdmin(req: Request): boolean {
  if (!env("ADMIN_PASSWORD") || !env("SESSION_SECRET")) return false;
  const raw = getCookie(req, ADMIN_COOKIE);
  if (!raw) return false;
  const parts = raw.split(".");
  if (parts.length !== 4 || parts[0] !== "admin") return false;
  const payload = parts.slice(0, 3).join(".");
  if (!safeEqual(parts[3], hmac(payload, adminKey()))) return false;
  return Number(parts[2]) > Date.now() / 1000;
}

export function requireAdmin(req: Request): void {
  if (!isAdmin(req)) throw new HttpError(401, "Admin sign-in required.");
}

// ---------------------------------------------------------------- invites
const INVITE_TTL_DAYS = 7;

export async function createInvite(user: User, req: Request): Promise<{ url: string; expiresAt: string }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 864e5).toISOString();
  await db().setJSON(`invites/${sha256(token)}`, { uid: user.id, expiresAt });
  const site = env("SITE_URL") || new URL(req.url).origin;
  return { url: `${site}/members/welcome.html#${token}`, expiresAt };
}

export async function readInvite(token: string): Promise<{ user: User; key: string } | null> {
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(token)) return null;
  const key = `invites/${sha256(token)}`;
  const inv = (await db().get(key, { type: "json" })) as { uid: string; expiresAt: string } | null;
  if (!inv || Date.parse(inv.expiresAt) < Date.now()) return null;
  const user = await getUser(inv.uid);
  return user ? { user, key } : null;
}

export function publicUser(u: User) {
  return { id: u.id, email: u.email, name: u.name, firm: u.firm };
}
