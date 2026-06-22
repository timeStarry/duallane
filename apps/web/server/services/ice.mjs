import crypto from "node:crypto";

const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302"];
const DEFAULT_TURN_TTL_SECONDS = 600;

export function getIceServers(env = process.env, nowMs = Date.now()) {
  const iceServers = parseUrlList(env.DUALLANE_STUN_URLS, DEFAULT_STUN_URLS).map((url) => ({ urls: url }));
  const turnUrls = parseUrlList(env.DUALLANE_TURN_URLS, []);

  if (turnUrls.length === 0) {
    return iceServers;
  }

  const sharedSecret = trim(env.DUALLANE_TURN_SHARED_SECRET);
  if (sharedSecret) {
    const ttlSeconds = parsePositiveInteger(env.DUALLANE_TURN_TTL_SECONDS, DEFAULT_TURN_TTL_SECONDS);
    const expiresAtSeconds = Math.floor(nowMs / 1000) + ttlSeconds;
    const username = `${expiresAtSeconds}:duallane`;
    const credential = crypto.createHmac("sha1", sharedSecret).update(username).digest("base64");
    iceServers.push({ urls: turnUrls, username, credential });
    return iceServers;
  }

  const username = trim(env.DUALLANE_TURN_USERNAME);
  const credential = trim(env.DUALLANE_TURN_CREDENTIAL);
  if (username && credential) {
    iceServers.push({ urls: turnUrls, username, credential });
  }

  return iceServers;
}

function parseUrlList(value, fallback) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  const urls = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return urls.length > 0 ? urls : fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}
