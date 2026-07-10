export type WorkspaceEntryRoute = {
  lane: "workspace" | "p2p" | "";
  inviteCode: string;
  roomId: string;
};

export function parseEntryRoute(search: string): WorkspaceEntryRoute {
  const params = new URLSearchParams(search);
  const lane = params.get("lane");
  return {
    lane: lane === "workspace" || lane === "p2p" ? lane : "",
    inviteCode: normalizePublicParam(params.get("invite")),
    roomId: normalizePublicParam(params.get("room"))
  };
}

export function getWorkspaceLoginUrl(inviteCode = "") {
  const params = new URLSearchParams();
  const normalizedInviteCode = normalizePublicParam(inviteCode);
  if (normalizedInviteCode) {
    params.set("invite", normalizedInviteCode);
  }
  return params.size > 0 ? `/api/auth/github/start?${params.toString()}` : "/api/auth/github/start";
}

export function getWorkspaceEntryUrl(inviteCode = "") {
  const params = new URLSearchParams();
  params.set("lane", "workspace");
  const normalizedInviteCode = normalizePublicParam(inviteCode);
  if (normalizedInviteCode) {
    params.set("invite", normalizedInviteCode);
  }
  return `/?${params.toString()}`;
}

function normalizePublicParam(value: string | null | undefined) {
  return (value ?? "").split("#", 1)[0].trim();
}
