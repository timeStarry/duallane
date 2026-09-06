package runtime

import (
	"context"
	"errors"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/delivery"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

// Writer binds one official system identity to the ordinary card/message
// domains. It owns no pool transaction, notification transport or public route.
type Writer struct {
	messages *messages.Service
	cards    *cards.Service
	spaceID  string
}

func NewWriter(spaceID string, repository *messages.PGRepository, cardService *cards.Service) *Writer {
	spaceID = strings.TrimSpace(spaceID)
	if spaceID == "" {
		spaceID = delivery.DefaultSpaceID
	}
	return &Writer{
		spaceID: spaceID, cards: cardService,
		messages: messages.NewService(messages.ServiceOptions{
			SpaceID: spaceID, Repository: repository, AllowBots: true, RequireMessageJobs: true,
		}),
	}
}

func (w *Writer) WriteEchoCardAndMessageInTx(ctx context.Context, tx delivery.Tx, input delivery.CardMessageWriteInput) (delivery.CardMessageWriteResult, error) {
	if w == nil || w.cards == nil || w.messages == nil || !input.InternalOnly || input.SpaceID != w.spaceID {
		return delivery.CardMessageWriteResult{}, writerError()
	}
	switch input.CardType {
	case delivery.CardTypeSol, delivery.CardTypeRequest, delivery.CardTypeStatus, delivery.CardTypeRelease:
	default:
		return delivery.CardMessageWriteResult{}, writerError()
	}
	provider, ok := tx.(delivery.TypedTransactionProvider)
	if !ok {
		return delivery.CardMessageWriteResult{}, writerError()
	}
	messageTx, cardTx := provider.MessageTransaction(), provider.CardTransaction()
	if messageTx == nil || cardTx == nil {
		return delivery.CardMessageWriteResult{}, writerError()
	}
	conversation, err := messageTx.GetConversation(ctx, input.SpaceID, input.ConversationID)
	if err != nil {
		return delivery.CardMessageWriteResult{}, err
	}
	if conversation == nil || conversation.Type != "direct" {
		return delivery.CardMessageWriteResult{}, writerError()
	}
	// Delivery also pins membership, but repeat it at this trusted writer seam
	// so another in-process caller cannot bind a card to an unrelated recipient.
	recipient, err := messageTx.LookupActor(ctx, input.SpaceID, input.RecipientUserID)
	if err != nil {
		return delivery.CardMessageWriteResult{}, err
	}
	if recipient == nil || recipient.Kind != "human" {
		return delivery.CardMessageWriteResult{}, writerError()
	}
	member, err := messageTx.ConversationMemberActive(ctx, input.SpaceID, input.ConversationID, recipient.ID)
	if err != nil {
		return delivery.CardMessageWriteResult{}, err
	}
	if !member {
		return delivery.CardMessageWriteResult{}, writerError()
	}
	card, _, err := w.cards.UpsertEchoCardInTx(ctx, cardTx, cards.EchoUpsertInput{
		SpaceID: input.SpaceID, ConversationID: input.ConversationID, CardID: input.CardID,
		CardType: input.CardType, SchemaVersion: input.SchemaVersion, FallbackText: input.FallbackText,
		Payload: input.Payload, SourceID: input.SourceID, ResourceType: input.ResourceType,
		ResourceID: input.ResourceID, DomainRevision: input.DomainRevision, Meta: input.Meta.Safe(),
	})
	if err != nil {
		return delivery.CardMessageWriteResult{}, err
	}
	existing, err := messageTx.FindMessageByClientID(ctx, input.SpaceID, input.ConversationID, delivery.EchoUserID, input.ClientMessageID)
	if err != nil {
		return delivery.CardMessageWriteResult{}, err
	}
	block := card.Block
	message, err := w.messages.CreateMessageInTx(ctx, messageTx, messages.CreateInput{
		ActorID: delivery.EchoUserID, ConversationID: input.ConversationID, ClientMessageID: input.ClientMessageID,
		Content: messages.Content{Format: messages.MessageContentFormat, Blocks: []messages.Block{{
			Type: "card", CardID: block.CardID, CardType: block.CardType,
			SchemaVersion: block.SchemaVersion, FallbackText: block.FallbackText,
		}}}, Meta: input.Meta.Safe(),
	}, echoCardValidator{service: w.cards, tx: cardTx})
	if err != nil {
		return delivery.CardMessageWriteResult{}, err
	}
	return delivery.CardMessageWriteResult{CardID: card.ID, MessageID: message.ID, CardRevision: card.Revision, Replayed: existing != nil}, nil
}

type echoCardValidator struct {
	service *cards.Service
	tx      cards.Tx
}

func (v echoCardValidator) ValidateBlockInTx(ctx context.Context, _ messages.Tx, actor *auth.Actor, conversationID string, block messages.Block) (messages.Block, error) {
	if actor == nil || actor.ID != delivery.EchoUserID || actor.Kind != "bot" || block.Type != "card" {
		return messages.Block{}, writerError()
	}
	reference, err := v.service.ValidateMessageCardReferenceInTx(ctx, v.tx, actor.ID, conversationID, cards.CardBlock{
		Type: block.Type, CardID: block.CardID, CardType: block.CardType,
		SchemaVersion: block.SchemaVersion, FallbackText: block.FallbackText,
	})
	if err != nil {
		return messages.Block{}, err
	}
	return messages.Block{Type: reference.Type, CardID: reference.CardID, CardType: reference.CardType, SchemaVersion: reference.SchemaVersion, FallbackText: reference.FallbackText}, nil
}

func writerError() error {
	return &delivery.Error{Code: "echo.writer_invalid", Message: "服务暂时不可用", StatusCode: 500, Cause: errors.New("trusted Echo writer boundary is invalid")}
}

var _ delivery.EchoWriter = (*Writer)(nil)
