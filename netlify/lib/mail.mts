// Sending email as michael@ through Microsoft 365 (Microsoft Graph, app-only).
// Needs an Entra app registration with the Mail.Send application permission,
// ideally restricted to the one mailbox with an application access policy.
import { env, HttpError } from "./core.mts";

export function mailConfigured() {
  return {
    tenantId: !!env("MS_TENANT_ID"),
    clientId: !!env("MS_CLIENT_ID"),
    clientSecret: !!env("MS_CLIENT_SECRET"),
    from: env("MAIL_FROM") || null,
  };
}

export function mailReady(): boolean {
  const c = mailConfigured();
  return c.tenantId && c.clientId && c.clientSecret && !!c.from;
}

let cached: { token: string; exp: number } | null = null;

async function graphToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const tenant = env("MS_TENANT_ID");
  const body = new URLSearchParams({
    client_id: env("MS_CLIENT_ID") || "",
    client_secret: env("MS_CLIENT_SECRET") || "",
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant || "")}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new HttpError(502, `Microsoft 365 sign-in failed: ${(data.error_description || res.statusText).split("\r\n")[0]}`);
  }
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return cached.token;
}

export async function sendMail(opts: { to: string; toName?: string; subject: string; html: string; saveToSentItems?: boolean }) {
  if (!mailReady()) throw new HttpError(503, "Email is not set up yet. Add the Microsoft 365 settings in Netlify (see the Setup tab).");
  const from = env("MAIL_FROM")!;
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await graphToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: opts.subject,
        body: { contentType: "HTML", content: opts.html },
        toRecipients: [{ emailAddress: { address: opts.to, name: opts.toName || opts.to } }],
        replyTo: [{ emailAddress: { address: from } }],
      },
      saveToSentItems: opts.saveToSentItems !== false,
    }),
  });
  if (res.status === 429) throw new HttpError(429, "Microsoft 365 is limiting the send rate. Wait a minute and carry on.");
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new HttpError(502, `Microsoft 365 did not send the email: ${err.error?.message || res.statusText}`);
  }
}
