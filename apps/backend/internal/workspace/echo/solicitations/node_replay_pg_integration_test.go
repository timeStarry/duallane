//go:build postgres_integration

package solicitations

import (
	"reflect"
	"testing"
)

func TestPGSolicitationReplaysNodePersistedHashesWithoutNewWrites(t *testing.T) {
	fixture := newPGSolicitationIntegrationFixture(t)
	golden := loadNodeSolicitationFixtures(t)[0]

	created, err := fixture.service.Create(fixture.ctx, golden.Input)
	if err != nil || created.PublicID != golden.Transition.PublicID {
		t.Fatalf("create = %#v, err = %v", created, err)
	}
	var persistedHash string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT request_hash FROM echo_solicitation_idempotency WHERE actor_user_id = $1 AND operation = 'create' AND idempotency_key = $2`, golden.Input.ActorID, golden.Input.IdempotencyKey).Scan(&persistedHash); err != nil {
		t.Fatal(err)
	}
	if persistedHash != golden.Hash {
		t.Fatalf("persisted create hash = %s, want Node hash %s", persistedHash, golden.Hash)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE echo_solicitation_idempotency SET request_hash = $1 WHERE actor_user_id = $2 AND operation = 'create' AND idempotency_key = $3`, golden.Hash, golden.Input.ActorID, golden.Input.IdempotencyKey); err != nil {
		t.Fatal(err)
	}
	beforeAudit := pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM audit_logs`)
	beforeEvents := pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM workspace_events`)
	replayed, err := fixture.service.Create(fixture.ctx, golden.Input)
	if err != nil || !reflect.DeepEqual(replayed, created) {
		t.Fatalf("Node create replay = %#v, err = %v", replayed, err)
	}
	if pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM audit_logs`) != beforeAudit || pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM workspace_events`) != beforeEvents {
		t.Fatal("create replay emitted additional audit/event writes")
	}

	published, err := fixture.service.Publish(fixture.ctx, golden.Transition)
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT request_hash FROM echo_solicitation_idempotency WHERE actor_user_id = $1 AND operation = 'publish' AND idempotency_key = $2`, golden.Transition.ActorID, golden.Transition.IdempotencyKey).Scan(&persistedHash); err != nil {
		t.Fatal(err)
	}
	if persistedHash != golden.TransitionHash {
		t.Fatalf("persisted publish hash = %s, want Node hash %s", persistedHash, golden.TransitionHash)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE echo_solicitation_idempotency SET request_hash = $1 WHERE actor_user_id = $2 AND operation = 'publish' AND idempotency_key = $3`, golden.TransitionHash, golden.Transition.ActorID, golden.Transition.IdempotencyKey); err != nil {
		t.Fatal(err)
	}
	beforeAudit = pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM audit_logs`)
	beforeEvents = pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM workspace_events`)
	replayed, err = fixture.service.Publish(fixture.ctx, golden.Transition)
	if err != nil || !reflect.DeepEqual(replayed, published) {
		t.Fatalf("Node publish replay = %#v, err = %v", replayed, err)
	}
	if pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM audit_logs`) != beforeAudit || pgSolicitationCount(t, fixture, `SELECT COUNT(*) FROM workspace_events`) != beforeEvents {
		t.Fatal("publish replay emitted additional audit/event writes")
	}
}
