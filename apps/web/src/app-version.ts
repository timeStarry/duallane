export function compareSemanticVersions(left: string, right: string) {
  const leftParts = parseSemanticVersion(left);
  const rightParts = parseSemanticVersion(right);
  if (!leftParts || !rightParts) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? 1 : -1;
  }
  return 0;
}

export function isServerVersionNewer(clientVersion: string, serverVersion?: string) {
  return Boolean(serverVersion && compareSemanticVersions(serverVersion, clientVersion) > 0);
}

function parseSemanticVersion(value: string) {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}
