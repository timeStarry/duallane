//go:build postgres_integration

package httpapi

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/invites"
)

func TestWorkspaceInvitesContractPGUsesRealServiceAndAtomicPermissionAudit(t *testing.T) {
	database := newContractPGDatabase(t)
	idFactory := contractPGIDFactory("contract-invites")
	codeFactory := func() (string, error) { return "CONTRACT-NULL", nil }
	service := invites.NewService(invites.ServiceOptions{
		Repository:  invites.NewPGRepository(database.pool, idFactory),
		SpaceID:     contractPGSpaceID,
		Now:         func() time.Time { return database.now },
		IDFactory:   idFactory,
		CodeFactory: codeFactory,
	})
	router := database.router(RouterOptions{Invites: service})

	unauthenticated := contractPGJSON(database, router, http.MethodPost, "/api/workspace/invites", `{"defaultRole":"member"}`, "", "invites-auth-required")
	if unauthenticated.Code != http.StatusUnauthorized || contractPGErrorCode(t, unauthenticated) != auth.CodeRequired {
		t.Fatalf("unauthenticated invite create status=%d body=%s", unauthenticated.Code, unauthenticated.Body.String())
	}

	created := contractPGJSON(database, router, http.MethodPost, "/api/workspace/invites", "null", contractPGOwnerID, "invites-create-null")
	if created.Code != http.StatusCreated {
		t.Fatalf("null invite create status=%d body=%s", created.Code, created.Body.String())
	}
	var createdPayload struct {
		Invite invites.Invite `json:"invite"`
	}
	contractPGDecode(t, created, &createdPayload)
	invite := createdPayload.Invite
	if invite.ID == "" || invite.Code != "CONTRACT-NULL" || invite.DefaultRole != "member" || invite.MaxUses != 1 || invite.Uses != 0 || invite.ExpiresAt != nil || invite.CreatedAt == "" {
		t.Fatalf("created invite=%#v", invite)
	}
	if !strings.Contains(created.Body.String(), `"inviteUrl":"https://workspace.example.test/workspace?invite=CONTRACT-NULL"`) {
		t.Fatalf("created invite URL missing: %s", created.Body.String())
	}
	var storedCodeHash, storedPreview string
	if err := database.pool.QueryRow(database.ctx, `SELECT code_hash, code_preview FROM invites WHERE id = $1`, invite.ID).Scan(&storedCodeHash, &storedPreview); err != nil {
		t.Fatal(err)
	}
	if storedCodeHash != auth.HashSecret("CONTRACT-NULL") || storedCodeHash == "CONTRACT-NULL" || storedPreview == "CONTRACT-NULL" {
		t.Fatalf("invite secret persistence hash=%q preview=%q", storedCodeHash, storedPreview)
	}
	memberRevoke := contractPGJSON(database, router, http.MethodPost, "/api/workspace/invites/"+invite.ID+"/revoke", "{}", contractPGMemberID, "invites-member-revoke")
	if memberRevoke.Code != http.StatusForbidden || contractPGErrorCode(t, memberRevoke) != invites.CodePermissionDenied {
		t.Fatalf("member revoke status=%d body=%s", memberRevoke.Code, memberRevoke.Body.String())
	}
	contractPGAssertBodyExcludes(t, memberRevoke, "CONTRACT-NULL")
	var revokedAt *time.Time
	if err := database.pool.QueryRow(database.ctx, `SELECT revoked_at FROM invites WHERE id = $1`, invite.ID).Scan(&revokedAt); err != nil {
		t.Fatal(err)
	}
	if revokedAt != nil {
		t.Fatalf("member revoke mutated invite: %v", revokedAt)
	}
	memberAudit := contractPGAuditByRequest(t, database, "invites-member-revoke")
	if memberAudit.Action != "invite.revoke" || memberAudit.TargetType != "invite" || memberAudit.TargetID != invite.ID || memberAudit.Result != "rejected" || memberAudit.Reason != "insufficient permission" {
		t.Fatalf("member revoke audit=%#v", memberAudit)
	}

	ownerRevoke := contractPGServe(database, router, contractPGRequest(http.MethodPost, "/api/workspace/invites/"+invite.ID+"/revoke", "", contractPGOwnerID, "", "invites-owner-revoke"))
	if ownerRevoke.Code != http.StatusOK {
		t.Fatalf("owner revoke status=%d body=%s", ownerRevoke.Code, ownerRevoke.Body.String())
	}
	var revokedPayload struct {
		Invite struct {
			ID        string `json:"id"`
			RevokedAt string `json:"revokedAt"`
			Code      string `json:"code"`
		} `json:"invite"`
	}
	contractPGDecode(t, ownerRevoke, &revokedPayload)
	if revokedPayload.Invite.ID != invite.ID || revokedPayload.Invite.RevokedAt == "" || revokedPayload.Invite.Code != "" {
		t.Fatalf("revoked response=%#v", revokedPayload)
	}
	contractPGAssertBodyExcludes(t, ownerRevoke, "CONTRACT-NULL", "code_hash")
	if err := database.pool.QueryRow(database.ctx, `SELECT revoked_at FROM invites WHERE id = $1`, invite.ID).Scan(&revokedAt); err != nil {
		t.Fatal(err)
	}
	if revokedAt == nil {
		t.Fatal("owner revoke did not persist")
	}
	ownerAudit := contractPGAuditByRequest(t, database, "invites-owner-revoke")
	if ownerAudit.Action != "invite.revoke" || ownerAudit.TargetType != "invite" || ownerAudit.TargetID != invite.ID || ownerAudit.Result != "success" || ownerAudit.Reason != "" {
		t.Fatalf("owner revoke audit=%#v", ownerAudit)
	}

	missing := contractPGServe(database, router, contractPGRequest(http.MethodPost, "/api/workspace/invites/missing-contract/revoke", "", contractPGOwnerID, "", "invites-missing-revoke"))
	if missing.Code != http.StatusBadRequest || contractPGErrorCode(t, missing) != invites.CodeInviteNotFound {
		t.Fatalf("missing revoke status=%d body=%s", missing.Code, missing.Body.String())
	}
	contractPGAssertBodyExcludes(t, missing, "CONTRACT-NULL")
	missingAudit := contractPGAuditByRequest(t, database, "invites-missing-revoke")
	if missingAudit.Action != "invite.revoke" || missingAudit.TargetType != "invite" || missingAudit.TargetID != "missing-contract" || missingAudit.Result != "rejected" || missingAudit.Reason != "invite not found" {
		t.Fatalf("missing revoke audit=%#v", missingAudit)
	}
}
