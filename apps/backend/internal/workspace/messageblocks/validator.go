package messageblocks

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/emotes"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/topics"
)

var protocolUUIDPattern = regexp.MustCompile(`(?i)^[a-f0-9-]{36}$`)

type CardValidator interface {
	ValidateMessageCardReference(context.Context, string, string, cards.CardBlock) (cards.CardBlock, error)
}

type EmoteValidator interface {
	ValidateMessageCustomEmote(context.Context, string, string) error
	ValidateShare(context.Context, string, string) error
}

type TopicReader interface {
	GetDetails(context.Context, topics.TopicInput) (topics.Topic, error)
}

type ValidatorOptions struct {
	Cards  CardValidator
	Emotes EmoteValidator
	Topics TopicReader
}

type Validator struct {
	cards  CardValidator
	emotes EmoteValidator
	topics TopicReader
}

func NewValidator(options ValidatorOptions) *Validator {
	return &Validator{cards: options.Cards, emotes: options.Emotes, topics: options.Topics}
}

func (v *Validator) ValidateBlock(ctx context.Context, actor *auth.Actor, conversationID string, block messages.Block) (messages.Block, error) {
	if actor == nil || strings.TrimSpace(actor.ID) == "" {
		return messages.Block{}, messages.NewError(messages.CodeAuthRequired, messages.MessageAuthRequired, 401)
	}
	switch block.Type {
	case "emoji":
		return v.validateCustomEmote(ctx, actor.ID, block)
	case "emote_collection":
		return v.validateCollectionShare(ctx, actor.ID, block)
	case "topic_reference":
		return v.validateTopic(ctx, actor.ID, conversationID, block)
	case "card":
		return v.validateCard(ctx, actor.ID, conversationID, block)
	default:
		return messages.Block{}, messages.NewError(messages.CodeMessageInvalidBlock, messages.MessageInvalidBlock, 400)
	}
}

func (v *Validator) validateCustomEmote(ctx context.Context, actorID string, block messages.Block) (messages.Block, error) {
	const prefix = "custom:"
	shortcode := strings.ToLower(strings.TrimSpace(block.Shortcode))
	if v.emotes == nil || !strings.HasPrefix(shortcode, prefix) || !protocolUUIDPattern.MatchString(strings.TrimPrefix(shortcode, prefix)) {
		return messages.Block{}, invalidEmoji()
	}
	if err := v.emotes.ValidateMessageCustomEmote(ctx, actorID, strings.TrimPrefix(shortcode, prefix)); err != nil {
		if dependencyFailed(err) {
			return messages.Block{}, messages.NewError(messages.CodeInternal, messages.MessageInternal, 500)
		}
		return messages.Block{}, invalidEmoji()
	}
	return messages.Block{Type: "emoji", Shortcode: shortcode}, nil
}

func (v *Validator) validateCollectionShare(ctx context.Context, actorID string, block messages.Block) (messages.Block, error) {
	shareID := strings.ToLower(strings.TrimSpace(block.ShareID))
	if v.emotes == nil || !protocolUUIDPattern.MatchString(shareID) {
		return messages.Block{}, invalidEmoteShare()
	}
	if err := v.emotes.ValidateShare(ctx, actorID, shareID); err != nil {
		if dependencyFailed(err) {
			return messages.Block{}, messages.NewError(messages.CodeInternal, messages.MessageInternal, 500)
		}
		return messages.Block{}, invalidEmoteShare()
	}
	return messages.Block{Type: "emote_collection", ShareID: shareID}, nil
}

func (v *Validator) validateTopic(ctx context.Context, actorID, conversationID string, block messages.Block) (messages.Block, error) {
	topicID := strings.TrimSpace(block.TopicID)
	if v.topics == nil || topicID == "" {
		return messages.Block{}, invalidTopic()
	}
	topic, err := v.topics.GetDetails(ctx, topics.TopicInput{ActorID: actorID, TopicID: topicID})
	if dependencyFailed(err) {
		return messages.Block{}, messages.NewError(messages.CodeInternal, messages.MessageInternal, 500)
	}
	if err != nil || topic.ConversationID != strings.TrimSpace(conversationID) || !topic.Joined {
		return messages.Block{}, invalidTopic()
	}
	return messages.Block{Type: "topic_reference", TopicID: topic.ID, Title: strings.TrimSpace(topic.Title)}, nil
}

func (v *Validator) validateCard(ctx context.Context, actorID, conversationID string, block messages.Block) (messages.Block, error) {
	if v.cards == nil {
		return messages.Block{}, messages.NewError("card.server_owned", "卡片只能由受信任的服务创建", 400)
	}
	normalized, err := v.cards.ValidateMessageCardReference(ctx, actorID, conversationID, cards.CardBlock{
		Type: block.Type, CardID: block.CardID, CardType: block.CardType,
		SchemaVersion: block.SchemaVersion, FallbackText: block.FallbackText,
	})
	if err != nil {
		var cardError *cards.Error
		if errors.As(err, &cardError) {
			return messages.Block{}, messages.NewError(cardError.Code, cardError.Message, cardError.StatusCode)
		}
		return messages.Block{}, messages.NewError(messages.CodeInternal, messages.MessageInternal, 500)
	}
	return messages.Block{
		Type: "card", CardID: normalized.CardID, CardType: normalized.CardType,
		SchemaVersion: normalized.SchemaVersion, FallbackText: normalized.FallbackText,
	}, nil
}

func invalidEmoji() error {
	return messages.NewError(messages.CodeMessageInvalidEmoji, "收藏表情不可用", 400)
}

func invalidEmoteShare() error {
	return messages.NewError(messages.CodeMessageInvalidEmoteShare, messages.MessageInvalidEmoteShare, 400)
}

func invalidTopic() error {
	return messages.NewError(messages.CodeMessageInvalidTopic, messages.MessageInvalidTopic, 400)
}

func dependencyFailed(err error) bool {
	if err == nil {
		return false
	}
	var emoteError *emotes.Error
	if errors.As(err, &emoteError) {
		return emoteError.StatusCode >= 500
	}
	var topicError *topics.Error
	if errors.As(err, &topicError) {
		return topicError.StatusCode >= 500
	}
	return false
}

var _ messages.AdvancedBlockValidator = (*Validator)(nil)
