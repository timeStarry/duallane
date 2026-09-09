//go:build postgres_integration

package requirements

import (
	"reflect"
	"testing"
)

func TestPGRequirementReplaysNodePersistedHashesWithoutNewWrites(t *testing.T) {
	fixture := newPGRequirementIntegrationFixture(t)
	ctx, pool, service := fixture.ctx, fixture.pool, fixture.service
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, github_login, display_name, kind, created_at) VALUES ('usr_owner', 'node-contract-owner', 'Owner', 'human', $1)`, fixture.now); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, 'usr_owner', 'owner', $2)`, DefaultSpaceID, fixture.now); err != nil {
		t.Fatal(err)
	}
	for _, golden := range loadNodeRequirementFixtures(t) {
		if golden.Error != "" || golden.Name == "private-ipv6" {
			continue
		}
		t.Run(golden.Name, func(t *testing.T) {
			created, err := service.Submit(ctx, golden.Input)
			if err != nil || created.PublicID != golden.Transition.PublicID {
				t.Fatalf("submit = %#v, err = %v", created, err)
			}
			if _, err := pool.Exec(ctx, `UPDATE echo_requirement_idempotency SET request_hash = $1 WHERE actor_user_id = 'usr_owner' AND operation = 'submit' AND idempotency_key = $2`, golden.Hash, golden.Input.IdempotencyKey); err != nil {
				t.Fatal(err)
			}
			beforeAudit := pgRequirementCount(t, fixture, `SELECT COUNT(*) FROM audit_logs`)
			beforeEvents := pgRequirementCount(t, fixture, `SELECT COUNT(*) FROM workspace_events`)
			replayed, err := service.Submit(ctx, golden.Input)
			if err != nil || !reflect.DeepEqual(replayed, created) {
				t.Fatalf("Node submit replay = %#v, err = %v", replayed, err)
			}
			if pgRequirementCount(t, fixture, `SELECT COUNT(*) FROM audit_logs`) != beforeAudit || pgRequirementCount(t, fixture, `SELECT COUNT(*) FROM workspace_events`) != beforeEvents {
				t.Fatal("submit replay emitted additional audit/event writes")
			}
			transitioned, err := service.Transition(ctx, golden.Transition)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `UPDATE echo_requirement_idempotency SET request_hash = $1 WHERE actor_user_id = 'usr_owner' AND operation = 'transition' AND idempotency_key = $2`, golden.TransitionHash, golden.Transition.IdempotencyKey); err != nil {
				t.Fatal(err)
			}
			beforeAudit = pgRequirementCount(t, fixture, `SELECT COUNT(*) FROM audit_logs`)
			beforeEvents = pgRequirementCount(t, fixture, `SELECT COUNT(*) FROM workspace_events`)
			replayed, err = service.Transition(ctx, golden.Transition)
			if err != nil || !reflect.DeepEqual(replayed, transitioned) {
				t.Fatalf("Node transition replay = %#v, err = %v", replayed, err)
			}
			if pgRequirementCount(t, fixture, `SELECT COUNT(*) FROM audit_logs`) != beforeAudit || pgRequirementCount(t, fixture, `SELECT COUNT(*) FROM workspace_events`) != beforeEvents {
				t.Fatal("transition replay emitted additional audit/event writes")
			}
		})
	}
}
