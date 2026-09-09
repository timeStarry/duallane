//go:build postgres_integration

package delivery

import (
	"fmt"
	"testing"
)

func TestPGDeliveryRecoveryPagesPastTerminalAndExhaustedWork(t *testing.T) {
	f := newPGDeliveryIntegrationFixture(t)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := f.pool.Exec(f.ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	// Permanent first-page rows must not prevent inspecting later work.
	exec(`UPDATE echo_solicitation_deliveries SET status = 'sent'`)
	for i := 1; i <= 5; i++ {
		if i > 1 {
			exec(`INSERT INTO echo_solicitations (id, public_id, space_id, owner_user_id, title, description, question, choice_mode, min_selections, max_selections, allow_vote_change, result_visibility, delivery_policy, status, revision, created_at, updated_at)
			SELECT $1, $2, space_id, owner_user_id, title, description, question, choice_mode, min_selections, max_selections, allow_vote_change, result_visibility, delivery_policy, status, revision, created_at, updated_at FROM echo_solicitations WHERE id = 'sol-delivery-1'`, fmt.Sprintf("sol-delivery-%d", i), fmt.Sprintf("SOL-2026-%04d", i))
			exec(`INSERT INTO echo_solicitation_deliveries (id, space_id, solicitation_id, recipient_user_id, status, attempt_count, created_at, updated_at) VALUES ($1,$2,$3,$4,'failed',99,$5,$5)`, fmt.Sprintf("echo_delivery_row_%d", i), f.spaceID, fmt.Sprintf("sol-delivery-%d", i), f.memberID, f.now)
		}
		exec(`INSERT INTO echo_requirements (id,public_id,space_id,submitter_user_id,type,title,detail,scenario,expected_result,created_at,updated_at) VALUES ($1,$2,$3,$4,'requirement','Synthetic','Synthetic','Synthetic','Synthetic',$5,$5)`, fmt.Sprintf("req-%d", i), fmt.Sprintf("REQ-2026-%04d", i), f.spaceID, f.memberID, f.now)
		exec(`INSERT INTO echo_release_publications (id,space_id,version,title,guide_hash,guide_json,published_by_user_id,published_at) VALUES ($1,$2,$3,'Synthetic',repeat('0',64),'{}','usr_echo_delivery_owner',$4)`, fmt.Sprintf("release-%d", i), f.spaceID, fmt.Sprintf("0.0.%d", i), f.now)
		exec(`INSERT INTO echo_release_deliveries (id,space_id,publication_id,recipient_user_id,status,attempt_count,created_at,updated_at) VALUES ($1,$2,$3,$4,'failed',99,$5,$5)`, fmt.Sprintf("release-delivery-%d", i), f.spaceID, fmt.Sprintf("release-%d", i), f.memberID, f.now)
	}
	cursor := WorkCursor{}
	counts := WorkCursor{}
	seen := map[string]map[string]bool{"sol": {}, "req": {}, "rel": {}}
	for page := 0; page < 3; page++ {
		sol, err := f.repository.ListSolicitationWork(f.ctx, f.spaceID, cursor.Solicitation, 2)
		if err != nil {
			t.Fatal(err)
		}
		req, err := f.repository.ListRequirementsForRecovery(f.ctx, f.spaceID, cursor.Requirement, 2)
		if err != nil {
			t.Fatal(err)
		}
		rel, err := f.repository.ListReleaseWork(f.ctx, f.spaceID, cursor.Release, 2)
		if err != nil {
			t.Fatal(err)
		}
		if len(sol) > 2 || len(req) > 2 || len(rel) > 2 {
			t.Fatal("unbounded work page")
		}
		for _, row := range sol {
			seen["sol"][row.ID] = true
			cursor.Solicitation = row.ID
		}
		for _, row := range req {
			seen["req"][row.ID] = true
			cursor.Requirement = row.ID
		}
		for _, row := range rel {
			seen["rel"][row.ID] = true
			cursor.Release = row.ID
		}
		counts = cursor
	}
	for family, rows := range seen {
		if len(rows) != 5 {
			t.Fatalf("%s only reached %d/5 rows (last keys %+v)", family, len(rows), counts)
		}
	}
}

func TestPGRequirementDeliveryRechecksRecipientRole(t *testing.T) {
	f := newPGDeliveryIntegrationFixture(t)
	tx, err := f.pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)
	if _, err := tx.Exec(f.ctx, `UPDATE space_members SET role = 'member' WHERE space_id = $1 AND user_id = 'usr_echo_delivery_owner'`, f.spaceID); err != nil {
		t.Fatal(err)
	}
	view := NewPGTransaction(tx)
	allowed, err := view.RequirementRecipientAuthorized(f.ctx, f.spaceID, "usr_echo_delivery_owner", f.memberID, CardTypeRequest)
	if err != nil || allowed {
		t.Fatalf("demoted non-submitter received private requirement: %v, %v", allowed, err)
	}
	allowed, err = view.RequirementRecipientAuthorized(f.ctx, f.spaceID, f.memberID, f.memberID, CardTypeStatus)
	if err != nil || !allowed {
		t.Fatalf("active submitter lost own projection: %v, %v", allowed, err)
	}
}
