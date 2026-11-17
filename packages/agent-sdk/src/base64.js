const ARTIFACT_BASE64_VALUES = new Uint8Array(128).fill(255);
for (const [index, character] of [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].entries()) {
  ARTIFACT_BASE64_VALUES[character.charCodeAt(0)] = index;
}

function artifactBase64Error(code) {
  return Object.assign(new Error(code), { code });
}

/** Strict RFC 4648 decoding with O(n) time and constant validation stack space. */
export function decodeArtifactBase64(data, { maxBytes = 25 * 1024 * 1024 } = {}) {
  if (typeof data !== "string") throw artifactBase64Error("artifact.invalid_data");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive integer");
  if (data.length > Math.ceil(maxBytes / 3) * 4) throw artifactBase64Error("artifact.too_large");
  if (data.length % 4 !== 0) throw artifactBase64Error("artifact.invalid_base64");
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const end = data.length - padding;
  const decodedLength = data.length / 4 * 3 - padding;
  if (decodedLength > maxBytes) throw artifactBase64Error("artifact.too_large");
  // Buffer.from alone silently accepts whitespace, URL-safe characters and bad
  // padding. Validate every character and the unused trailing bits first.
  let last = 0;
  for (let index = 0; index < end; index += 1) {
    const code = data.charCodeAt(index);
    if (code >= ARTIFACT_BASE64_VALUES.length || ARTIFACT_BASE64_VALUES[code] === 255) {
      throw artifactBase64Error("artifact.invalid_base64");
    }
    last = ARTIFACT_BASE64_VALUES[code];
  }
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) {
    throw artifactBase64Error("artifact.invalid_base64");
  }
  return Buffer.from(data, "base64");
}
