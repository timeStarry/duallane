package cards

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const echoUserID = "usr_system_echo"

// EchoUpsertInput is available only to trusted in-process delivery composition.
// Actor, source and visibility are fixed here, never supplied by HTTP clients.
type EchoUpsertInput struct {
	SpaceID, ConversationID, CardID, CardType, SourceID string
	ResourceType, ResourceID, FallbackText              string
	SchemaVersion                                       int
	DomainRevision                                      int64
	Payload                                             any
	Meta                                                auth.RequestMeta
}

// EchoCardRevisionTx is a narrow extension for preserving Node's revision floor
// without repeated artificial updates or exposing a generic SQL transaction.
type EchoCardRevisionTx interface {
	UpdateEchoCardRevision(context.Context, string, int64, int64, any, string, time.Time) (*CardRecord, bool, error)
}

// UpsertEchoCardInTx creates or refreshes one recipient-bound card in the
// caller's transaction. The caller must already hold the domain delivery lock
// and recheck the projected resource revision/recipient before invoking it.
func (s *Service) UpsertEchoCardInTx(ctx context.Context, tx Tx, input EchoUpsertInput) (*Card, bool, error) {
	if s == nil || s.repo == nil || tx == nil {
		return nil, false, internalError("upsert Echo card", errors.New("card service and transaction are required"))
	}
	spaceID := strings.TrimSpace(input.SpaceID)
	if spaceID == "" {
		spaceID = s.spaceID
	}
	for _, value := range []string{spaceID, input.ConversationID, input.CardID, input.SourceID, input.ResourceType, input.ResourceID} {
		if normalized, err := NormalizeIdentifier(value, CodeCardInvalidResource, "卡片资源无效"); err != nil || normalized != value {
			return nil, false, NewError(CodeCardInvalidResource, "卡片资源无效", 400)
		}
	}
	if input.DomainRevision < 1 || input.DomainRevision > 9007199254740991 {
		return nil, false, NewError(CodeCardInvalidRevision, "卡片版本无效", 400)
	}
	block, err := NormalizeCardBlock(CardBlock{Type: CardBlockType, CardID: input.CardID, CardType: input.CardType, SchemaVersion: input.SchemaVersion, FallbackText: input.FallbackText})
	if err != nil {
		return nil, false, toError(err)
	}
	definition := s.registry.Get(block.CardType, block.SchemaVersion)
	payload, err := s.validatePayload(block, input.Payload, definition, false)
	if err != nil {
		return nil, false, toError(err)
	}
	actor, err := s.requireActor(ctx, tx, spaceID, echoUserID, true)
	if err != nil {
		return nil, false, err
	}
	if actor.Kind != "bot" {
		return nil, false, identityForbiddenError()
	}
	member, err := tx.ConversationMemberActive(ctx, spaceID, input.ConversationID, actor.ID)
	if err != nil {
		return nil, false, normalizeError(err)
	}
	if !member {
		return nil, false, notFoundError()
	}
	// Use the same source lock as ordinary card creation; the database unique
	// constraint remains the final backstop across processes.
	if err := tx.Lock(ctx, "workspace:card:create:"+spaceID+":"+string(SourceEcho)+":"+input.SourceID+":"+block.CardType); err != nil {
		return nil, false, normalizeError(err)
	}
	row, err := tx.GetCardBySource(ctx, spaceID, SourceEcho, input.SourceID, block.CardType)
	if err != nil {
		return nil, false, normalizeError(err)
	}
	if row == nil {
		card, err := s.createWithRevision(ctx, tx, CreateInput{
			ActorID: echoUserID, SpaceID: spaceID, ConversationID: input.ConversationID,
			CardID: block.CardID, CardType: block.CardType, SchemaVersion: block.SchemaVersion,
			FallbackText: block.FallbackText, Payload: payload, SourceKind: SourceEcho,
			SourceID: input.SourceID, ResourceType: input.ResourceType, ResourceID: input.ResourceID,
			VisibilityScope: VisibilityConversation, CreatedByUserID: echoUserID, Meta: input.Meta.Safe(),
		}, input.DomainRevision)
		return card, false, err
	}
	// A source cannot be rebound to another recipient, resource or author.
	if row.ID != block.CardID || row.SchemaVersion != block.SchemaVersion || stringValue(row.ConversationID) != input.ConversationID ||
		stringValue(row.CreatedByUserID) != echoUserID || row.VisibilityScope != VisibilityConversation ||
		stringValue(row.ResourceType) != input.ResourceType || stringValue(row.ResourceID) != input.ResourceID || row.ExpiresAt != nil {
		return nil, false, conflictError(CodeCardSourceConflict, "卡片来源已绑定其他内容")
	}
	storedPayload, err := decodeJSON(row.PayloadJSON)
	if err != nil {
		return nil, false, internalError("decode Echo card", err)
	}
	candidatePayload, err := decodeJSON(mustJSON(payload))
	if err != nil {
		return nil, false, internalError("decode Echo projection", err)
	}
	if row.Status == StatusActive && row.Revision >= input.DomainRevision && row.FallbackText == block.FallbackText &&
		bytes.Equal(canonicalJSON(storedPayload), canonicalJSON(candidatePayload)) {
		return s.publicCard(row, definition, payload), true, nil
	}
	updater, ok := tx.(EchoCardRevisionTx)
	if !ok {
		return nil, false, internalError("update Echo card", errors.New("echo revision transaction is required"))
	}
	if row.Revision >= 9007199254740991 {
		return nil, false, conflictError(CodeCardRevisionConflict, "卡片版本已变化")
	}
	nextRevision := max(row.Revision+1, input.DomainRevision)
	updated, changed, err := updater.UpdateEchoCardRevision(ctx, row.ID, row.Revision, nextRevision, payload, block.FallbackText, s.nowUTC())
	if err != nil {
		return nil, false, normalizeError(err)
	}
	if !changed || updated == nil {
		return nil, false, conflictError(CodeCardRevisionConflict, "卡片版本已变化")
	}
	if err := s.writeEvent(ctx, tx, EventInput{SpaceID: spaceID, Type: "card.updated", ActorID: echoUserID, ConversationID: input.ConversationID, TargetType: "workspace.card", TargetID: row.ID, PayloadJSON: evidenceJSON(map[string]any{"cardId": row.ID, "cardType": row.CardType, "revision": nextRevision, "status": StatusActive}), CreatedAt: s.nowUTC()}); err != nil {
		return nil, false, normalizeError(err)
	}
	return s.publicCard(updated, definition, payload), false, nil
}
