package botgateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/feishucards"
)

type fakeRepository struct {
	mu            sync.Mutex
	auth          *Auth
	valid         bool
	settings      *Settings
	connection    *Connection
	conversations map[string]*Conversation
	members       map[string]bool
	groups        map[string]*GroupPolicy
	grants        map[string]*ContextGrant
	context       map[string][]ContextMessageRecord
	attachments   map[string]*AttachmentRecord
	events        []EventRecord
	deliveries    []DeliveryRecord
	triggers      map[string]*MessageTrigger
	senders       map[string]*Sender
	visibility    map[string]bool
	limits        *Limits
	idempotency   map[string]IdempotencyRecord
	audits        []AuditInput
	processed     int
}

func newFakeRepository() *fakeRepository {
	return &fakeRepository{
		valid:         true,
		conversations: map[string]*Conversation{},
		members:       map[string]bool{},
		groups:        map[string]*GroupPolicy{},
		grants:        map[string]*ContextGrant{},
		context:       map[string][]ContextMessageRecord{},
		attachments:   map[string]*AttachmentRecord{},
		triggers:      map[string]*MessageTrigger{},
		senders:       map[string]*Sender{},
		visibility:    map[string]bool{},
		limits:        &Limits{RequestsPerMinute: 100, MemberDailyRequests: 100, EventBacklogLimit: 100},
		idempotency:   map[string]IdempotencyRecord{},
	}
}

func cloneFakeAuth(value *Auth) *Auth {
	if value == nil {
		return nil
	}
	copy := *value
	copy.Scopes = append([]string(nil), value.Scopes...)
	return &copy
}

func (r *fakeRepository) LookupToken(context.Context, string, TokenAuthOptions, time.Time) (*Auth, error) {
	if !r.valid {
		return nil, nil
	}
	return cloneFakeAuth(r.auth), nil
}
func (r *fakeRepository) ValidateToken(context.Context, string, string, string, time.Time) (*Auth, error) {
	if !r.valid {
		return nil, nil
	}
	return cloneFakeAuth(r.auth), nil
}
func (r *fakeRepository) GetSettings(context.Context, string, string) (*Settings, error) {
	return r.settings, nil
}
func (r *fakeRepository) GetConnection(context.Context, string, string) (*Connection, error) {
	return r.connection, nil
}
func (r *fakeRepository) GetConversation(_ context.Context, _, id string) (*Conversation, error) {
	value := r.conversations[id]
	if value == nil {
		return nil, nil
	}
	copy := *value
	return &copy, nil
}
func (r *fakeRepository) ConversationMemberActive(_ context.Context, _, conversationID, userID string) (bool, error) {
	return r.members[conversationID+":"+userID], nil
}
func (r *fakeRepository) GetGroupPolicy(_ context.Context, _, _, conversationID string) (*GroupPolicy, error) {
	return r.groups[conversationID], nil
}
func (r *fakeRepository) GetContextGrant(_ context.Context, _, _, conversationID string) (*ContextGrant, error) {
	return r.grants[conversationID], nil
}
func (r *fakeRepository) ListContextMessages(_ context.Context, _, conversationID string, _ time.Time, _, _ bool, limit int) ([]ContextMessageRecord, error) {
	rows := append([]ContextMessageRecord(nil), r.context[conversationID]...)
	if len(rows) > limit {
		rows = rows[:limit]
	}
	return rows, nil
}
func (r *fakeRepository) GetAttachment(_ context.Context, _, id string) (*AttachmentRecord, error) {
	value := r.attachments[id]
	if value == nil {
		return nil, nil
	}
	copy := *value
	return &copy, nil
}
func (r *fakeRepository) CurrentSequence(context.Context, string) (int64, error) {
	var result int64
	for _, event := range r.events {
		if event.Sequence > result {
			result = event.Sequence
		}
	}
	return result, nil
}
func (r *fakeRepository) ListReplayEvents(_ context.Context, value *Auth, scan ReplayRange, since time.Time, limit int) ([]EventRecord, error) {
	rows := make([]EventRecord, 0, limit)
	queued := make(map[int64]bool)
	for _, delivery := range r.deliveries {
		if delivery.BotID == value.BotID && delivery.SpaceID == value.SpaceID {
			queued[delivery.Sequence] = true
		}
	}
	for _, event := range r.events {
		if event.SpaceID != value.SpaceID || event.Sequence <= scan.After || event.Sequence > scan.Through ||
			!event.CreatedAt.After(since) || eventScope(event.EventType) == "" || queued[event.Sequence] {
			continue
		}
		if event.EventType == "bot.runtime_upgrade" || r.members[event.ConversationID+":"+value.UserID] {
			rows = append(rows, event)
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Sequence < rows[j].Sequence })
	if len(rows) > limit {
		rows = rows[:limit]
	}
	return rows, nil
}
func (r *fakeRepository) GetEvent(_ context.Context, _, id string) (*EventRecord, error) {
	for _, event := range r.events {
		if event.ID == id {
			copy := event
			return &copy, nil
		}
	}
	return nil, nil
}
func (r *fakeRepository) ListPendingDeliveries(_ context.Context, botID, spaceID string, scan ReplayRange, now time.Time, limit int) ([]DeliveryRecord, error) {
	rows := make([]DeliveryRecord, 0, limit)
	for _, delivery := range r.deliveries {
		if delivery.BotID == botID && delivery.SpaceID == spaceID && delivery.Sequence > scan.After && delivery.Sequence <= scan.Through &&
			(delivery.Status == "queued" || delivery.Status == "delivered") && delivery.ExpiresAt.After(now) {
			rows = append(rows, delivery)
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Sequence < rows[j].Sequence })
	if len(rows) > limit {
		rows = rows[:limit]
	}
	return rows, nil
}
func (r *fakeRepository) GetMessageTrigger(_ context.Context, _, conversationID, messageID string) (*MessageTrigger, error) {
	return r.triggers[conversationID+":"+messageID], nil
}
func (r *fakeRepository) GetSender(_ context.Context, _, conversationID, userID string) (*Sender, error) {
	return r.senders[conversationID+":"+userID], nil
}
func (r *fakeRepository) VisibilityMember(_ context.Context, _, _, userID string) (bool, error) {
	return r.visibility[userID], nil
}
func (r *fakeRepository) GetLimits(context.Context, string, string) (*Limits, error) {
	return r.limits, nil
}
func (r *fakeRepository) CountRecentDeliveries(_ context.Context, botID, spaceID string, since time.Time) (int, error) {
	count := 0
	for _, row := range r.deliveries {
		if row.BotID == botID && row.SpaceID == spaceID && !row.CreatedAt.Before(since) {
			count++
		}
	}
	return count, nil
}
func (r *fakeRepository) CountMemberDeliveries(_ context.Context, botID, spaceID, actor string, since time.Time) (int, error) {
	count := 0
	for _, row := range r.deliveries {
		if row.BotID != botID || row.SpaceID != spaceID || row.CreatedAt.Before(since) {
			continue
		}
		for _, event := range r.events {
			if event.ID == row.EventID && event.ActorUserID == actor {
				count++
			}
		}
	}
	return count, nil
}
func (r *fakeRepository) CountPendingDeliveries(_ context.Context, botID, spaceID string, now time.Time) (int, error) {
	count := 0
	for _, row := range r.deliveries {
		if row.BotID == botID && row.SpaceID == spaceID && (row.Status == "queued" || row.Status == "delivered") && row.ExpiresAt.After(now) {
			count++
		}
	}
	return count, nil
}

func (r *fakeRepository) WithTx(_ context.Context, callback func(Tx) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return callback(r)
}
func (r *fakeRepository) Lock(context.Context, string) error { return nil }
func (r *fakeRepository) GetIdempotency(_ context.Context, botID, operation, key string, now time.Time) (*IdempotencyRecord, error) {
	value, ok := r.idempotency[botID+":"+operation+":"+key]
	if !ok || !value.ExpiresAt.After(now) {
		return nil, nil
	}
	copy := value
	copy.ResponseJSON = append([]byte(nil), value.ResponseJSON...)
	return &copy, nil
}
func (r *fakeRepository) InsertIdempotency(_ context.Context, input IdempotencyRecordInput) (bool, error) {
	key := input.BotID + ":" + input.Operation + ":" + input.Key
	if _, exists := r.idempotency[key]; exists {
		return false, nil
	}
	r.idempotency[key] = IdempotencyRecord{RequestHash: input.RequestHash, ResponseJSON: append([]byte(nil), input.ResponseJSON...), ExpiresAt: input.ExpiresAt}
	return true, nil
}
func (r *fakeRepository) ExpireDeliveries(_ context.Context, botID, spaceID string, now time.Time) error {
	for index := range r.deliveries {
		row := &r.deliveries[index]
		if row.BotID == botID && row.SpaceID == spaceID &&
			(row.Status == "queued" || row.Status == "delivered") && !row.ExpiresAt.After(now) {
			row.Status = "expired"
		}
	}
	return nil
}
func (r *fakeRepository) ExpireDelivery(_ context.Context, id string) error {
	for index := range r.deliveries {
		row := &r.deliveries[index]
		if row.ID == id && (row.Status == "queued" || row.Status == "delivered") {
			row.Status = "expired"
		}
	}
	return nil
}
func (r *fakeRepository) InsertDelivery(_ context.Context, input DeliveryInsert) (bool, error) {
	for _, row := range r.deliveries {
		if row.BotID == input.BotID && row.Sequence == input.Sequence {
			return false, nil
		}
	}
	r.deliveries = append(r.deliveries, DeliveryRecord{ID: input.ID, BotID: input.BotID, SpaceID: input.SpaceID, Sequence: input.Sequence, EventID: input.EventID, EventType: input.EventType, ConversationID: input.ConversationID, PayloadJSON: append([]byte(nil), input.PayloadJSON...), Status: input.Status, Attempts: input.Attempts, CreatedAt: input.CreatedAt, ExpiresAt: input.ExpiresAt})
	return true, nil
}
func (r *fakeRepository) MarkDeliveryDelivered(_ context.Context, id string, now time.Time) (int, error) {
	for index := range r.deliveries {
		row := &r.deliveries[index]
		if row.ID == id && (row.Status == "queued" || row.Status == "delivered") && row.ExpiresAt.After(now) {
			row.Status = "delivered"
			row.Attempts++
			return row.Attempts, nil
		}
	}
	return 0, nil
}
func (r *fakeRepository) AcknowledgeDelivery(_ context.Context, botID, spaceID, eventID string, sequence int64, now time.Time) (bool, bool, error) {
	for index := range r.deliveries {
		row := &r.deliveries[index]
		if row.BotID != botID || row.SpaceID != spaceID ||
			(eventID != "" && row.EventID != eventID) || (sequence != 0 && row.Sequence != sequence) {
			continue
		}
		if row.Status == "acked" {
			return true, false, nil
		}
		if row.Status == "delivered" && row.ExpiresAt.After(now) {
			row.Status = "acked"
			return true, true, nil
		}
	}
	return false, false, nil
}
func (r *fakeRepository) MarkProcessed(context.Context, string, string, time.Time) error {
	r.processed++
	return nil
}
func (r *fakeRepository) WriteAudit(_ context.Context, input AuditInput) error {
	r.audits = append(r.audits, input)
	return nil
}
func (r *fakeRepository) HasExpiredDeliveries(_ context.Context, botID, spaceID string, scan ReplayRange, now time.Time) (bool, error) {
	for _, row := range r.deliveries {
		if row.BotID == botID && row.SpaceID == spaceID && row.Sequence > scan.After && row.Sequence <= scan.Through &&
			(row.Status == "expired" || ((row.Status == "queued" || row.Status == "delivered") && !row.ExpiresAt.After(now))) {
			return true, nil
		}
	}
	return false, nil
}

type fakeMessageWriter struct {
	count   int
	message GatewayMessage
}

func (w *fakeMessageWriter) CreateBotMessage(_ context.Context, input MessageWriteRequest) (GatewayMessage, error) {
	w.count++
	if w.message.ID == "" {
		w.message = GatewayMessage{
			ID:             "message_gateway",
			ConversationID: input.ConversationID,
			PlainText:      input.Content.PlainText,
			Content:        map[string]any{"format": input.Content.Format, "plainText": input.Content.PlainText, "blocks": input.Content.Blocks},
			CreatedAt:      "2026-09-04T04:00:00.789Z",
		}
	}
	return w.message, nil
}

type fakeCardGateway struct {
	count       int
	card        Card
	lastRequest CardCreateRequest
	lastUpdate  CardUpdateRequest
	ownerError  error
	validation  error
}

func (w *fakeCardGateway) CreateCustomBotCard(_ context.Context, input CardCreateRequest) (Card, error) {
	w.count++
	w.lastRequest = input
	if w.card.ID == "" {
		w.card = Card{ID: "card_gateway", BotID: input.BotID, SpaceID: input.SpaceID, ConversationID: input.ConversationID, CardType: input.CardType, SchemaVersion: input.SchemaVersion, Payload: input.Payload, FallbackText: input.FallbackText, Revision: 1, Status: "active"}
	}
	return w.card, nil
}
func (w *fakeCardGateway) UpdateCustomBotCard(_ context.Context, input CardUpdateRequest) (Card, error) {
	w.count++
	w.lastUpdate = input
	return w.card, nil
}

func (w *fakeCardGateway) CheckFeishuCardOwner(context.Context, string, string, string) error {
	return w.ownerError
}
func (w *fakeCardGateway) InvalidateCustomBotCard(_ context.Context, input CardUpdateRequest) (Card, error) {
	w.card.Status = "invalidated"
	return w.card, nil
}
func (w *fakeCardGateway) ValidateMessageCardReference(context.Context, string, string, map[string]any) error {
	return w.validation
}

func gatewayFixture(t *testing.T) (*fakeRepository, *Service, *Auth, *fakeMessageWriter, *fakeCardGateway) {
	t.Helper()
	repo := newFakeRepository()
	repo.auth = &Auth{
		TokenID: "token_1", BotID: "bot_1", UserID: "bot_user", SpaceID: "spc_default", OwnerUserID: "owner_1",
		Scopes: []string{ScopeMessagesReadContext, ScopeMessagesSend, ScopeCardsWrite, ScopeFilesReadMetadata, ScopeFilesWrite, ScopeMessagesReadTrigger},
		Bot:    Bot{ID: "bot_1", BotUserID: "bot_user", OwnerUserID: "owner_1", SpaceID: "spc_default", ConversationPolicy: "group-capable", Status: "active"},
	}
	repo.settings = &Settings{
		AllowDirect: true, AllowGroup: true, VisibilityPolicy: "space_members",
		MaxContextMessages: 20, MaxContextChars: 10000, MaxContextTokens: 10000, ContextWindowSeconds: 86400, IncludeReplies: true,
	}
	repo.conversations["conv_direct"] = &Conversation{ID: "conv_direct", SpaceID: "spc_default", Type: "direct", Title: "Direct", CreatedAt: repo.authenticatedNow()}
	repo.members["conv_direct:bot_user"] = true
	repo.members["conv_direct:owner_1"] = true
	repo.grants["conv_direct"] = &ContextGrant{AllowTrigger: true, AllowContext: true, MaxMessages: intPointer(20)}
	repo.groups["conv_group"] = &GroupPolicy{Status: "active"}
	repo.conversations["conv_group"] = &Conversation{ID: "conv_group", SpaceID: "spc_default", Type: "group", Title: "Group", CreatedAt: repo.authenticatedNow()}
	repo.members["conv_group:bot_user"] = true
	repo.members["conv_group:owner_1"] = true
	repo.grants["conv_group"] = &ContextGrant{AllowTrigger: true}
	repo.senders["conv_direct:owner_1"] = &Sender{ID: "owner_1", Kind: "human", Role: "owner"}
	repo.senders["conv_group:owner_1"] = &Sender{ID: "owner_1", Kind: "human", Role: "owner"}
	writer := &fakeMessageWriter{}
	card := &fakeCardGateway{}
	service := NewService(ServiceOptions{Repository: repo, MessageWriter: writer, CardGateway: card, SpaceID: "spc_default", Now: repo.now, IDFactory: sequenceIDs()})
	return repo, service, cloneFakeAuth(repo.auth), writer, card
}

func (r *fakeRepository) now() time.Time {
	return time.Date(2026, 9, 4, 12, 0, 0, 789654321, time.UTC)
}

func (r *fakeRepository) authenticatedNow() time.Time {
	return r.now()
}

func sequenceIDs() IDFactory {
	index := 0
	return func() (string, error) {
		index++
		return "id_" + strconv.Itoa(index), nil
	}
}

func intPointer(value int) *int { return &value }

func TestExtractBearerTokenAndCurrentValidation(t *testing.T) {
	if _, err := ExtractBearerToken("Basic dl_bot_" + strings.Repeat("x", 32)); !isCode(err, CodeInvalidToken) {
		t.Fatalf("invalid envelope error = %v", err)
	}
	raw := "dl_bot_" + strings.Repeat("x", 32)
	if got, err := ExtractBearerToken("Bearer " + raw); err != nil || got != raw {
		t.Fatalf("header token = %q, err=%v", got, err)
	}
	if got, err := ExtractBearerToken(raw); err != nil || got != raw {
		t.Fatalf("raw token = %q, err=%v", got, err)
	}
	repo, service, authValue, _, _ := gatewayFixture(t)
	repo.valid = false
	if _, err := service.ValidateAuth(context.Background(), authValue); !isCode(err, CodeInvalidToken) {
		t.Fatalf("revoked token error = %v", err)
	}
}

func TestRequireConversationRepeatsMembershipAndPolicy(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	if _, err := service.RequireConversation(context.Background(), authValue, "conv_direct"); err != nil {
		t.Fatal(err)
	}
	repo.members["conv_direct:bot_user"] = false
	if _, err := service.RequireConversation(context.Background(), authValue, "conv_direct"); !isCode(err, CodeConversationNotFound) {
		t.Fatalf("removed membership error = %v", err)
	}
	repo.members["conv_direct:bot_user"] = true
	repo.settings.AllowDirect = false
	if _, err := service.RequireConversation(context.Background(), authValue, "conv_direct"); !isCode(err, CodeConversationForbidden) {
		t.Fatalf("direct policy error = %v", err)
	}
	repo.settings.AllowGroup = false
	if _, err := service.RequireConversation(context.Background(), authValue, "conv_group"); !isCode(err, CodeConversationForbidden) {
		t.Fatalf("group policy error = %v", err)
	}
}

func TestContextGrantProjectionAndBudgets(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	repo.settings.MaxContextChars = 1000
	repo.settings.MaxContextTokens = 1000
	repo.context["conv_direct"] = []ContextMessageRecord{
		{
			ID: "new", ConversationID: "conv_direct", AuthorKind: "bot", Kind: "bot", ContentFormat: MessageContentFormat,
			ContentJSON: []byte(`{"format":"duallane.message+json;v=1","plainText":"new","blocks":[{"type":"attachment","attachmentId":"att_1","secret":"drop"}]}`),
			PlainText:   "new", CreatedAt: repo.now(),
		},
		{
			ID: "old", ConversationID: "conv_direct", AuthorKind: "human", Kind: "user", ContentFormat: MessageContentFormat,
			ContentJSON: []byte(`{"format":"duallane.message+json;v=1","plainText":"old","blocks":[{"type":"text","text":"old"}]}`),
			PlainText:   "old", CreatedAt: repo.now().Add(-time.Minute),
		},
	}
	result, err := service.GetContext(context.Background(), authValue, "conv_direct", map[string]any{"limit": "20"})
	if err != nil {
		t.Fatal(err)
	}
	if result["conversation"].(ConversationProjection).ID != "conv_direct" {
		t.Fatalf("conversation projection = %#v", result["conversation"])
	}
	rows := result["messages"].([]ContextMessage)
	if len(rows) != 2 || rows[0].ID != "old" || rows[1].ID != "new" {
		t.Fatalf("context order = %#v", rows)
	}
	block := rows[1].Content["blocks"].([]any)[0].(map[string]any)
	if _, leaked := block["secret"]; leaked {
		t.Fatal("attachment block leaked private field")
	}
	repo.grants["conv_direct"] = &ContextGrant{AllowContext: false}
	if _, err := service.GetContext(context.Background(), authValue, "conv_direct", nil); !isCode(err, CodeContextForbidden) {
		t.Fatalf("missing grant error = %v", err)
	}
}

func TestSendMessageIdempotencyAndForgedFields(t *testing.T) {
	_, service, authValue, writer, _ := gatewayFixture(t)
	input := SendMessageInput{ConversationID: "conv_direct", ClientMessageID: "client_1", IdempotencyKey: "idem_1", Text: "hello"}
	first, err := service.SendMessage(context.Background(), authValue, input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.SendMessage(context.Background(), authValue, input)
	if err != nil {
		t.Fatal(err)
	}
	if first.Message.ID != second.Message.ID || writer.count != 1 {
		t.Fatalf("idempotency first=%#v second=%#v writes=%d", first, second, writer.count)
	}
	input.Text = "changed"
	if _, err := service.SendMessage(context.Background(), authValue, input); !isCode(err, CodeIdempotencyConflict) {
		t.Fatalf("idempotency conflict = %v", err)
	}
	if _, err := service.SendMessage(context.Background(), authValue, SendMessageInput{
		ConversationID: "conv_direct", ClientMessageID: "client_2", Text: "x", Fields: map[string]any{"actorId": "owner"},
	}); !isCode(err, CodeGatewayActorForbidden) {
		t.Fatalf("forged actor error = %v", err)
	}
}

func TestSendCardNormalizesOpaqueSourceAndAuditsRejection(t *testing.T) {
	repo, service, authValue, writer, card := gatewayFixture(t)
	result, err := service.SendCard(context.Background(), authValue, SendCardInput{
		ConversationID: "conv_direct", ClientMessageID: "card_msg", IdempotencyKey: "card_key",
		CardType: "Future.Poll", SchemaVersion: 1, FallbackText: "fallback", Payload: map[string]any{"text": "safe"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Card.CardType != "future.poll" || card.lastRequest.SourceID != opaqueCardSourceID(authValue.BotID, "card_key") || writer.count != 1 {
		t.Fatalf("card result=%#v source=%q writes=%d", result, card.lastRequest.SourceID, writer.count)
	}
	if _, err := service.SendCard(context.Background(), authValue, SendCardInput{
		ConversationID: "conv_direct", ClientMessageID: "bad_card", CardType: "future.poll", SchemaVersion: 1,
		FallbackText: "fallback", Payload: map[string]any{}, Fields: map[string]any{"actorId": "forged"},
	}); !isCode(err, CodeGatewayActorForbidden) {
		t.Fatalf("forged card error = %v", err)
	}
	if _, err := service.SendCard(context.Background(), authValue, SendCardInput{
		ConversationID: "conv_direct", ClientMessageID: "bad_card_2", CardType: "future.poll", SchemaVersion: 1,
		FallbackText: "<script>x</script>", Payload: map[string]any{},
	}); !isCode(err, CodeCardInvalidFallback) {
		t.Fatalf("invalid fallback = %v", err)
	}
	if len(repo.audits) != 1 || repo.audits[0].Action != "bot.gateway.card.send" || repo.audits[0].Reason != CodeCardInvalidFallback {
		t.Fatalf("card rejection audits = %#v", repo.audits)
	}
}

func TestSendCardFeishuPersistsOnlyConvertedPayloadAndHashesConvertedJSON(t *testing.T) {
	repo, service, authValue, _, card := gatewayFixture(t)
	raw := json.RawMessage(`{"elements":[{"tag":"div","text":{"tag":"plain_text","content":"审批"}}]}`)
	converted, err := feishucards.ConvertJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	input := SendCardInput{
		ConversationID: "conv_direct", ClientMessageID: "feishu-message", IdempotencyKey: "feishu-key",
		Format: "feishu-card", RawFeishuCard: raw,
		Fields: map[string]any{"format": "feishu-card", "feishuCard": map[string]any{}},
	}
	first, err := service.SendCard(context.Background(), authValue, input)
	if err != nil {
		t.Fatal(err)
	}
	if first.Card.CardType != feishucards.CardType || first.Card.SchemaVersion != feishucards.SchemaVersion || first.Card.FallbackText != converted.FallbackText {
		t.Fatalf("Feishu projection = %#v", first.Card)
	}
	if !bytes.Equal(card.lastRequest.RawPayload, converted.PayloadJSON) {
		t.Fatalf("persisted raw payload = %s, want %s", card.lastRequest.RawPayload, converted.PayloadJSON)
	}
	if got, want := jsonValueBytes(t, card.lastRequest.Payload), jsonValueBytes(t, converted.Payload); !bytes.Equal(got, want) {
		t.Fatalf("typed payload = %s, want %s", got, want)
	}
	record, ok := repo.idempotency[authValue.BotID+":card.send:feishu-key"]
	if !ok {
		t.Fatal("Feishu idempotency record missing")
	}
	wantHash, err := hashGatewayRequest(cardIdempotencyInput{
		ConversationID: "conv_direct", CardType: feishucards.CardType, SchemaVersion: feishucards.SchemaVersion,
		FallbackText: converted.FallbackText, Payload: converted.Payload, RawPayload: converted.PayloadJSON,
	})
	if err != nil {
		t.Fatal(err)
	}
	if record.RequestHash != wantHash {
		t.Fatalf("Feishu request hash = %s, want converted hash %s", record.RequestHash, wantHash)
	}
	if _, err := service.SendCard(context.Background(), authValue, input); err != nil {
		t.Fatal(err)
	}
	if card.count != 1 {
		t.Fatalf("Feishu replay card writes = %d, want 1", card.count)
	}
}

func TestUpdateCardFeishuOwnerAndRawPayloadSemantics(t *testing.T) {
	repo, service, authValue, _, card := gatewayFixture(t)
	card.card = Card{ID: "card-feishu", BotID: authValue.BotID, SpaceID: authValue.SpaceID, ConversationID: "conv_direct", CardType: feishucards.CardType, SchemaVersion: feishucards.SchemaVersion, Revision: 1, Status: "active"}
	raw := json.RawMessage(`{"elements":[{"tag":"div","text":{"tag":"plain_text","content":"更新"}}]}`)
	converted, err := feishucards.ConvertJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateCard(context.Background(), authValue, card.card.ID, UpdateCardInput{
		ExpectedRevision: 1, Format: "feishu-card", RawFeishuCard: raw,
		Fields: map[string]any{"format": "feishu-card", "feishuCard": map[string]any{}},
	}); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(card.lastUpdate.RawPayload, converted.PayloadJSON) || card.lastUpdate.FallbackText == nil || *card.lastUpdate.FallbackText != converted.FallbackText {
		t.Fatalf("Feishu update request = %#v, raw=%s", card.lastUpdate, card.lastUpdate.RawPayload)
	}
	card.ownerError = NewError(CodeCardNotFound, MessageAttachmentNotFound, 404)
	if _, err := service.UpdateCard(context.Background(), authValue, card.card.ID, UpdateCardInput{
		ExpectedRevision: 2, Format: "feishu-card", RawFeishuCard: raw,
		Fields: map[string]any{"format": "feishu-card", "feishuCard": map[string]any{}},
	}); !isCode(err, CodeCardNotFound) {
		t.Fatalf("owner rejection = %v", err)
	}
	if len(repo.audits) == 0 || repo.audits[len(repo.audits)-1].Action != "bot.gateway.card.update" || repo.audits[len(repo.audits)-1].Result != "rejected" {
		t.Fatalf("owner rejection audit = %#v", repo.audits)
	}
}

func jsonValueBytes(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestGoFeishuCardHashMatchesNodeContractGolden(t *testing.T) {
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	goldenPath := filepath.Join(filepath.Dir(sourceFile), "../../../../../scripts/backend/bot-feishu-contract-golden.json")
	raw, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		RequestJSON string `json:"requestJSON"`
		RequestHash string `json:"requestHash"`
		PayloadJSON string `json:"payloadJSON"`
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		var request struct {
			ConversationID string          `json:"conversationId"`
			CardType       string          `json:"cardType"`
			SchemaVersion  int             `json:"schemaVersion"`
			FallbackText   string          `json:"fallbackText"`
			Payload        json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal([]byte(fixture.RequestJSON), &request); err != nil {
			t.Fatal(err)
		}
		if string(request.Payload) != fixture.PayloadJSON {
			t.Fatalf("Node golden payload changed: %s", request.Payload)
		}
		got, err := hashGatewayRequest(cardIdempotencyInput{
			ConversationID: request.ConversationID, CardType: request.CardType, SchemaVersion: request.SchemaVersion,
			FallbackText: request.FallbackText, Payload: request.Payload, RawPayload: request.Payload,
		})
		if err != nil {
			t.Fatal(err)
		}
		if got != fixture.RequestHash {
			t.Fatalf("Go Feishu hash = %s, Node golden = %s", got, fixture.RequestHash)
		}
	}
}

func TestReplayReauthorizesAndKeepsDeliveryMetadataOnly(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	created := repo.now()
	repo.events = []EventRecord{
		{
			ID: "event_1", SpaceID: "spc_default", Sequence: 1, EventType: "message.created",
			ActorUserID: "owner_1", ConversationID: "conv_direct", TargetType: "message", TargetID: "message_1",
			PayloadJSON: []byte(`{"messageId":"message_1","plainText":"do not deliver"}`), CreatedAt: created,
		},
		{
			ID: "event_2", SpaceID: "spc_default", Sequence: 2, EventType: "message.created",
			ActorUserID: "owner_1", ConversationID: "conv_direct", TargetType: "message", TargetID: "message_2",
			PayloadJSON: []byte(`{"messageId":"message_2","plainText":"do not persist"}`), CreatedAt: created.Add(time.Second),
		},
	}
	repo.triggers["conv_direct:message_1"] = &MessageTrigger{AuthorID: "owner_1", PlainText: "one", ContentJSON: []byte(`{"blocks":[{"type":"text","text":"one"}]}`)}
	repo.triggers["conv_direct:message_2"] = &MessageTrigger{AuthorID: "owner_1", PlainText: "two", ContentJSON: []byte(`{"blocks":[{"type":"text","text":"two"}]}`)}
	repo.deliveries = []DeliveryRecord{{
		ID: "delivery_1", BotID: authValue.BotID, SpaceID: authValue.SpaceID, Sequence: 1, EventID: "event_1",
		EventType: "message.created", ConversationID: "conv_direct", PayloadJSON: []byte(`{}`), Status: "queued",
		CreatedAt: created, ExpiresAt: created.Add(time.Hour),
	}}
	result, err := service.Replay(context.Background(), authValue, ReplayInput{LastSequence: 0, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Events) != 2 || result.Events[0].Sequence != 1 || result.Events[1].Sequence != 2 {
		t.Fatalf("replay = %#v", result)
	}
	if _, leaked := result.Events[0].Payload["plainText"]; leaked {
		t.Fatal("message content leaked into delivery")
	}
	if repo.deliveries[0].Status != "delivered" {
		t.Fatalf("delivery status = %q", repo.deliveries[0].Status)
	}
	repo.members["conv_direct:bot_user"] = false
	result, err = service.Replay(context.Background(), authValue, ReplayInput{LastSequence: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Events) != 0 {
		t.Fatalf("removed bot received events = %#v", result.Events)
	}
}

func TestAcknowledgeAndRateLimit(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	repo.deliveries = []DeliveryRecord{{
		ID: "delivery_1", BotID: authValue.BotID, SpaceID: authValue.SpaceID, Sequence: 4, EventID: "event_4",
		Status: "delivered", CreatedAt: repo.now(), ExpiresAt: repo.now().Add(time.Hour),
	}}
	result, err := service.Acknowledge(context.Background(), authValue, AcknowledgeInput{Sequence: 4})
	if err != nil || !result.Acknowledged || repo.processed != 1 {
		t.Fatalf("ack result=%#v err=%v processed=%d", result, err, repo.processed)
	}
	if _, err := service.Acknowledge(context.Background(), authValue, AcknowledgeInput{}); !isCode(err, CodeInvalidAck) {
		t.Fatalf("empty ack error = %v", err)
	}
	repo.limits.RequestsPerMinute = 1
	repo.events = []EventRecord{{
		ID: "event_5", SpaceID: authValue.SpaceID, Sequence: 5, EventType: "message.created",
		ActorUserID: "owner_1", ConversationID: "conv_direct", TargetID: "message_5",
		PayloadJSON: []byte(`{}`), CreatedAt: repo.now(),
	}}
	repo.triggers["conv_direct:message_5"] = &MessageTrigger{AuthorID: "owner_1", PlainText: "five", ContentJSON: []byte(`{"blocks":[{"type":"text"}]}`)}
	if _, err := service.Replay(context.Background(), authValue, ReplayInput{LastSequence: 4}); err != nil {
		t.Fatal(err)
	}
}

func TestSafeDeliveryPayloadDeliversMessageAndCommandContext(t *testing.T) {
	msgBytes := safeDeliveryPayload(EventRecord{
		EventType:      "message.created",
		ActorUserID:    "usr_owner_1",
		ConversationID: "conv_1",
		TargetID:       "msg_1",
		PayloadJSON:    []byte(`{"plainText":"hello @echo","threadRootId":"msg_root_1","command":"/summarize","args":"last 10"}`),
	})
	var msgPayload map[string]any
	if err := json.Unmarshal(msgBytes, &msgPayload); err != nil {
		t.Fatal(err)
	}
	if msgPayload["text"] != "hello @echo" || msgPayload["messageId"] != "msg_1" || msgPayload["threadRootId"] != "msg_root_1" || msgPayload["args"] != "last 10" {
		t.Fatalf("unexpected message delivery payload: %#v", msgPayload)
	}
}

func TestReplaySkipsSystemNullAuthorMessageWithoutPoisoningQueue(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	repo.events = []EventRecord{
		{
			ID: "event_sys_invite", SpaceID: authValue.SpaceID, Sequence: 1, EventType: "message.created",
			ActorUserID: "owner_1", ConversationID: "conv_direct", TargetType: "message", TargetID: "msg_sys_invite",
			PayloadJSON: []byte(`{"plainText":"timeStarry 邀请 Comet 加入群聊"}`), CreatedAt: repo.now(),
		},
		{
			ID: "event_dm_after", SpaceID: authValue.SpaceID, Sequence: 2, EventType: "message.created",
			ActorUserID: "owner_1", ConversationID: "conv_direct", TargetType: "message", TargetID: "msg_dm_after",
			PayloadJSON: []byte(`{"plainText":"能收到消息吗"}`), CreatedAt: repo.now().Add(time.Second),
		},
	}
	repo.triggers["conv_direct:msg_sys_invite"] = &MessageTrigger{AuthorID: "", PlainText: "timeStarry 邀请 Comet 加入群聊", ContentJSON: []byte(`{"blocks":[{"type":"text","text":"timeStarry 邀请 Comet 加入群聊"}]}`)}
	repo.triggers["conv_direct:msg_dm_after"] = &MessageTrigger{AuthorID: "owner_1", PlainText: "能收到消息吗", ContentJSON: []byte(`{"blocks":[{"type":"text","text":"能收到消息吗"}]}`)}

	result, err := service.Replay(context.Background(), authValue, ReplayInput{LastSequence: 0, Limit: 10})
	if err != nil {
		t.Fatalf("Replay failed after system message: %v", err)
	}
	if result.SyncRequired || len(result.Events) != 1 || result.Events[0].Sequence != 2 {
		t.Fatalf("expected sequence 2 delivered cleanly, got %#v", result)
	}
}

func TestCreatorDirectSovereigntyGroupTriggerModesAndRuntimeUpgradeSignal(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	// Simulate Comet's exact scenario: visibilityPolicy = "groups" and even missing explicit DM grant row
	repo.settings.VisibilityPolicy = "groups"
	repo.settings.TriggerPolicy = "mention-or-command"
	delete(repo.grants, "conv_direct")

	repo.events = []EventRecord{
		{
			ID: "event_owner_dm_groups", SpaceID: authValue.SpaceID, Sequence: 1, EventType: "message.created",
			ActorUserID: "owner_1", ConversationID: "conv_direct", TargetType: "message", TargetID: "msg_owner_dm_1",
			PayloadJSON: []byte(`{"plainText":"恢复测试"}`), CreatedAt: repo.now(),
		},
		{
			ID: "event_group_reply_bot", SpaceID: authValue.SpaceID, Sequence: 2, EventType: "message.created",
			ActorUserID: "owner_1", ConversationID: "conv_group", TargetType: "message", TargetID: "msg_group_reply",
			PayloadJSON: []byte(`{"plainText":"继续跟进"}`), CreatedAt: repo.now().Add(time.Second),
		},
		{
			ID: "event_runtime_upgrade", SpaceID: authValue.SpaceID, Sequence: 3, EventType: "bot.runtime_upgrade",
			ActorUserID: "owner_1", TargetType: "agent_bot", TargetID: authValue.BotID,
			PayloadJSON: []byte(`{"botId":"` + authValue.BotID + `","targetVersion":"1.0.14","reason":"console_request"}`),
			CreatedAt:   repo.now().Add(2 * time.Second),
		},
	}
	repo.triggers["conv_direct:msg_owner_dm_1"] = &MessageTrigger{
		AuthorID: "owner_1", PlainText: "恢复测试",
		ContentJSON: []byte(`{"blocks":[{"type":"text","text":"恢复测试"}]}`),
	}
	repo.triggers["conv_group:msg_group_reply"] = &MessageTrigger{
		AuthorID: "owner_1", ReplyToAuthorID: authValue.UserID, PlainText: "继续跟进",
		ContentJSON: []byte(`{"blocks":[{"type":"text","text":"继续跟进"}]}`),
	}

	result, err := service.Replay(context.Background(), authValue, ReplayInput{LastSequence: 0, Limit: 10})
	if err != nil {
		t.Fatalf("Replay failed: %v", err)
	}
	if len(result.Events) != 3 {
		t.Fatalf("expected 3 events (owner DM + reply-to-bot group + runtime_upgrade), got %d: %#v", len(result.Events), result.Events)
	}
	if result.Events[2].Type != "bot.runtime_upgrade" || result.Events[2].Payload["targetVersion"] != "1.0.14" {
		t.Fatalf("unexpected runtime upgrade event: %#v", result.Events[2])
	}

	// Verify group all-messages mode triggers without @mention or reply
	repo.settings.TriggerPolicy = "all-messages"
	repo.events = append(repo.events, EventRecord{
		ID: "event_group_all", SpaceID: authValue.SpaceID, Sequence: 4, EventType: "message.created",
		ActorUserID: "owner_1", ConversationID: "conv_group", TargetType: "message", TargetID: "msg_group_all",
		PayloadJSON: []byte(`{"plainText":"群内普通讨论"}`), CreatedAt: repo.now().Add(3 * time.Second),
	})
	repo.triggers["conv_group:msg_group_all"] = &MessageTrigger{
		AuthorID: "owner_1", PlainText: "群内普通讨论",
		ContentJSON: []byte(`{"blocks":[{"type":"text","text":"群内普通讨论"}]}`),
	}
	res2, err := service.Replay(context.Background(), authValue, ReplayInput{LastSequence: 3, Limit: 10})
	if err != nil || len(res2.Events) != 1 || res2.Events[0].Sequence != 4 {
		t.Fatalf("expected all-messages group trigger at seq 4, got err=%v events=%#v", err, res2.Events)
	}
}

func isCode(err error, code string) bool {
	var value *Error
	return errors.As(err, &value) && value.Code == code
}
