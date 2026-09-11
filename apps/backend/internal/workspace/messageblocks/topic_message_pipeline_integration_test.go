//go:build postgres_integration

package messageblocks

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/topics"
)

type topicTestBlocks struct{}

func (topicTestBlocks) ValidateBlock(_ context.Context, _ *auth.Actor, _ string, block messages.Block) (messages.Block, error) {
	return block, nil
}
func (topicTestBlocks) IsVisibleReactionEmote(context.Context, string) (bool, error) {
	return true, nil
}
func (topicTestBlocks) IsKnownReactionEmote(context.Context, string) (bool, error) { return true, nil }

func TestPGTopicUsesSharedMessagePipeline(t *testing.T) {
	ctx, pool := inlineTopicDatabase(t)
	topicRepo := topics.NewPGRepository(pool)
	topicService := topics.NewService(topics.ServiceOptions{Repository: topicRepo})
	messageRepo := messages.NewPGRepository(pool)
	messageRepo.SetTopicRepository(topicRepo)
	messageService := messages.NewService(messages.ServiceOptions{Repository: messageRepo,
		ReactionEmoteValidator: topicTestBlocks{}, AdvancedBlockValidator: topicTestBlocks{},
		GroupTopicCreator: NewGroupTopicCreator(topicService, ""),
	})
	topicService.SetMessagePipeline(NewTopicMessagePipeline(messageService, messageRepo, topicService))
	for _, sql := range []string{
		`INSERT INTO users(id,github_login,display_name,kind,created_at,last_login_at) VALUES ('topic-peer','topic-peer','Peer','human',NOW(),NOW()),('topic-outside','topic-outside','Outside','human',NOW(),NOW())`,
		`INSERT INTO space_members(space_id,user_id,role,joined_at) VALUES ('spc_default','topic-peer','member',NOW()),('spc_default','topic-outside','member',NOW())`,
		`INSERT INTO conversation_members(conversation_id,user_id,joined_at) VALUES ('inline-group','topic-peer',NOW()),('inline-group','topic-outside',NOW())`,
		`INSERT INTO attachments(id,space_id,uploader_id,visibility,status,file_name,mime_type,byte_size,created_at,completed_at) VALUES ('topic-image','spc_default','inline-owner','private_staging','available','image.png','image/png',123,NOW(),NOW()),('other-image','spc_default','topic-outside','private_staging','available','private.png','image/png',123,NOW(),NOW())`,
		`INSERT INTO workspace_custom_emotes(id,user_id,source_type,source_emote_key,label,sort_order,created_at) VALUES ('11111111-1111-4111-8111-111111111111','inline-owner','builtin','builtin:wave','Wave',0,NOW())`,
		`INSERT INTO workspace_emote_collection_shares(id,collection_id,shared_by_user_id,original_creator_user_id,snapshot_name,fingerprint,item_count,created_at) VALUES ('topic-share',NULL,'inline-owner','inline-owner','Shared','topic-fingerprint',0,NOW())`,
	} {
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	topic, err := topicService.Create(ctx, topics.CreateInput{ActorID: "inline-owner", ConversationID: "inline-group", Title: "Shared message behavior", Description: "Initial", IdempotencyKey: "topic-pipeline", AllowSyncToGroup: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := topicService.Join(ctx, topics.TopicInput{ActorID: "topic-peer", TopicID: topic.ID}); err != nil {
		t.Fatal(err)
	}
	input := topics.CreateMessageInput{ActorID: "inline-owner", TopicID: topic.ID, ClientMessageID: "image-only", Content: topics.Content{Format: topics.MessageContentFormat, Blocks: []topics.Block{{Type: "attachment", AttachmentID: "topic-image"}}}}
	image, err := topicService.CreateMessage(ctx, input)
	if err != nil {
		t.Fatalf("image-only send: %v", err)
	}
	if image.Message.TopicID != topic.ID || len(image.Message.Attachments) != 1 || image.Message.AuthorName == "" {
		t.Fatalf("incomplete shared projection: %+v", image.Message)
	}
	for range 2 {
		replay, err := topicService.CreateMessage(ctx, input)
		if err != nil || replay.Message.ID != image.Message.ID {
			t.Fatalf("retry: %+v %v", replay, err)
		}
	}
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM message_attachments WHERE attachment_id='topic-image'`, 1)
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM workspace_events WHERE type='topic.message.created'`, 2)
	var workers sync.WaitGroup
	for range 6 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			replay, err := topicService.CreateMessage(ctx, input)
			if err != nil || replay.Message.ID != image.Message.ID {
				t.Errorf("concurrent replay: %+v %v", replay, err)
			}
		}()
	}
	workers.Wait()
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM message_attachments WHERE attachment_id='topic-image'`, 1)
	group, err := messageService.ListMessages(ctx, messages.ListOptions{ActorID: "inline-owner", ConversationID: "inline-group"})
	if err != nil || len(group) != 1 {
		t.Fatalf("topic leaked into group: %+v %v", group, err)
	}
	input.ClientMessageID = "other-private-image"
	input.Content.Blocks[0].AttachmentID = "other-image"
	if _, err := topicService.CreateMessage(ctx, input); err == nil {
		t.Fatal("accepted another user's staging attachment")
	}
	input.ClientMessageID = "rich"
	input.SyncToGroup = true
	input.ReplyToMessageID = image.Message.ID
	input.Content.Blocks = []topics.Block{{Type: "text", Text: "#[Should stay text](nested) "}, {Type: "mention", UserID: "topic-peer", Label: "forged label"}, {Type: "emoji", Shortcode: "custom:11111111-1111-4111-8111-111111111111"}, {Type: "emote_collection", ShareID: "topic-share"}}
	rich, err := topicService.CreateMessage(ctx, input)
	if err != nil {
		t.Fatalf("rich reply: %v", err)
	}
	if rich.Message.Content.Blocks[1].Label == "forged label" || rich.Message.ReplyToMessageID == nil || len(rich.Message.Content.Blocks[3].Share) == 0 {
		t.Fatalf("rich normalization/projection: %+v", rich.Message)
	}
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM topics`, 1)
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM message_custom_emotes`, 1)
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM message_emote_collection_shares`, 1)
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM workspace_cards WHERE card_type='workspace.topic-message-synced' AND status='active'`, 1)
	lateFailure := topics.CreateMessageInput{ActorID: "inline-owner", TopicID: topic.ID, ClientMessageID: "late-association-failure", Content: topics.Content{Format: topics.MessageContentFormat, Blocks: []topics.Block{{Type: "emoji", Shortcode: "custom:22222222-2222-4222-8222-222222222222"}}}}
	if _, err := topicService.CreateMessage(ctx, lateFailure); err == nil {
		t.Fatal("missing custom emote association unexpectedly committed")
	}
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM messages WHERE client_message_id='late-association-failure'`, 0)
	input.ClientMessageID = "cross-scope-reply"
	input.ReplyToMessageID = group[0].ID
	if _, err := topicService.CreateMessage(ctx, input); err == nil {
		t.Fatal("accepted parent-group reply in topic")
	}
	if _, err := topicService.ListMessages(ctx, topics.MessageListInput{ActorID: "topic-outside", TopicID: topic.ID}); err == nil {
		t.Fatal("outsider read topic")
	}
	for _, id := range []string{image.Message.ID, rich.Message.ID} {
		if _, err := messageService.AddReaction(ctx, messages.ReactionInput{ActorID: "topic-outside", MessageID: id, EmoteKey: "builtin:wave"}); err == nil {
			t.Fatal("outsider reacted")
		}
		if _, err := messageService.HideMessage(ctx, messages.HideInput{ActorID: "topic-outside", MessageID: id}); err == nil {
			t.Fatal("outsider hid topic message")
		}
	}
	if _, err := messageService.AddReaction(ctx, messages.ReactionInput{ActorID: "topic-peer", MessageID: image.Message.ID, EmoteKey: "builtin:wave"}); err != nil {
		t.Fatalf("topic reaction: %v", err)
	}
	if _, err := messageService.HideMessage(ctx, messages.HideInput{ActorID: "topic-peer", MessageID: image.Message.ID}); err != nil {
		t.Fatal(err)
	}
	read, err := topicService.ListMessages(ctx, topics.MessageListInput{ActorID: "topic-peer", TopicID: topic.ID, Around: image.Message.ID, Limit: 41})
	if err != nil || len(read) != 3 {
		t.Fatalf("around: %+v %v", read, err)
	}
	var found bool
	for _, item := range read {
		if item.ID == image.Message.ID {
			found = true
			if len(item.Reactions) != 1 || !item.HiddenByCurrentUser || len(item.Attachments) != 1 {
				t.Fatalf("missing common read states: %+v", item)
			}
		}
	}
	if !found {
		t.Fatal("around anchor absent")
	}
	wrong, err := topicService.ListMessages(ctx, topics.MessageListInput{ActorID: "topic-peer", TopicID: topic.ID, Around: group[0].ID})
	if err != nil || len(wrong) != 0 {
		t.Fatalf("around crossed scope: %+v %v", wrong, err)
	}
	recalled, err := messageService.RecallMessage(ctx, messages.RecallInput{ActorID: "inline-owner", MessageID: rich.Message.ID})
	if err != nil || recalled.RecalledAt == nil || len(recalled.Content.Blocks) != 0 {
		t.Fatalf("recall: %+v %v", recalled, err)
	}
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM message_custom_emotes`, 0)
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM message_emote_collection_shares`, 0)
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM topic_group_projections WHERE removed_at IS NULL`, 0)
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM workspace_cards WHERE card_type='workspace.topic-message-synced' AND status='active'`, 0)
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM workspace_cards WHERE card_type='workspace.topic-message-synced' AND ((payload_json::jsonb->>'messagePreview') <> '' OR fallback_text LIKE '%nested%')`, 0)
	if _, err := topicService.SyncMessage(ctx, topics.SyncInput{ActorID: "inline-owner", TopicID: topic.ID, MessageID: rich.Message.ID}); err == nil {
		t.Fatal("recalled message can be synced again")
	}
	read, err = topicService.ListMessages(ctx, topics.MessageListInput{ActorID: "topic-peer", TopicID: topic.ID})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range read {
		if item.ID == rich.Message.ID && (item.RecalledAt == nil || len(item.Content.Blocks) != 0 || len(item.Attachments) != 0) {
			t.Fatalf("recalled topic content leaked: %+v", item)
		}
	}
	var event string
	if err := pool.QueryRow(ctx, `SELECT payload_json FROM workspace_events WHERE type='topic.message.recalled'`).Scan(&event); err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(event), &payload); err != nil || payload["topicId"] != topic.ID {
		t.Fatalf("topic action audience: %s %v", event, err)
	}
	legacy, err := topicService.CreateMessage(ctx, topics.CreateMessageInput{ActorID: "inline-owner", TopicID: topic.ID, ClientMessageID: "legacy-unsynced", Body: "legacy source", SyncToGroup: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := topicService.UnsyncMessage(ctx, topics.SyncInput{ActorID: "inline-owner", TopicID: topic.ID, MessageID: legacy.Message.ID}); err != nil {
		t.Fatal(err)
	}
	// Older versions kept previews in invalidated registry rows. Recalling
	// that existing source must also erase the cache, not merely active cards.
	if _, err := pool.Exec(ctx, `UPDATE workspace_cards SET payload_json=jsonb_set(payload_json::jsonb,'{messagePreview}','"legacy-visible"'::jsonb)::text, fallback_text='legacy-visible' WHERE source_id=$1`, "topic-message:"+topic.ID+":"+legacy.Message.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := messageService.RecallMessage(ctx, messages.RecallInput{ActorID: "inline-owner", MessageID: legacy.Message.ID}); err != nil {
		t.Fatal(err)
	}
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM workspace_cards WHERE payload_json LIKE '%legacy-visible%' OR fallback_text LIKE '%legacy-visible%'`, 0)
	if _, err := topicService.Leave(ctx, topics.TopicInput{ActorID: "topic-peer", TopicID: topic.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := messageService.AddReaction(ctx, messages.ReactionInput{ActorID: "topic-peer", MessageID: image.Message.ID, EmoteKey: "builtin:wave"}); err == nil {
		t.Fatal("left member reacted")
	}
	if _, err := topicService.Close(ctx, topics.TransitionInput{ActorID: "inline-owner", TopicID: topic.ID, ExpectedRevision: topic.Revision}); err != nil {
		t.Fatal(err)
	}
	if _, err := messageService.AddReaction(ctx, messages.ReactionInput{ActorID: "inline-owner", MessageID: image.Message.ID, EmoteKey: "builtin:wave"}); err == nil {
		t.Fatal("closed topic reacted")
	}
	input.ClientMessageID = fmt.Sprintf("closed-%s", topic.ID)
	if _, err := topicService.CreateMessage(ctx, input); err == nil {
		t.Fatal("closed topic accepted content")
	}
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM audit_logs WHERE result='rejected' AND action='topic.message.create'`, 3)
}
