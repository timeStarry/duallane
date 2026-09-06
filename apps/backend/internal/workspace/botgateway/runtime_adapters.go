package botgateway

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	workspacebots "github.com/timestarry/duallane/apps/backend/internal/workspace/bots"
	workspacecards "github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/feishucards"
	workspacefiles "github.com/timestarry/duallane/apps/backend/internal/workspace/files"
	workspacemessages "github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
)

// RuntimeAdapterOptions describes the already-composed Workspace domain
// services. The gateway does not reach around these services or accept a
// repository as a writer; each adapter calls the owning domain API so its
// authorization, quota, audit, event, and idempotency rules remain active.
type RuntimeAdapterOptions struct {
	Bots     *workspacebots.Service
	Messages *workspacemessages.Service
	Cards    *workspacecards.Service
	Files    *workspacefiles.Service
}

type RuntimeAdapters struct {
	TokenAuthenticator TokenAuthenticator
	MessageWriter      MessageWriter
	CardGateway        CardGateway
	AttachmentWriter   AttachmentWriter
}

func NewRuntimeAdapters(options RuntimeAdapterOptions) RuntimeAdapters {
	return RuntimeAdapters{
		TokenAuthenticator: newBotTokenAuthenticator(options.Bots),
		MessageWriter:      newMessageWriter(options.Messages, options.Cards),
		CardGateway:        newCardGateway(options.Cards),
		AttachmentWriter:   newAttachmentWriter(options.Files),
	}
}

type botTokenAuthenticator struct {
	service *workspacebots.Service
}

func newBotTokenAuthenticator(service *workspacebots.Service) TokenAuthenticator {
	if service == nil {
		return nil
	}
	return &botTokenAuthenticator{service: service}
}

func (a *botTokenAuthenticator) AuthenticateToken(ctx context.Context, rawToken string, options TokenAuthOptions) (*Auth, error) {
	if a == nil || a.service == nil {
		return nil, internalError("authenticate bot token", errors.New("bot service is required"))
	}
	identity, err := a.service.AuthenticateToken(ctx, rawToken, workspacebots.AuthenticateOptions{SpaceID: strings.TrimSpace(options.SpaceID)})
	if err != nil {
		return nil, normalizeRuntimeAdapterError(err, "authenticate bot token")
	}
	return &Auth{
		TokenID:     identity.TokenID,
		BotID:       identity.BotID,
		UserID:      identity.UserID,
		SpaceID:     identity.SpaceID,
		OwnerUserID: identity.OwnerUserID,
		Scopes:      append([]string(nil), identity.Scopes...),
		Bot: Bot{
			ID: identity.Bot.ID, BotUserID: identity.Bot.BotUserID, OwnerUserID: identity.Bot.OwnerUserID,
			SpaceID: identity.Bot.SpaceID, Mode: identity.Bot.Mode, Name: identity.Bot.Name,
			VisibilityPolicy: identity.Bot.VisibilityPolicy, ConversationPolicy: identity.Bot.ConversationPolicy,
			TriggerPolicy: identity.Bot.TriggerPolicy, Status: identity.Bot.Status,
			NameNormalized: identity.Bot.NameNormalized,
		},
	}, nil
}

type messageWriter struct {
	service *workspacemessages.Service
	cards   *workspacecards.Service
}

func newMessageWriter(service *workspacemessages.Service, cardService *workspacecards.Service) MessageWriter {
	if service == nil {
		return nil
	}
	return &messageWriter{service: service, cards: cardService}
}

func (w *messageWriter) CreateBotMessage(ctx context.Context, input MessageWriteRequest) (GatewayMessage, error) {
	if w == nil || w.service == nil {
		return GatewayMessage{}, internalError("create bot message", errors.New("message service is required"))
	}
	content, err := toWorkspaceMessageContent(input.Content)
	if err != nil {
		return GatewayMessage{}, err
	}
	message, err := w.service.CreateMessage(ctx, workspacemessages.CreateInput{
		ActorID: input.ActorID, ConversationID: input.ConversationID, ClientMessageID: input.ClientMessageID,
		Content: content, ReplyToMessageID: input.ReplyToMessageID, Meta: input.Meta.Safe(),
	})
	if err != nil {
		return GatewayMessage{}, normalizeRuntimeAdapterError(err, "create bot message")
	}
	return projectWorkspaceMessage(message), nil
}

func (w *messageWriter) CreateBotMessageInTx(ctx context.Context, tx Tx, input MessageWriteRequest) (GatewayMessage, error) {
	if w == nil || w.service == nil {
		return GatewayMessage{}, internalError("create bot message", errors.New("message service is required"))
	}
	provider, ok := tx.(MessageTransactionProvider)
	if !ok || provider.MessageTransaction() == nil {
		return GatewayMessage{}, internalError("create bot message", errors.New("message transaction provider is required"))
	}
	content, err := toWorkspaceMessageContent(input.Content)
	if err != nil {
		return GatewayMessage{}, err
	}
	var validators []workspacemessages.TransactionalBlockValidator
	if w.cards != nil {
		cardProvider, ok := tx.(CardTransactionProvider)
		if !ok || cardProvider.CardTransaction() == nil {
			return GatewayMessage{}, internalError("create bot message", errors.New("card transaction provider is required"))
		}
		validators = append(validators, transactionalCardBlockValidator{service: w.cards, tx: cardProvider.CardTransaction()})
	}
	message, err := w.service.CreateMessageInTx(ctx, provider.MessageTransaction(), workspacemessages.CreateInput{
		ActorID: input.ActorID, ConversationID: input.ConversationID, ClientMessageID: input.ClientMessageID,
		Content: content, ReplyToMessageID: input.ReplyToMessageID, Meta: input.Meta.Safe(),
	}, validators...)
	if err != nil {
		return GatewayMessage{}, normalizeRuntimeAdapterError(err, "create bot message")
	}
	return projectWorkspaceMessage(message), nil
}

type transactionalCardBlockValidator struct {
	service *workspacecards.Service
	tx      workspacecards.Tx
}

func (v transactionalCardBlockValidator) ValidateBlockInTx(ctx context.Context, _ workspacemessages.Tx, actor *auth.Actor, conversationID string, block workspacemessages.Block) (workspacemessages.Block, error) {
	if v.service == nil || v.tx == nil || actor == nil {
		return workspacemessages.Block{}, workspacemessages.NewError(workspacemessages.CodeInternal, workspacemessages.MessageInternal, 500)
	}
	reference, err := v.service.ValidateMessageCardReferenceInTx(ctx, v.tx, actor.ID, conversationID, workspacecards.CardBlock{
		Type: block.Type, CardID: block.CardID, CardType: block.CardType,
		SchemaVersion: block.SchemaVersion, FallbackText: block.FallbackText,
	})
	if err != nil {
		var cardErr *workspacecards.Error
		if errors.As(err, &cardErr) {
			return workspacemessages.Block{}, workspacemessages.NewError(cardErr.Code, cardErr.Message, cardErr.StatusCode)
		}
		return workspacemessages.Block{}, workspacemessages.NewError(workspacemessages.CodeInternal, workspacemessages.MessageInternal, 500)
	}
	return workspacemessages.Block{
		Type: reference.Type, CardID: reference.CardID, CardType: reference.CardType,
		SchemaVersion: reference.SchemaVersion, FallbackText: reference.FallbackText,
	}, nil
}

func toWorkspaceMessageContent(input MessageContent) (workspacemessages.Content, error) {
	blocks := make([]workspacemessages.Block, 0, len(input.Blocks))
	for _, raw := range input.Blocks {
		encoded, err := json.Marshal(raw)
		if err != nil {
			return workspacemessages.Content{}, NewError(CodeMessageInvalid, MessageMessageInvalid, 400)
		}
		var block workspacemessages.Block
		if err := json.Unmarshal(encoded, &block); err != nil || strings.TrimSpace(block.Type) == "" {
			return workspacemessages.Content{}, NewError(CodeMessageInvalid, MessageMessageInvalid, 400)
		}
		blocks = append(blocks, block)
	}
	return workspacemessages.Content{Format: input.Format, PlainText: input.PlainText, Blocks: blocks}, nil
}

func projectWorkspaceMessage(message workspacemessages.Message) GatewayMessage {
	content := map[string]any{}
	if encoded, err := json.Marshal(message.Content); err == nil {
		_ = json.Unmarshal(encoded, &content)
	}
	if len(content) == 0 {
		content = map[string]any{"format": MessageContentFormat, "plainText": message.PlainText, "blocks": []any{}}
	}
	return GatewayMessage{
		ID: message.ID, ConversationID: message.ConversationID, PlainText: message.PlainText,
		Content: content, CreatedAt: message.CreatedAt,
	}
}

type cardGateway struct {
	service *workspacecards.Service
}

func newCardGateway(service *workspacecards.Service) CardGateway {
	if service == nil {
		return nil
	}
	return &cardGateway{service: service}
}

// CheckFeishuCardOwner is a narrow read projection for the Node-compatible
// Feishu update branch. The cards service remains the owner of the subsequent
// mutation and repeats source/actor authorization inside its transaction.
func (w *cardGateway) CheckFeishuCardOwner(ctx context.Context, spaceID, cardID, botUserID string) error {
	if w == nil || w.service == nil || w.service.Repository() == nil {
		return internalError("check Feishu card owner", errors.New("card service is required"))
	}
	row, err := w.service.Repository().GetCard(ctx, spaceID, cardID)
	if err != nil {
		return normalizeRuntimeAdapterError(err, "check Feishu card owner")
	}
	if row == nil || row.SourceKind != workspacecards.SourceCustomBot || row.CreatedByUserID == nil || strings.TrimSpace(*row.CreatedByUserID) != strings.TrimSpace(botUserID) {
		return NewError(CodeCardNotFound, "卡片不存在", 404)
	}
	if row.CardType != feishucards.CardType || row.SchemaVersion != feishucards.SchemaVersion {
		return NewError("card.type_mismatch", "卡片格式与更新内容不一致", 409)
	}
	return nil
}

func (w *cardGateway) CreateCustomBotCard(ctx context.Context, input CardCreateRequest) (Card, error) {
	if w == nil || w.service == nil {
		return Card{}, internalError("create bot card", errors.New("card service is required"))
	}
	card, err := w.service.CreateCustomBotCard(ctx, workspacecards.CustomBotCreateInput{
		CreateInput: workspacecards.CreateInput{
			ActorID: input.BotUserID, SpaceID: input.SpaceID, ConversationID: input.ConversationID,
			SourceID: input.SourceID, CardType: input.CardType, SchemaVersion: input.SchemaVersion,
			FallbackText: input.FallbackText, Payload: input.Payload, RawPayload: cloneRawJSON(input.RawPayload), SourceKind: workspacecards.SourceCustomBot,
			VisibilityScope: workspacecards.VisibilityConversation, CreatedByUserID: input.BotUserID,
			TrustedCustomBot: true, AllowUnknownDefinition: true, BotID: input.BotID, Meta: input.Meta.Safe(),
		},
		BotID: input.BotID, BotUserID: input.BotUserID,
	})
	if err != nil {
		return Card{}, normalizeRuntimeAdapterError(err, "create bot card")
	}
	return projectWorkspaceCard(input.BotID, card), nil
}

func (w *cardGateway) CreateCustomBotCardInTx(ctx context.Context, tx Tx, input CardCreateRequest) (Card, error) {
	if w == nil || w.service == nil {
		return Card{}, internalError("create bot card", errors.New("card service is required"))
	}
	provider, ok := tx.(CardTransactionProvider)
	if !ok || provider.CardTransaction() == nil {
		return Card{}, internalError("create bot card", errors.New("card transaction provider is required"))
	}
	card, err := w.service.CreateCustomBotCardInTx(ctx, provider.CardTransaction(), workspacecards.CustomBotCreateInput{
		CreateInput: workspacecards.CreateInput{
			ActorID: input.BotUserID, SpaceID: input.SpaceID, ConversationID: input.ConversationID,
			SourceID: input.SourceID, CardType: input.CardType, SchemaVersion: input.SchemaVersion,
			FallbackText: input.FallbackText, Payload: input.Payload, RawPayload: cloneRawJSON(input.RawPayload), SourceKind: workspacecards.SourceCustomBot,
			VisibilityScope: workspacecards.VisibilityConversation, CreatedByUserID: input.BotUserID,
			TrustedCustomBot: true, AllowUnknownDefinition: true, BotID: input.BotID, Meta: input.Meta.Safe(),
		},
		BotID: input.BotID, BotUserID: input.BotUserID,
	})
	if err != nil {
		return Card{}, normalizeRuntimeAdapterError(err, "create bot card")
	}
	return projectWorkspaceCard(input.BotID, card), nil
}

func (w *cardGateway) UpdateCustomBotCard(ctx context.Context, input CardUpdateRequest) (Card, error) {
	if w == nil || w.service == nil {
		return Card{}, internalError("update bot card", errors.New("card service is required"))
	}
	card, err := w.service.UpdateCustomBotCard(ctx, workspacecards.CustomBotUpdateInput{
		ActorID: input.BotUserID, SpaceID: input.SpaceID, CardID: input.CardID, BotID: input.BotID,
		BotUserID: input.BotUserID, ExpectedRevision: input.ExpectedRevision, Payload: input.Payload, RawPayload: cloneRawJSON(input.RawPayload),
		FallbackText: input.FallbackText, Meta: input.Meta.Safe(),
	})
	if err != nil {
		return Card{}, normalizeRuntimeAdapterError(err, "update bot card")
	}
	return projectWorkspaceCard(input.BotID, card), nil
}

func cloneRawJSON(value json.RawMessage) json.RawMessage {
	if len(value) == 0 {
		return nil
	}
	return append(json.RawMessage(nil), value...)
}

func (w *cardGateway) InvalidateCustomBotCard(ctx context.Context, input CardUpdateRequest) (Card, error) {
	if w == nil || w.service == nil {
		return Card{}, internalError("invalidate bot card", errors.New("card service is required"))
	}
	status := workspacecards.CardStatus(strings.TrimSpace(input.Status))
	if status == "" {
		status = workspacecards.StatusInvalidated
	}
	card, err := w.service.InvalidateCustomBotCard(ctx, workspacecards.CustomBotInvalidateInput{
		ActorID: input.BotUserID, SpaceID: input.SpaceID, CardID: input.CardID, BotID: input.BotID,
		BotUserID: input.BotUserID, ExpectedRevision: input.ExpectedRevision, Status: status, Meta: input.Meta.Safe(),
	})
	if err != nil {
		return Card{}, normalizeRuntimeAdapterError(err, "invalidate bot card")
	}
	return projectWorkspaceCard(input.BotID, card), nil
}

func (w *cardGateway) ValidateMessageCardReference(ctx context.Context, actorID, conversationID string, block map[string]any) error {
	if w == nil || w.service == nil {
		return internalError("validate bot card reference", errors.New("card service is required"))
	}
	encoded, err := json.Marshal(block)
	if err != nil {
		return NewError(CodeCardInvalidPayload, "卡片内容无效", 400)
	}
	var reference workspacecards.CardBlock
	if err := json.Unmarshal(encoded, &reference); err != nil {
		return NewError(CodeCardInvalidPayload, "卡片内容无效", 400)
	}
	if _, err := w.service.ValidateMessageCardReference(ctx, actorID, conversationID, reference); err != nil {
		return normalizeRuntimeAdapterError(err, "validate bot card reference")
	}
	return nil
}

func (w *cardGateway) ValidateMessageCardReferenceInTx(ctx context.Context, tx Tx, actorID, conversationID string, block map[string]any) error {
	if w == nil || w.service == nil {
		return internalError("validate bot card reference", errors.New("card service is required"))
	}
	provider, ok := tx.(CardTransactionProvider)
	if !ok || provider.CardTransaction() == nil {
		return internalError("validate bot card reference", errors.New("card transaction provider is required"))
	}
	reference, err := decodeCardReference(block)
	if err != nil {
		return err
	}
	if _, err := w.service.ValidateMessageCardReferenceInTx(ctx, provider.CardTransaction(), actorID, conversationID, reference); err != nil {
		return normalizeRuntimeAdapterError(err, "validate bot card reference")
	}
	return nil
}

func decodeCardReference(block map[string]any) (workspacecards.CardBlock, error) {
	encoded, err := json.Marshal(block)
	if err != nil {
		return workspacecards.CardBlock{}, NewError(CodeCardInvalidPayload, "卡片内容无效", 400)
	}
	var reference workspacecards.CardBlock
	if err := json.Unmarshal(encoded, &reference); err != nil {
		return workspacecards.CardBlock{}, NewError(CodeCardInvalidPayload, "卡片内容无效", 400)
	}
	return reference, nil
}

func projectWorkspaceCard(botID string, card *workspacecards.Card) Card {
	if card == nil {
		return Card{BotID: botID}
	}
	conversationID := ""
	if card.ConversationID != nil {
		conversationID = *card.ConversationID
	}
	return Card{
		ID: card.ID, BotID: botID, SpaceID: card.SpaceID, ConversationID: conversationID,
		CardType: card.Block.CardType, SchemaVersion: card.Block.SchemaVersion, Payload: card.Payload,
		FallbackText: card.Block.FallbackText, Revision: card.Revision, Status: string(card.Status),
		CreatedAt: card.CreatedAt, UpdatedAt: card.UpdatedAt, Block: cardBlockMap(card.Block),
	}
}

func cardBlockMap(block workspacecards.CardBlock) map[string]any {
	return map[string]any{
		"type": block.Type, "cardId": block.CardID, "cardType": block.CardType,
		"schemaVersion": block.SchemaVersion, "fallbackText": block.FallbackText,
	}
}

type attachmentWriter struct {
	service agentBotUploadReserver
}

// agentBotUploadReserver is deliberately narrower than the human upload
// service. The files domain owns the authenticated gateway check, active bot
// membership check, and quota reservation; the gateway must never fall back
// to ReserveUpload because that would silently broaden the Bot actor surface.
// The remaining content-transfer operations are intentionally not part of
// this adapter until their Node authorization contract exists.
type agentBotUploadReserver interface {
	ReserveAgentBotUpload(context.Context, workspacefiles.ReserveUploadInput) (workspacefiles.UploadResult, error)
}

func newAttachmentWriter(service *workspacefiles.Service) AttachmentWriter {
	if service == nil {
		return nil
	}
	return &attachmentWriter{service: service}
}

func (w *attachmentWriter) ReserveAttachment(ctx context.Context, input AttachmentCreateRequest) (UploadReservation, error) {
	if w == nil || w.service == nil {
		return UploadReservation{}, internalError("reserve bot attachment", errors.New("file service is required"))
	}
	result, err := w.service.ReserveAgentBotUpload(ctx, workspacefiles.ReserveUploadInput{
		ActorID: input.ActorID, FileName: input.FileName, MIMEType: input.MIMEType, ByteSize: input.ByteSize,
		Visibility: input.Visibility, ConversationID: input.ConversationID, Meta: input.Meta.Safe(),
	})
	if err != nil {
		return UploadReservation{}, normalizeRuntimeAdapterError(err, "reserve bot attachment")
	}
	var attachment *Attachment
	if result.Attachment != nil {
		attachment = projectWorkspaceAttachment(input.SpaceID, result.Attachment)
	}
	return UploadReservation{Status: result.Status, ID: result.ID, Attachment: attachment, Upload: result.Upload}, nil
}

func projectWorkspaceAttachment(spaceID string, value *workspacefiles.Attachment) *Attachment {
	if value == nil {
		return nil
	}
	return &Attachment{
		ID: value.ID, SpaceID: strings.TrimSpace(spaceID), UploaderID: value.UploaderID,
		ConversationID: cloneRuntimeString(value.ConversationID), Visibility: value.Visibility, Status: value.Status,
		FileName: value.FileName, MIMEType: value.MIMEType, ByteSize: value.ByteSize,
		CreatedAt: value.CreatedAt, CompletedAt: cloneRuntimeString(value.CompletedAt),
	}
}

func cloneRuntimeString(value *string) *string {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func normalizeRuntimeAdapterError(err error, operation string) error {
	if err == nil {
		return nil
	}
	var gatewayErr *Error
	if errors.As(err, &gatewayErr) {
		return gatewayErr
	}
	var botErr *workspacebots.Error
	if errors.As(err, &botErr) {
		return mappedRuntimeError(botErr.Code, botErr.Message, botErr.StatusCode, operation, err)
	}
	var messageErr *workspacemessages.Error
	if errors.As(err, &messageErr) {
		return mappedRuntimeError(messageErr.Code, messageErr.Message, messageErr.StatusCode, operation, err)
	}
	var cardErr *workspacecards.Error
	if errors.As(err, &cardErr) {
		return mappedRuntimeError(cardErr.Code, cardErr.Message, cardErr.StatusCode, operation, err)
	}
	var fileErr *workspacefiles.Error
	if errors.As(err, &fileErr) {
		return mappedRuntimeError(fileErr.Code, fileErr.Message, fileErr.StatusCode, operation, err)
	}
	return internalError(operation, err)
}

func mappedRuntimeError(code, message string, status int, operation string, cause error) *Error {
	if strings.TrimSpace(code) == "" {
		return internalError(operation, cause)
	}
	if status < 400 || status > 599 {
		status = 500
	}
	return &Error{Code: code, Message: message, StatusCode: status, Cause: cause}
}

var (
	_ TokenAuthenticator     = (*botTokenAuthenticator)(nil)
	_ MessageWriter          = (*messageWriter)(nil)
	_ CardGateway            = (*cardGateway)(nil)
	_ AttachmentWriter       = (*attachmentWriter)(nil)
	_ agentBotUploadReserver = (*workspacefiles.Service)(nil)
)
