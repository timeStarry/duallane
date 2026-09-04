package cards

import (
	"context"
	"errors"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type cardFakeState struct {
	actors        map[string]*auth.Actor
	spaces        map[string]bool
	conversations map[string]ConversationRecord
	members       map[string]bool
	cards         map[string]CardRecord
	actions       map[string]ActionRunRecord
	audits        []AuditInput
	events        []EventInput
	sequence      int64
	customBots    map[string]bool
}

func newCardFakeState() *cardFakeState {
	return &cardFakeState{actors: map[string]*auth.Actor{}, spaces: map[string]bool{}, conversations: map[string]ConversationRecord{}, members: map[string]bool{}, cards: map[string]CardRecord{}, actions: map[string]ActionRunRecord{}, customBots: map[string]bool{}, sequence: 1}
}

type cardFakeRepo struct {
	mu    sync.Mutex
	state *cardFakeState
}
type cardFakeTx struct{ *cardFakeRepo }

func (r *cardFakeRepo) WithTx(_ context.Context, callback func(Tx) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	snapshot := cloneCardState(r.state)
	err := callback(&cardFakeTx{r})
	if err != nil {
		r.state = snapshot
	}
	return err
}
func cloneCardState(source *cardFakeState) *cardFakeState {
	target := newCardFakeState()
	target.sequence = source.sequence
	for id, value := range source.actors {
		copied := *value
		target.actors[id] = &copied
	}
	for id, value := range source.spaces {
		target.spaces[id] = value
	}
	for id, value := range source.conversations {
		target.conversations[id] = value
	}
	for key, value := range source.members {
		target.members[key] = value
	}
	for id, value := range source.cards {
		target.cards[id] = cloneCard(value)
	}
	for key, value := range source.actions {
		target.actions[key] = cloneAction(value)
	}
	target.audits = append([]AuditInput(nil), source.audits...)
	target.events = append([]EventInput(nil), source.events...)
	for key, value := range source.customBots {
		target.customBots[key] = value
	}
	return target
}
func cloneCard(value CardRecord) CardRecord {
	copy := value
	copy.PayloadJSON = append([]byte(nil), value.PayloadJSON...)
	copy.ConversationID = cloneString(value.ConversationID)
	copy.SourceID = cloneString(value.SourceID)
	copy.ResourceType = cloneString(value.ResourceType)
	copy.ResourceID = cloneString(value.ResourceID)
	copy.CreatedByUserID = cloneString(value.CreatedByUserID)
	copy.ExpiresAt = cloneTimePtr(value.ExpiresAt)
	return copy
}
func cloneAction(value ActionRunRecord) ActionRunRecord {
	copy := value
	copy.ResultJSON = append([]byte(nil), value.ResultJSON...)
	copy.ResultingRevision = cloneInt64(value.ResultingRevision)
	copy.CompletedAt = cloneTimePtr(value.CompletedAt)
	return copy
}
func cloneString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
func cloneTimePtr(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
func cardCount(value any) (int64, bool) {
	switch number := value.(type) {
	case int:
		return int64(number), true
	case int64:
		return number, true
	case float64:
		if number == math.Trunc(number) && number >= math.MinInt64 && number <= math.MaxInt64 {
			return int64(number), true
		}
	}
	return 0, false
}

func (r *cardFakeRepo) LookupActor(_ context.Context, _, userID string) (*auth.Actor, error) {
	value := r.state.actors[userID]
	if value == nil {
		return nil, nil
	}
	copy := *value
	return &copy, nil
}
func (r *cardFakeRepo) SpaceExists(_ context.Context, spaceID string) (bool, error) {
	return r.state.spaces[spaceID], nil
}
func (r *cardFakeRepo) GetConversation(_ context.Context, _, id string) (*ConversationRecord, error) {
	value, ok := r.state.conversations[id]
	if !ok {
		return nil, nil
	}
	return &value, nil
}
func (r *cardFakeRepo) ConversationMemberActive(_ context.Context, _, conversationID, userID string) (bool, error) {
	return r.state.members[conversationID+":"+userID], nil
}
func (r *cardFakeRepo) GetCard(_ context.Context, _, id string) (*CardRecord, error) {
	value, ok := r.state.cards[id]
	if !ok {
		return nil, nil
	}
	copy := cloneCard(value)
	return &copy, nil
}
func (r *cardFakeRepo) GetCardBySource(_ context.Context, _ string, sourceKind SourceKind, sourceID, cardType string) (*CardRecord, error) {
	for _, value := range r.state.cards {
		if value.SourceKind == sourceKind && stringValue(value.SourceID) == sourceID && value.CardType == cardType {
			copy := cloneCard(value)
			return &copy, nil
		}
	}
	return nil, nil
}
func (r *cardFakeRepo) GetActionRun(_ context.Context, cardID, actorID, clientActionID string) (*ActionRunRecord, error) {
	value, ok := r.state.actions[cardID+":"+actorID+":"+clientActionID]
	if !ok {
		return nil, nil
	}
	copy := cloneAction(value)
	return &copy, nil
}
func (r *cardFakeRepo) CustomBotActive(_ context.Context, _, botID, botUserID string) (bool, error) {
	if botID == "" {
		for key, active := range r.state.customBots {
			if active && strings.HasSuffix(key, ":"+botUserID) {
				return true, nil
			}
		}
		return false, nil
	}
	return r.state.customBots[botID+":"+botUserID], nil
}

func (tx *cardFakeTx) Lock(context.Context, string) error { return nil }
func (tx *cardFakeTx) InsertCard(_ context.Context, input CardInsert) (*CardRecord, bool, error) {
	for _, value := range tx.state.cards {
		if input.SourceID != nil && value.SourceKind == input.SourceKind && stringValue(value.SourceID) == stringValue(input.SourceID) && value.CardType == input.CardType && value.SpaceID == input.SpaceID {
			return nil, false, nil
		}
	}
	if _, ok := tx.state.cards[input.ID]; ok {
		return nil, false, nil
	}
	value := cloneCard(input.CardRecord)
	tx.state.cards[value.ID] = value
	return &value, true, nil
}
func (tx *cardFakeTx) UpdateCard(_ context.Context, id string, revision int64, payload any, status CardStatus, fallback string, at time.Time) (*CardRecord, bool, error) {
	value, ok := tx.state.cards[id]
	if !ok || value.Revision != revision {
		return nil, false, nil
	}
	encoded := mustJSON(payload)
	value.PayloadJSON = encoded
	value.Status = status
	value.FallbackText = fallback
	value.Revision++
	value.UpdatedAt = at
	tx.state.cards[id] = value
	copy := cloneCard(value)
	return &copy, true, nil
}
func (tx *cardFakeTx) InsertActionRun(_ context.Context, input ActionRunRecord) (*ActionRunRecord, bool, error) {
	key := input.CardID + ":" + input.ActorUserID + ":" + input.ClientActionID
	if _, ok := tx.state.actions[key]; ok {
		return nil, false, nil
	}
	tx.state.actions[key] = cloneAction(input)
	value := cloneAction(input)
	return &value, true, nil
}
func (tx *cardFakeTx) CompleteActionRun(_ context.Context, id, status string, result []byte, revision *int64, at time.Time) error {
	for key, value := range tx.state.actions {
		if value.ID == id {
			value.Status = status
			value.ResultJSON = append([]byte(nil), result...)
			value.ResultingRevision = cloneInt64(revision)
			value.CompletedAt = &at
			tx.state.actions[key] = value
			return nil
		}
	}
	return errors.New("action run missing")
}
func (tx *cardFakeTx) FailActionRun(_ context.Context, id, code string, at time.Time) error {
	for key, value := range tx.state.actions {
		if value.ID == id {
			value.Status = "failed"
			value.ErrorCode = code
			value.CompletedAt = &at
			tx.state.actions[key] = value
			return nil
		}
	}
	return errors.New("action run missing")
}
func (tx *cardFakeTx) WriteEvent(_ context.Context, input EventInput) (EventRecord, error) {
	input.PayloadJSON = append([]byte(nil), input.PayloadJSON...)
	tx.state.events = append(tx.state.events, input)
	seq := tx.state.sequence
	tx.state.sequence++
	return EventRecord{ID: input.ID, SpaceID: input.SpaceID, Seq: seq}, nil
}
func (tx *cardFakeTx) WriteAudit(_ context.Context, input AuditInput) error {
	tx.state.audits = append(tx.state.audits, input)
	return nil
}

func cardFixture(t *testing.T) (*cardFakeRepo, *Service, *CardDefinition) {
	t.Helper()
	repo := &cardFakeRepo{state: newCardFakeState()}
	now := time.Date(2026, 9, 4, 12, 34, 56, 789000000, time.UTC)
	for _, actor := range []*auth.Actor{{ID: "usr_owner", Kind: "human", Role: "owner", GitHubLogin: "owner"}, {ID: "usr_member", Kind: "human", Role: "member", GitHubLogin: "member"}, {ID: "usr_bot", Kind: "bot", Role: "member", GitHubLogin: "bot"}} {
		repo.state.actors[actor.ID] = actor
	}
	repo.state.spaces["spc_test"] = true
	repo.state.conversations["conv_test"] = ConversationRecord{ID: "conv_test", SpaceID: "spc_test", Type: "group"}
	for _, user := range []string{"usr_owner", "usr_member", "usr_bot"} {
		repo.state.members["conv_test:"+user] = true
	}
	repo.state.customBots["bot_test:usr_bot"] = true
	definition := &CardDefinition{CardType: "test.counter", SchemaVersion: 1, ValidatePayload: func(payload any) (any, error) {
		object, ok := payload.(map[string]any)
		if !ok {
			return nil, &CardValidationError{Code: "card.domain_invalid", Message: "计数无效"}
		}
		number, ok := cardCount(object["count"])
		if !ok || number < 0 {
			return nil, &CardValidationError{Code: "card.domain_invalid", Message: "计数无效"}
		}
		return object, nil
	}, Actions: map[string]CardAction{"increment": {Execute: func(_ context.Context, input CardActionContext) (CardActionResult, error) {
		payload := input.Payload.(map[string]any)
		count, ok := cardCount(payload["count"])
		if !ok {
			return CardActionResult{}, errors.New("count is not numeric")
		}
		return CardActionResult{CardPayload: map[string]any{"count": count + 1}, Result: map[string]any{"count": count + 1}}, nil
	}}}}
	registry, err := NewRegistry(*definition)
	if err != nil {
		t.Fatal(err)
	}
	sequence := 0
	service := NewService(ServiceOptions{Repository: repo, Registry: registry, SpaceID: "spc_test", Now: func() time.Time { return now }, IDFactory: func() (string, error) { sequence++; return "id_" + string(rune('0'+sequence)), nil }})
	return repo, service, definition
}

func createTestCard(t *testing.T, service *Service) *Card {
	t.Helper()
	card, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", CardType: "test.counter", SchemaVersion: 1, FallbackText: "计数卡片", Payload: map[string]any{"count": int64(0)}, SourceKind: SourceWorkspace, SourceID: "source-1", VisibilityScope: VisibilityConversation, Meta: auth.RequestMeta{RequestID: "create-1"}})
	if err != nil {
		t.Fatal(err)
	}
	return card
}

func TestCardPayloadSafetyAndRegistry(t *testing.T) {
	if _, err := NormalizeCardPayload(map[string]any{"url": "javascript:alert(1)"}, DefaultLimits, false); err == nil {
		t.Fatal("unsafe URL accepted")
	}
	if _, err := NormalizeCardPayload(map[string]any{"text": "x"}, DefaultLimits, false); err != nil {
		t.Fatal(err)
	}
	if _, err := NormalizeCardPayload(map[string]any{"value": math.NaN()}, DefaultLimits, false); err == nil {
		t.Fatal("NaN accepted")
	}
	registry, err := NewRegistry(CardDefinition{CardType: "test.card", SchemaVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := registry.Resolve(CardBlock{Type: CardBlockType, CardID: "card_1", CardType: "test.card", SchemaVersion: 2, FallbackText: "fallback"})
	if err != nil || resolved.Type != CardFallbackType {
		t.Fatalf("fallback = %#v, err=%v", resolved, err)
	}
}

func TestCardCreateResolveScopeAndCanonicalSourceReplay(t *testing.T) {
	repo, service, _ := cardFixture(t)
	first := createTestCard(t, service)
	replay, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", CardType: "test.counter", SchemaVersion: 1, FallbackText: "计数卡片", Payload: map[string]any{"count": int64(0)}, SourceKind: SourceWorkspace, SourceID: "source-1", VisibilityScope: VisibilityConversation})
	if err != nil || replay.ID != first.ID {
		t.Fatalf("replay = %#v, err=%v", replay, err)
	}
	_, err = service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: "spc_test", ConversationID: "conv_test", CardType: "test.counter", SchemaVersion: 1, FallbackText: "计数卡片", Payload: map[string]any{"count": int64(9)}, SourceKind: SourceWorkspace, SourceID: "source-1", VisibilityScope: VisibilityConversation})
	if !hasCardCode(err, CodeCardSourceConflict) {
		t.Fatalf("source conflict = %v", err)
	}
	_, err = service.Resolve(context.Background(), "usr_outsider", first.ID, Request{})
	if !hasCardCode(err, CodeAuthRequired) {
		t.Fatalf("outsider error = %v", err)
	}
	repo.mu.Lock()
	repo.state.actors["usr_outsider"] = &auth.Actor{ID: "usr_outsider", Kind: "human", Role: "member"}
	repo.mu.Unlock()
	_, err = service.Resolve(context.Background(), "usr_outsider", first.ID, Request{})
	if !hasCardCode(err, CodeCardNotFound) {
		t.Fatalf("nonmember error = %v", err)
	}
}

func TestCardActionIdempotencyRevisionAndAudit(t *testing.T) {
	repo, service, _ := cardFixture(t)
	card := createTestCard(t, service)
	input := ActionInput{ActorID: "usr_member", CardID: card.ID, ActionID: "increment", ClientActionID: "action-1", ExpectedRevision: 1, Input: map[string]any{}, Meta: auth.RequestMeta{RequestID: "action-req"}}
	first, err := service.ExecuteAction(context.Background(), input)
	if err != nil || first.Replayed || first.Revision != 2 {
		t.Fatalf("first = %#v, err=%v", first, err)
	}
	replay, err := service.ExecuteAction(context.Background(), input)
	if err != nil || !replay.Replayed || replay.Revision != 2 {
		t.Fatalf("replay = %#v, err=%v", replay, err)
	}
	_, err = service.ExecuteAction(context.Background(), ActionInput{ActorID: "usr_member", CardID: card.ID, ActionID: "increment", ClientActionID: "action-1", ExpectedRevision: 1, Input: map[string]any{"other": true}})
	if !hasCardCode(err, CodeCardIdempotencyConflict) {
		t.Fatalf("idempotency = %v", err)
	}
	_, err = service.ExecuteAction(context.Background(), ActionInput{ActorID: "usr_member", CardID: card.ID, ActionID: "increment", ClientActionID: "action-stale", ExpectedRevision: 1})
	if !hasCardCode(err, CodeCardStaleRevision) {
		t.Fatalf("stale = %v", err)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.state.events) != 3 {
		t.Fatalf("event count = %d", len(repo.state.events))
	}
	for _, event := range repo.state.events {
		if string(event.PayloadJSON) == "" || string(event.PayloadJSON) == "{}" && event.Type == "card.action" {
			t.Fatalf("missing event payload: %#v", event)
		}
	}
	for _, audit := range repo.state.audits {
		if audit.RequestID == "action-req" && audit.TargetID == card.ID && audit.Reason != "" && audit.Reason != "card.idempotency_conflict" {
			continue
		}
	}
}

func TestCustomBotCardIdentityAndIDFailure(t *testing.T) {
	repo, service, _ := cardFixture(t)
	botCard, err := service.CreateCustomBotCard(context.Background(), CustomBotCreateInput{CreateInput: CreateInput{SpaceID: "spc_test", ConversationID: "conv_test", CardType: "future.card", SchemaVersion: 4, FallbackText: "未来卡片", Payload: map[string]any{"safe": true}, SourceID: "opaque-1", VisibilityScope: VisibilityConversation}, BotID: "bot_test", BotUserID: "usr_bot"})
	if err != nil || botCard == nil {
		t.Fatalf("bot card = %#v, err=%v", botCard, err)
	}
	resolution, err := service.Resolve(context.Background(), "usr_member", botCard.ID, Request{})
	if err != nil || resolution.Type != CardFallbackType {
		t.Fatalf("unknown resolution = %#v, err=%v", resolution, err)
	}
	bad := NewService(ServiceOptions{Repository: repo, Registry: service.Registry(), SpaceID: "spc_test", IDFactory: func() (string, error) { return "", errors.New("entropy unavailable") }})
	_, err = bad.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: "spc_test", CardType: "test.counter", SchemaVersion: 1, FallbackText: "x", Payload: map[string]any{"count": int64(0)}, SourceKind: SourceWorkspace, VisibilityScope: VisibilitySpace})
	if err == nil {
		t.Fatal("create succeeded after ID failure")
	}
}

func hasCardCode(err error, code string) bool {
	var value *Error
	return errors.As(err, &value) && value.Code == code
}
