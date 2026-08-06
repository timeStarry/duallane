export type WorkspaceRouteView = "chat" | "files" | "members" | "account" | "space" | "new";
export type WorkspaceRouteSpaceTab = "overview" | "invites" | "roles" | "visibility" | "email";
export type WorkspaceRouteCreateMode = "" | "direct" | "group";

export type AppRoute =
  | { kind: "entry" }
  | { kind: "about" }
  | { kind: "direct"; roomId: string }
  | {
      kind: "workspace";
      view: WorkspaceRouteView;
      conversationId: string;
      fileId: string;
      memberId: string;
      spaceTab: WorkspaceRouteSpaceTab;
      createMode: WorkspaceRouteCreateMode;
      inviteCode: string;
    };

export type ParsedAppRoute = {
  route: AppRoute;
  canonicalUrl: string;
  needsCanonicalReplace: boolean;
};

export function parseAppRoute(pathname: string, search = "", hash = ""): ParsedAppRoute {
  const normalizedPath = normalizePathname(pathname);
  const params = new URLSearchParams(search);
  const legacyLane = params.get("lane");
  const inviteCode = normalizePublicParam(params.get("invite"));
  const currentUrl = `${normalizedPath}${search}${hash}`;
  const finish = (route: AppRoute, forceReplace: boolean) => parsed(route, hash, forceReplace, currentUrl);

  if (normalizedPath === "/" && legacyLane === "workspace") {
    return finish(workspaceRoute({ inviteCode }), true);
  }

  if (normalizedPath === "/" && legacyLane === "p2p") {
    const roomId = normalizeRouteSegment(params.get("room"));
    return finish({ kind: "direct", roomId }, true);
  }

  if (normalizedPath === "/") {
    return finish({ kind: "entry" }, search !== "" || hash !== "");
  }
  if (normalizedPath === "/about") {
    return finish({ kind: "about" }, search !== "" || hash !== "");
  }
  if (normalizedPath === "/direct") {
    return finish({ kind: "direct", roomId: "" }, search !== "");
  }

  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments[0] === "direct") {
    const roomId = segments.length === 2 ? normalizeRouteSegment(segments[1]) : "";
    return finish({ kind: "direct", roomId }, segments.length !== 2 || !roomId || search !== "");
  }

  if (segments[0] !== "workspace") {
    return finish({ kind: "entry" }, true);
  }

  const base = { inviteCode };
  if (segments.length === 1) {
    return finish(workspaceRoute(base), hash !== "" || hasUnexpectedParams(params, ["invite"]));
  }
  if (segments[1] === "chat") {
    const conversationId = segments.length === 3 ? normalizeRouteSegment(segments[2]) : "";
    return finish(
      workspaceRoute({ ...base, conversationId }),
      segments.length > 3 || (segments.length === 3 && !conversationId) || hasUnexpectedParams(params, ["invite"])
    );
  }
  if (segments[1] === "files") {
    const fileId = segments.length === 3 ? normalizeRouteSegment(segments[2]) : "";
    return finish(
      workspaceRoute({ ...base, view: "files", fileId }),
      segments.length > 3 || (segments.length === 3 && !fileId) || hasUnexpectedParams(params, ["invite"])
    );
  }
  if (segments[1] === "members") {
    const memberId = segments.length === 3 ? normalizeRouteSegment(segments[2]) : "";
    return finish(
      workspaceRoute({ ...base, view: "members", memberId }),
      segments.length > 3 || (segments.length === 3 && !memberId) || hasUnexpectedParams(params, ["invite"])
    );
  }
  if (segments[1] === "account" && segments.length === 2) {
    return finish(workspaceRoute({ ...base, view: "account" }), hasUnexpectedParams(params, ["invite"]));
  }
  if (segments[1] === "new" && segments.length === 3 && (segments[2] === "direct" || segments[2] === "group")) {
    return finish(
      workspaceRoute({ ...base, view: "new", createMode: segments[2] }),
      hasUnexpectedParams(params, ["invite"])
    );
  }
  if (segments[1] === "space") {
    const spaceTab = parseSpaceTab(segments[2]);
    return finish(
      workspaceRoute({ ...base, view: "space", spaceTab }),
      segments.length > (segments[2] ? 3 : 2) || Boolean(segments[2] && !isSpaceTabPath(segments[2])) || hasUnexpectedParams(params, ["invite"])
    );
  }

  return finish(workspaceRoute(base), true);
}

export function getAppRouteUrl(route: AppRoute) {
  if (route.kind === "entry") return "/";
  if (route.kind === "about") return "/about";
  if (route.kind === "direct") {
    return route.roomId ? `/direct/${encodeURIComponent(route.roomId)}` : "/direct";
  }

  let pathname = "/workspace";
  if (route.view === "chat" && route.conversationId) pathname = `/workspace/chat/${encodeURIComponent(route.conversationId)}`;
  if (route.view === "files") pathname = route.fileId ? `/workspace/files/${encodeURIComponent(route.fileId)}` : "/workspace/files";
  if (route.view === "members") pathname = route.memberId ? `/workspace/members/${encodeURIComponent(route.memberId)}` : "/workspace/members";
  if (route.view === "account") pathname = "/workspace/account";
  if (route.view === "new" && route.createMode) pathname = `/workspace/new/${route.createMode}`;
  if (route.view === "space") pathname = route.spaceTab === "overview" ? "/workspace/space" : `/workspace/space/${spaceTabPath(route.spaceTab)}`;

  const params = new URLSearchParams();
  if (route.inviteCode) params.set("invite", route.inviteCode);
  return params.size ? `${pathname}?${params.toString()}` : pathname;
}

export function workspaceRoute(input: Partial<Omit<Extract<AppRoute, { kind: "workspace" }>, "kind">> = {}): Extract<AppRoute, { kind: "workspace" }> {
  return {
    kind: "workspace",
    view: input.view ?? "chat",
    conversationId: input.conversationId ?? "",
    fileId: input.fileId ?? "",
    memberId: input.memberId ?? "",
    spaceTab: input.spaceTab ?? "overview",
    createMode: input.createMode ?? "",
    inviteCode: input.inviteCode ?? ""
  };
}

export function normalizeWorkspaceReturnTo(value: string | null | undefined) {
  const candidate = String(value ?? "").trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\") || candidate.includes("#")) return "";
  try {
    const base = new URL("https://duallane.invalid");
    const url = new URL(candidate, base);
    const decodedPath = decodeURIComponent(url.pathname);
    if (
      url.origin !== base.origin ||
      decodedPath.includes("\\") ||
      (url.pathname !== "/workspace" && !url.pathname.startsWith("/workspace/"))
    ) {
      return "";
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

function parsed(route: AppRoute, hash: string, forceReplace: boolean, currentUrl: string): ParsedAppRoute {
  const preservedHash = route.kind === "direct" && route.roomId ? normalizeHash(hash) : "";
  const canonicalUrl = `${getAppRouteUrl(route)}${preservedHash}`;
  return {
    route,
    canonicalUrl,
    needsCanonicalReplace: forceReplace || canonicalUrl !== currentUrl
  };
}

function normalizePathname(value: string) {
  const pathname = value.startsWith("/") ? value : `/${value}`;
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "") || "/";
}

function normalizeHash(value: string) {
  if (!value) return "";
  return value.startsWith("#") ? value : `#${value}`;
}

function normalizePublicParam(value: string | null | undefined) {
  return String(value ?? "").split("#", 1)[0].trim().slice(0, 256);
}

function normalizeRouteSegment(value: string | null | undefined) {
  try {
    const decoded = decodeURIComponent(String(value ?? ""));
    return decoded && decoded.length <= 256 && !/[\/\u0000-\u001f\u007f]/.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function hasUnexpectedParams(params: URLSearchParams, allowed: string[]) {
  return [...params.keys()].some((key) => !allowed.includes(key));
}

function parseSpaceTab(value: string | undefined): WorkspaceRouteSpaceTab {
  if (value === "invites") return "invites";
  if (value === "permissions") return "roles";
  if (value === "visibility") return "visibility";
  if (value === "email") return "email";
  return "overview";
}

function isSpaceTabPath(value: string) {
  return ["invites", "permissions", "visibility", "email"].includes(value);
}

function spaceTabPath(tab: WorkspaceRouteSpaceTab) {
  return tab === "roles" ? "permissions" : tab;
}
