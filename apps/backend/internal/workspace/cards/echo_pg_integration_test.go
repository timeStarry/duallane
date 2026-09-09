//go:build postgres_integration

package cards

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestPGEchoCardRevisionReplayAndRollback(t *testing.T) {
	f := newPGCardIntegrationFixture(t)
	for _, query := range []string{
		`INSERT INTO users (id,github_login,display_name,kind,created_at) VALUES ('usr_system_echo','__duallane_echo__','Echo','bot',NOW())`,
		`INSERT INTO space_members (space_id,user_id,role,joined_at) VALUES ('spc_default','usr_system_echo','member',NOW())`,
		`INSERT INTO conversations (id,space_id,type,title,retention_count,created_by,created_at) VALUES ('conv-echo-card','spc_default','direct','Echo',10000,'usr_card_owner',NOW())`,
		`INSERT INTO conversation_members (conversation_id,user_id,joined_at) VALUES ('conv-echo-card','usr_system_echo',NOW()),('conv-echo-card','usr_card_owner',NOW())`,
	} {
		if _, err := f.pool.Exec(f.ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	registry, err := NewRegistry(CardDefinition{CardType: "echo.test", SchemaVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	repo := NewPGRepository(f.pool)
	service := NewService(ServiceOptions{Repository: repo, Registry: registry, Now: func() time.Time { return f.now }})
	input := EchoUpsertInput{
		SpaceID: DefaultSpaceID, ConversationID: "conv-echo-card", CardID: "card_echo_test",
		CardType: "echo.test", SchemaVersion: 1, SourceID: "echo-test-source", ResourceType: "echo.requirement",
		ResourceID: "REQ-2026-0001", FallbackText: "Safe summary", DomainRevision: 5,
		Payload: map[string]any{"revision": 5, "status": "pending"},
	}
	upsert := func(input EchoUpsertInput, abort bool) (*Card, bool, error) {
		var card *Card
		var replayed bool
		err := repo.WithTx(f.ctx, func(tx Tx) error {
			var err error
			card, replayed, err = service.UpsertEchoCardInTx(f.ctx, tx, input)
			if err == nil && abort {
				return errors.New("synthetic later message failure")
			}
			return err
		})
		return card, replayed, err
	}
	card, replayed, err := upsert(input, false)
	if err != nil || card == nil || card.Revision != 5 || replayed {
		t.Fatalf("create=%+v replay=%v err=%v", card, replayed, err)
	}
	card, replayed, err = upsert(input, false)
	if err != nil || card.Revision != 5 || !replayed {
		t.Fatalf("replay=%+v replayed=%v err=%v", card, replayed, err)
	}
	input.DomainRevision = 9
	input.Payload = map[string]any{"revision": 9, "status": "planned"}
	if _, _, err := upsert(input, true); err == nil {
		t.Fatal("injected outer failure committed")
	}
	if count := pgCardCount(t, f, `SELECT COUNT(*) FROM workspace_cards WHERE id='card_echo_test' AND revision=5`); count != 1 {
		t.Fatal("outer failure retained a card revision")
	}
	var wg sync.WaitGroup
	errorsCh := make(chan error, 8)
	for range 8 {
		wg.Go(func() {
			card, _, err := upsert(input, false)
			if err != nil || card == nil || card.Revision != 9 {
				errorsCh <- fmt.Errorf("concurrent refresh card=%+v err=%v", card, err)
			}
		})
	}
	wg.Wait()
	close(errorsCh)
	for err := range errorsCh {
		t.Error(err)
	}
	if count := pgCardCount(t, f, `SELECT COUNT(*) FROM workspace_events WHERE target_id='card_echo_test' AND type IN ('card.created','card.updated')`); count != 2 {
		t.Fatalf("retries/rollback duplicated events: %d", count)
	}
	input.ResourceID = "REQ-2026-0002"
	if _, _, err := upsert(input, false); err == nil {
		t.Fatal("rebound an existing source to another private resource")
	}
	input.ResourceID = "REQ-2026-0001"
	if _, err := f.pool.Exec(f.ctx, `UPDATE users SET kind='human' WHERE id='usr_system_echo'`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := upsert(input, false); err == nil {
		t.Fatal("forged human Echo identity refreshed a card")
	}
}
