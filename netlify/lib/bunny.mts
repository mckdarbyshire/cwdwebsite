// Bunny Stream integration: private video storage with signed, expiring embeds.
import { env, HttpError, requireEnv, sha256 } from "./core.mts";

export type BunnyVideo = {
  guid: string;
  title: string;
  dateUploaded: string;
  length: number;
  status: number;
  encodeProgress: number;
  storageSize?: number;
};

// Bunny video status codes
export const STATUS_LABEL: Record<number, string> = {
  0: "Waiting for upload",
  1: "Uploaded",
  2: "Processing",
  3: "Transcoding",
  4: "Ready",
  5: "Error",
  6: "Upload failed",
  7: "Processing",
  8: "Processing",
};

const apiHost = () => env("BUNNY_API_HOST") || "https://video.bunnycdn.com";
const embedHost = () => env("BUNNY_EMBED_HOST") || "https://player.mediadelivery.net";

export function bunnyConfigured() {
  return {
    libraryId: !!env("BUNNY_LIBRARY_ID"),
    apiKey: !!env("BUNNY_API_KEY"),
    tokenKey: !!env("BUNNY_TOKEN_KEY"),
  };
}

async function api(path: string, init: RequestInit = {}) {
  const lib = requireEnv("BUNNY_LIBRARY_ID");
  const res = await fetch(`${apiHost()}/library/${lib}${path}`, {
    ...init,
    headers: {
      AccessKey: requireEnv("BUNNY_API_KEY"),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("Bunny API error", res.status, body.slice(0, 300));
    throw new HttpError(502, `Video service error (${res.status}). Check the Bunny settings.`);
  }
  return res.status === 204 ? null : res.json();
}

export async function listVideos(): Promise<BunnyVideo[]> {
  const out: BunnyVideo[] = [];
  for (let page = 1; page <= 20; page++) {
    const data = (await api(`/videos?page=${page}&itemsPerPage=100&orderBy=date`)) as {
      items: BunnyVideo[];
      totalItems: number;
    };
    out.push(...(data.items || []));
    if (out.length >= (data.totalItems || 0) || !data.items?.length) break;
  }
  return out;
}

export async function getVideo(guid: string): Promise<BunnyVideo> {
  return (await api(`/videos/${encodeURIComponent(guid)}`)) as BunnyVideo;
}

export async function createVideo(title: string): Promise<BunnyVideo> {
  return (await api(`/videos`, { method: "POST", body: JSON.stringify({ title }) })) as BunnyVideo;
}

export async function deleteVideo(guid: string): Promise<void> {
  await api(`/videos/${encodeURIComponent(guid)}`, { method: "DELETE" });
}

// Credentials for a direct browser-to-Bunny resumable (TUS) upload.
// The API key never leaves the server; the browser only gets a signature
// that is valid for this one video for a limited time.
export function uploadCredentials(videoId: string, ttlSec = 24 * 3600) {
  const libraryId = requireEnv("BUNNY_LIBRARY_ID");
  const expire = Math.floor(Date.now() / 1000) + ttlSec;
  const signature = sha256(`${libraryId}${requireEnv("BUNNY_API_KEY")}${expire}${videoId}`);
  return {
    endpoint: `${apiHost()}/tusupload`,
    headers: {
      AuthorizationSignature: signature,
      AuthorizationExpire: String(expire),
      VideoId: videoId,
      LibraryId: libraryId,
    },
  };
}

// Signed player URL. With "Embed view token authentication" switched on in
// Bunny, the player refuses any request without a valid, unexpired token.
export function signedEmbedUrl(videoId: string, ttlSec = 4 * 3600) {
  const lib = requireEnv("BUNNY_LIBRARY_ID");
  const key = requireEnv("BUNNY_TOKEN_KEY");
  const expires = Math.floor(Date.now() / 1000) + ttlSec;
  const token = sha256(`${key}${videoId}${expires}`);
  const qs = new URLSearchParams({
    token,
    expires: String(expires),
    autoplay: "false",
    preload: "true",
    responsive: "true",
  });
  return {
    url: `${embedHost()}/embed/${lib}/${encodeURIComponent(videoId)}?${qs}`,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

export const isGuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
