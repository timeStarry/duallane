package messageblocks

import (
	"context"
	"errors"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/topics"
)

type fakeCards struct {
	block cards.CardBlock
	err   error
}

func (f fakeCards) ValidateMessageCardReference(context.Context, string, string, cards.CardBlock) (cards.CardBlock, error) {
	return f.block, f.err
}

type fakeEmotes struct {
	customID string
	shareID  string
	err      error
}

func (f *fakeEmotes) ValidateMessageCustomEmote(_ context.Context, _, id string) error {
	f.customID = id
	return f.err
}

func (f *fakeEmotes) ValidateShare(_ context.Context, _, id string) error {
	f.shareID = id
	return f.err
}

type fakeTopics struct {
	topic topics.Topic
	err   error
}

func (f fakeTopics) GetDetails(context.Context, topics.TopicInput) (topics.Topic, error) {
	return f.topic, f.err
}

func TestValidatorCanonicalizesAdvancedBlocks(t *testing.T) {
	emotes := &fakeEmotes{}
	validator := NewValidator(ValidatorOptions{
		Cards:  fakeCards{block: cards.CardBlock{Type: "card", CardID: "card-1", CardType: "echo.answer", SchemaVersion: 1, FallbackText: "回答"}},
		Emotes: emotes,
		Topics: fakeTopics{topic: topics.Topic{ID: "topic-1", ConversationID: "conv-1", Title: "发布", Joined: true}},
	})
	actor := &auth.Actor{ID: "usr-alice"}
	customID := "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"
	shareID := "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB"
	tests := []struct {
		name  string
		input messages.Block
		want  messages.Block
	}{
		{"custom emote", messages.Block{Type: "emoji", Shortcode: "custom:" + customID}, messages.Block{Type: "emoji", Shortcode: "custom:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}},
		{"collection", messages.Block{Type: "emote_collection", ShareID: shareID}, messages.Block{Type: "emote_collection", ShareID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}},
		{"topic", messages.Block{Type: "topic_reference", TopicID: "topic-1", Title: "untrusted"}, messages.Block{Type: "topic_reference", TopicID: "topic-1", Title: "发布"}},
		{"card", messages.Block{Type: "card", CardID: "card-1", CardType: "echo.answer", SchemaVersion: 1, FallbackText: "回答"}, messages.Block{Type: "card", CardID: "card-1", CardType: "echo.answer", SchemaVersion: 1, FallbackText: "回答"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := validator.ValidateBlock(context.Background(), actor, "conv-1", test.input)
			if err != nil || got != test.want {
				t.Fatalf("ValidateBlock() = %#v, %v; want %#v", got, err, test.want)
			}
		})
	}
	if emotes.customID != "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" || emotes.shareID != "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" {
		t.Fatalf("emote validation IDs = custom:%q share:%q", emotes.customID, emotes.shareID)
	}
}

func TestValidatorFailsClosedForUnavailableReferences(t *testing.T) {
	actor := &auth.Actor{ID: "usr-alice"}
	tests := []struct {
		name string
		v    *Validator
		in   messages.Block
		code string
	}{
		{"custom", NewValidator(ValidatorOptions{Emotes: &fakeEmotes{err: errors.New("missing")}}), messages.Block{Type: "emoji", Shortcode: "custom:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}, messages.CodeMessageInvalidEmoji},
		{"collection", NewValidator(ValidatorOptions{Emotes: &fakeEmotes{err: errors.New("revoked")}}), messages.Block{Type: "emote_collection", ShareID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}, messages.CodeMessageInvalidEmoteShare},
		{"topic", NewValidator(ValidatorOptions{Topics: fakeTopics{topic: topics.Topic{ID: "topic-1", ConversationID: "other", Joined: true}}}), messages.Block{Type: "topic_reference", TopicID: "topic-1"}, messages.CodeMessageInvalidTopic},
		{"card", NewValidator(ValidatorOptions{Cards: fakeCards{err: cards.NewError(cards.CodeCardReferenceMismatch, "mismatch", 409)}}), messages.Block{Type: "card", CardID: "card-1", CardType: "echo.answer", SchemaVersion: 1, FallbackText: "回答"}, cards.CodeCardReferenceMismatch},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := test.v.ValidateBlock(context.Background(), actor, "conv-1", test.in)
			var messageError *messages.Error
			if !errors.As(err, &messageError) || messageError.Code != test.code {
				t.Fatalf("error = %#v; want %s", err, test.code)
			}
		})
	}
}
