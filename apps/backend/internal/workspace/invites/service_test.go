package invites

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type memoryRepository struct {
	actors   map[string]*auth.Actor
	invites  map[string]InviteRecord
	audits   []AuditInput
	auditErr error
}

func (repository *memoryRepository) WithTx(_ context.Context, callback func(Tx) error) error {
	tx := &memoryTx{
		actors:   repository.actors,
		invites:  cloneInvites(repository.invites),
		audits:   append([]AuditInput(nil), repository.audits...),
		auditErr: repository.auditErr,
	}
	if err := callback(tx); err != nil {
		return err
	}
	repository.invites = tx.invites
	repository.audits = tx.audits
	return nil
}

type memoryTx struct {
	actors   map[string]*auth.Actor
	invites  map[string]InviteRecord
	audits   []AuditInput
	auditErr error
}

func (tx *memoryTx) LookupActor(_ context.Context, _ string, userID string) (*auth.Actor, error) {
	return tx.actors[userID], nil
}

func (tx *memoryTx) FindInviteForUpdate(_ context.Context, _ string, inviteID string) (*InviteRecord, error) {
	record, ok := tx.invites[inviteID]
	if !ok {
		return nil, nil
	}
	return &record, nil
}

func (tx *memoryTx) InsertInvite(_ context.Context, record InviteRecord) error {
	if _, exists := tx.invites[record.ID]; exists {
		return errors.New("duplicate invite")
	}
	tx.invites[record.ID] = record
	return nil
}

func (tx *memoryTx) RevokeInvite(_ context.Context, _ string, inviteID string, revokedAt time.Time) (bool, error) {
	record, ok := tx.invites[inviteID]
	if !ok || record.RevokedAt != nil {
		return false, nil
	}
	record.RevokedAt = &revokedAt
	tx.invites[inviteID] = record
	return true, nil
}

func (tx *memoryTx) WriteAudit(_ context.Context, input AuditInput) error {
	if tx.auditErr != nil {
		return tx.auditErr
	}
	tx.audits = append(tx.audits, input)
	return nil
}

func TestCreatePreservesRolePermissionsHashingAndExpiry(t *testing.T) {
	now := time.Date(2026, 9, 4, 12, 0, 0, 123_000_000, time.UTC)
	repository := newMemoryRepository()
	service := testService(repository, now)
	invite, err := service.Create(context.Background(), CreateInput{
		ActorID: "owner", DefaultRole: "admin", Code: "OWNER-ADMIN-CODE", MaxUses: 2, ExpiresInHours: 2,
		Meta: RequestMeta{RequestID: "request-create", IPAddress: "127.0.0.1", UserAgent: "test"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if invite.ID != "invite-id" || invite.Code != "OWNER-ADMIN-CODE" || invite.CodePreview != "OWNE...CODE" || invite.ExpiresAt == nil {
		t.Fatalf("invite = %#v", invite)
	}
	if got := repository.invites[invite.ID]; got.CodeHash != auth.HashSecret(invite.Code) || got.CodeHash == invite.Code || got.MaxUses != 2 {
		t.Fatalf("stored invite = %#v", got)
	}
	if len(repository.audits) != 1 || repository.audits[0].Action != "invite.create" || repository.audits[0].RequestID != "request-create" {
		t.Fatalf("audits = %#v", repository.audits)
	}

	if _, err := service.Create(context.Background(), CreateInput{ActorID: "admin", DefaultRole: "owner", Code: "ADMIN-OWNER"}); !isCode(err, CodePermissionDenied) {
		t.Fatalf("admin privileged invite error = %v", err)
	}
	if _, err := service.Create(context.Background(), CreateInput{ActorID: "member", Code: "MEMBER-CODE"}); !isCode(err, CodePermissionDenied) {
		t.Fatalf("member invite error = %v", err)
	}
	if repository.audits[len(repository.audits)-1].Reason != "insufficient permission" {
		t.Fatalf("rejection audit = %#v", repository.audits[len(repository.audits)-1])
	}
}

func TestCreateValidationAndRandomFailuresAreAuditedOrFailClosed(t *testing.T) {
	repository := newMemoryRepository()
	service := testService(repository, time.Now())
	if _, err := service.Create(context.Background(), CreateInput{ActorID: "owner", DefaultRole: "operator", Code: "CODE"}); !isCode(err, CodeRoleInvalid) {
		t.Fatalf("invalid role error = %v", err)
	}
	if len(repository.audits) != 1 || repository.audits[0].Reason != CodeRoleInvalid {
		t.Fatalf("validation audit = %#v", repository.audits)
	}

	service.idFactory = func() (string, error) { return "", errors.New("random unavailable") }
	if _, err := service.Create(context.Background(), CreateInput{ActorID: "owner", Code: "VALID-CODE"}); !isCode(err, CodeInternal) {
		t.Fatalf("id failure error = %v", err)
	}
	service = testService(repository, time.Now())
	service.codeFactory = func() (string, error) { return "", errors.New("random unavailable") }
	if _, err := service.Create(context.Background(), CreateInput{ActorID: "owner"}); !isCode(err, CodeInternal) {
		t.Fatalf("code failure error = %v", err)
	}
}

func TestRevokeIsAuthorizedAuditedAndIdempotent(t *testing.T) {
	now := time.Date(2026, 9, 4, 13, 0, 0, 456_000_000, time.UTC)
	repository := newMemoryRepository()
	repository.invites["member-invite"] = InviteRecord{ID: "member-invite", DefaultRole: "member"}
	repository.invites["owner-invite"] = InviteRecord{ID: "owner-invite", DefaultRole: "owner"}
	service := testService(repository, now)

	revoked, err := service.Revoke(context.Background(), RevokeInput{ActorID: "admin", InviteID: "member-invite"})
	if err != nil || revoked.RevokedAt != "2026-09-04T13:00:00.456Z" {
		t.Fatalf("revoke = %#v, %v", revoked, err)
	}
	again, err := service.Revoke(context.Background(), RevokeInput{ActorID: "admin", InviteID: "member-invite"})
	if err != nil || again.RevokedAt != revoked.RevokedAt {
		t.Fatalf("idempotent revoke = %#v, %v", again, err)
	}
	if _, err := service.Revoke(context.Background(), RevokeInput{ActorID: "admin", InviteID: "owner-invite"}); !isCode(err, CodePermissionDenied) {
		t.Fatalf("admin privileged revoke error = %v", err)
	}
	if _, err := service.Revoke(context.Background(), RevokeInput{ActorID: "owner", InviteID: "missing"}); !isCode(err, CodeInviteNotFound) {
		t.Fatalf("missing revoke error = %v", err)
	}
	if repository.audits[len(repository.audits)-1].Reason != "invite not found" {
		t.Fatalf("missing audit = %#v", repository.audits[len(repository.audits)-1])
	}
}

func TestAuditFailureRollsBackInviteState(t *testing.T) {
	repository := newMemoryRepository()
	repository.auditErr = errors.New("audit unavailable")
	service := testService(repository, time.Now())
	if _, err := service.Create(context.Background(), CreateInput{ActorID: "owner", Code: "ROLLBACK-CREATE"}); !isCode(err, CodeInternal) {
		t.Fatalf("create audit failure = %v", err)
	}
	if len(repository.invites) != 0 {
		t.Fatalf("invite persisted after audit failure: %#v", repository.invites)
	}
	repository.invites["rollback-revoke"] = InviteRecord{ID: "rollback-revoke", DefaultRole: "member"}
	if _, err := service.Revoke(context.Background(), RevokeInput{ActorID: "owner", InviteID: "rollback-revoke"}); !isCode(err, CodeInternal) {
		t.Fatalf("revoke audit failure = %v", err)
	}
	if repository.invites["rollback-revoke"].RevokedAt != nil {
		t.Fatal("revocation persisted after audit failure")
	}
}

func newMemoryRepository() *memoryRepository {
	return &memoryRepository{
		actors: map[string]*auth.Actor{
			"owner":  {ID: "owner", Kind: "human", Role: "owner", GitHubLogin: "owner"},
			"admin":  {ID: "admin", Kind: "human", Role: "admin", GitHubLogin: "admin"},
			"member": {ID: "member", Kind: "human", Role: "member", GitHubLogin: "member"},
		},
		invites: make(map[string]InviteRecord),
	}
}

func testService(repository Repository, now time.Time) *Service {
	return NewService(ServiceOptions{
		Repository:  repository,
		Now:         func() time.Time { return now },
		IDFactory:   func() (string, error) { return "invite-id", nil },
		CodeFactory: func() (string, error) { return "DL-GENERATED-CODE", nil },
	})
}

func cloneInvites(source map[string]InviteRecord) map[string]InviteRecord {
	result := make(map[string]InviteRecord, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func isCode(err error, code string) bool {
	var domainError *Error
	return errors.As(err, &domainError) && domainError.Code == code
}
