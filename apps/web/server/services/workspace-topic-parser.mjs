export const WORKSPACE_TOPIC_TITLE_MAX_CODE_POINTS = 40;
export const WORKSPACE_TOPIC_BODY_MAX_CODE_POINTS = 30_000;
export const WORKSPACE_TOPIC_BODY_MAX_BYTES = 100 * 1024;

/**
 * Parse the only message form that can create a Workspace topic.
 *
 * The parser is intentionally side-effect free. It returns a creation intent
 * only; membership, permissions, idempotency, persistence, and audit checks
 * belong to the topic service that consumes it.
 */
export function parseWorkspaceTopicSyntax(source) {
  if (typeof source !== "string" || source.length === 0) {
    return null;
  }

  const markerIndex = firstNonWhitespaceIndex(source);
  if (markerIndex < 0 || source[markerIndex] !== "#" || source[markerIndex + 1] !== "[") {
    return null;
  }

  const titleStart = markerIndex + 2;
  const titleEnd = source.indexOf("](", titleStart);
  if (titleEnd < titleStart) {
    return null;
  }

  const title = source.slice(titleStart, titleEnd).trim();
  if (!isValidTopicTitle(title)) {
    return null;
  }

  const bodyStart = titleEnd + 2;
  const bodyEnd = findBalancedBodyEnd(source, bodyStart);
  if (bodyEnd < 0 || source.slice(bodyEnd + 1).trim() !== "") {
    return null;
  }

  const rawBody = source.slice(bodyStart, bodyEnd);
  if (!isWithinTopicBodyLimits(rawBody)) {
    return null;
  }
  const description = rawBody.trim();
  if (!description) {
    return null;
  }

  return { title, description };
}

// Keep the shorter name available for callers that treat this as a topic parser
// rather than a message-syntax parser.
export const parseWorkspaceTopic = parseWorkspaceTopicSyntax;

function firstNonWhitespaceIndex(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (!/\s/u.test(value[index])) {
      return index;
    }
  }
  return -1;
}

function findBalancedBodyEnd(source, bodyStart) {
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character !== ")") {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return index;
    }
  }
  return -1;
}

function isValidTopicTitle(title) {
  const codePointLength = Array.from(title).length;
  return codePointLength >= 1 &&
    codePointLength <= WORKSPACE_TOPIC_TITLE_MAX_CODE_POINTS &&
    !/[\[\]\r\n]/u.test(title);
}

function isWithinTopicBodyLimits(body) {
  return Array.from(body).length <= WORKSPACE_TOPIC_BODY_MAX_CODE_POINTS &&
    Buffer.byteLength(body, "utf8") <= WORKSPACE_TOPIC_BODY_MAX_BYTES;
}
