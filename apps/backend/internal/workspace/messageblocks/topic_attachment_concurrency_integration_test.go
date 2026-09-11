//go:build postgres_integration

package messageblocks

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/messages"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/topics"
)

type attachmentValidationBarrier struct {
	entered chan struct{}
	release <-chan struct{}
}

func (b attachmentValidationBarrier) ValidateBlock(ctx context.Context, _ *auth.Actor, _ string, block messages.Block) (messages.Block, error) {
	select {
	case b.entered <- struct{}{}:
	case <-ctx.Done():
		return messages.Block{}, ctx.Err()
	}
	select {
	case <-b.release:
		return block, nil
	case <-ctx.Done():
		return messages.Block{}, ctx.Err()
	}
}

// Pause the first writer after attachment validation, then make the other
// parent group's writer either reach validation or wait for its attachment
// lock. This reproduces the old double-publication race without timing sleeps.
func TestPGTopicStagingAttachmentHasOneScopeUnderConcurrentSend(t *testing.T) {
	ctx, pool := inlineTopicDatabase(t)
	for _, query := range []string{
		`INSERT INTO conversations (id,space_id,type,title,retention_count,created_by,created_at) VALUES ('other-group','spc_default','group','Other group',10000,'inline-owner',NOW())`,
		`INSERT INTO conversation_members (conversation_id,user_id,joined_at) VALUES ('other-group','inline-owner',NOW())`,
		`INSERT INTO attachments(id,space_id,uploader_id,visibility,status,file_name,mime_type,byte_size,created_at,completed_at) VALUES ('race-a','spc_default','inline-owner','private_staging','available','a.png','image/png',123,NOW(),NOW()),('race-b','spc_default','inline-owner','private_staging','available','b.png','image/png',123,NOW(),NOW())`,
		`INSERT INTO workspace_custom_emotes(id,user_id,source_type,source_emote_key,label,sort_order,created_at) VALUES ('11111111-1111-4111-8111-111111111111','inline-owner','builtin','builtin:wave','Wave',0,NOW())`,
	} {
		if _, err := pool.Exec(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	config := pool.Config().Copy()
	competitorName := fmt.Sprintf("topic-attachment-race-%d", time.Now().UnixNano())
	config.ConnConfig.RuntimeParams["application_name"] = competitorName
	competitorPool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(competitorPool.Close)
	release := make(chan struct{})
	var released sync.Once
	finish := func() { released.Do(func() { close(release) }) }
	t.Cleanup(finish)
	firstEntered, secondEntered := make(chan struct{}, 1), make(chan struct{}, 1)
	newService := func(database *pgxpool.Pool, entered chan struct{}) *topics.Service {
		repository := topics.NewPGRepository(database)
		service := topics.NewService(topics.ServiceOptions{Repository: repository})
		messageRepository := messages.NewPGRepository(database)
		messageService := messages.NewService(messages.ServiceOptions{Repository: messageRepository,
			AdvancedBlockValidator: attachmentValidationBarrier{entered: entered, release: release},
		})
		service.SetMessagePipeline(NewTopicMessagePipeline(messageService, messageRepository, service))
		return service
	}
	first, second := newService(pool, firstEntered), newService(competitorPool, secondEntered)
	createTopic := func(service *topics.Service, group string) topics.Topic {
		t.Helper()
		topic, err := service.Create(ctx, topics.CreateInput{ActorID: "inline-owner", ConversationID: group, Title: "Attachment race", Description: "Initial", IdempotencyKey: group})
		if err != nil {
			t.Fatal(err)
		}
		return topic
	}
	firstTopic, secondTopic := createTopic(first, "inline-group"), createTopic(second, "other-group")
	input := func(topicID, a, b string) topics.CreateMessageInput {
		return topics.CreateMessageInput{ActorID: "inline-owner", TopicID: topicID, ClientMessageID: "racing-send", Content: topics.Content{Format: topics.MessageContentFormat, Blocks: []topics.Block{
			{Type: "attachment", AttachmentID: a}, {Type: "attachment", AttachmentID: b},
			{Type: "emoji", Shortcode: "custom:11111111-1111-4111-8111-111111111111"},
		}}}
	}
	type sendResult struct {
		message topics.TopicMessageResult
		err     error
	}
	firstResult, secondResult := make(chan sendResult, 1), make(chan sendResult, 1)
	go func() {
		message, err := first.CreateMessage(ctx, input(firstTopic.ID, "race-a", "race-b"))
		firstResult <- sendResult{message, err}
	}()
	select {
	case <-firstEntered:
	case result := <-firstResult:
		t.Fatalf("first writer did not reach validation barrier: %v", result.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	go func() {
		message, err := second.CreateMessage(ctx, input(secondTopic.ID, "race-b", "race-a"))
		secondResult <- sendResult{message, err}
	}()
	// The observed PostgreSQL lock wait makes this check independent of CPU
	// scheduling. The unpatched writer instead reaches the second barrier.
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	waiting := false
	for !waiting {
		select {
		case <-secondEntered:
			waiting = true
		case result := <-secondResult:
			t.Fatalf("competing writer failed before serialization: %v", result.err)
		case <-ticker.C:
			if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND wait_event='advisory')`, competitorName).Scan(&waiting); err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	var waitsForFirstAttachment bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
		WHERE a.application_name=$1 AND l.locktype='advisory' AND NOT l.granted
		AND l.classid::bigint=((hashtextextended($2,0)>>32)&4294967295)
		AND l.objid::bigint=(hashtextextended($2,0)&4294967295)
	)`, competitorName, "workspace-attachment:race-a").Scan(&waitsForFirstAttachment); err != nil {
		t.Fatal(err)
	}
	finish()
	firstSend, secondSend := <-firstResult, <-secondResult
	if firstSend.err != nil {
		t.Fatalf("first sender failed: %v", firstSend.err)
	}
	var rejected *topics.Error
	if !errors.As(secondSend.err, &rejected) || rejected.Code != messages.CodeMessageInvalidAttach {
		t.Fatalf("competing topic must reject already-associated staging attachment; first=%s second=%s error=%v", firstSend.message.Message.ID, secondSend.message.Message.ID, secondSend.err)
	}
	if !waitsForFirstAttachment {
		t.Fatal("reverse-order sender must wait for the first sorted attachment before locking any later attachment")
	}
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM messages WHERE client_message_id='racing-send'`, 1)
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM message_attachments WHERE attachment_id IN ('race-a','race-b')`, 2)
	assertInlineCount(t, ctx, pool, `SELECT count(DISTINCT m.topic_id) FROM message_attachments ma JOIN messages m ON m.id=ma.message_id WHERE ma.attachment_id IN ('race-a','race-b')`, 1)
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM audit_logs WHERE action='topic.message.create' AND result='rejected'`, 1)
	assertInlineCount(t, ctx, pool, `SELECT count(*) FROM attachments WHERE id IN ('race-a','race-b') AND visibility='private_staging'`, 2)
}
