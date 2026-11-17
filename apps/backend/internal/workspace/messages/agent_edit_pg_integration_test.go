//go:build postgres_integration

package messages

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type pgAgentEditFixture struct {
	*pgMessageIntegrationFixture
	service *Service
	record  *MessageRecord
}

func newPGAgentEditFixture(t *testing.T) *pgAgentEditFixture {
	t.Helper()
	fixture := newPGMessageIntegrationFixture(t)
	repository, ok := fixture.service.Repository().(*PGRepository)
	if !ok {
		t.Fatal("message repository is not PostgreSQL")
	}
	mustExecPGMessageIntegrationPool(t, fixture, `
		INSERT INTO users (
			id, github_id, github_login, email, display_name, nickname,
			kind, created_at, last_login_at
		) VALUES ('bot-agent-edit', NULL, '__duallane_bot_agent_edit', NULL,
			'Agent Edit', 'Agent Edit', 'bot', $1, NULL)
	`, fixture.now)
	mustExecPGMessageIntegrationPool(t, fixture, `
		INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
		VALUES ($1, 'bot-agent-edit', 'member', $2, NULL)
	`, DefaultSpaceID, fixture.now)
	mustExecPGMessageIntegrationPool(t, fixture, `
		INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
		VALUES ('conv-messages', 'bot-agent-edit', $1, NULL)
	`, fixture.now)
	for _, attachmentID := range []string{"agent-edit-old", "agent-edit-new"} {
		mustExecPGMessageIntegrationPool(t, fixture, `
			INSERT INTO attachments (
				id, space_id, uploader_id, conversation_id, visibility, status,
				file_name, mime_type, byte_size, created_at, completed_at
			) VALUES ($1, $2, 'bot-agent-edit', 'conv-messages', 'conversation', 'available',
				$3, 'text/plain', 12, $4, $4)
		`, attachmentID, DefaultSpaceID, attachmentID+".txt", fixture.now)
	}
	service := NewService(ServiceOptions{
		Repository: repository,
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return fixture.now },
		AllowBots:  true,
	})
	created, err := service.CreateMessage(fixture.ctx, CreateInput{
		ActorID:         "bot-agent-edit",
		ConversationID:  "conv-messages",
		ClientMessageID: "agent-edit-original",
		Content: Content{Format: MessageContentFormat, Blocks: []Block{
			{Type: "text", Text: "原始机器人消息"},
			{Type: "attachment", AttachmentID: "agent-edit-old"},
		}},
	})
	if err != nil {
		t.Fatalf("create Agent message: %v", err)
	}
	record, err := repository.FindMessage(fixture.ctx, DefaultSpaceID, "conv-messages", created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if record == nil {
		t.Fatal("created Agent message is missing")
	}
	return &pgAgentEditFixture{pgMessageIntegrationFixture: fixture, service: service, record: record}
}

func TestPGEditAgentMessageInTxPersistsContentRelationshipsAndEvidence(t *testing.T) {
	fixture := newPGAgentEditFixture(t)
	var edited Message
	err := fixture.service.Repository().WithTx(fixture.ctx, func(tx Tx) error {
		var editErr error
		edited, editErr = fixture.service.EditAgentMessageInTx(fixture.ctx, tx, AgentEditInput{
			ActorID:         "bot-agent-edit",
			ConversationID:  "conv-messages",
			MessageID:       fixture.record.ID,
			ExpectedVersion: AgentMessageRecordVersion(*fixture.record),
			Content: Content{
				Format:    MessageContentFormat,
				PlainText: "ignored client projection",
				Blocks: []Block{
					{Type: "text", Text: "更新后的机器人消息"},
					{Type: "mention", UserID: "usr-alice", Label: "forged"},
					{Type: "attachment", AttachmentID: "agent-edit-new"},
				},
			},
			Meta: auth.RequestMeta{RequestID: "agent-edit-request"},
		})
		return editErr
	})
	if err != nil {
		t.Fatalf("edit Agent message: %v", err)
	}
	if edited.PlainText != "更新后的机器人消息@Alice[文件]" || edited.EditedAt == nil {
		t.Fatalf("edited projection = %#v", edited)
	}
	var storedContent, storedPlain string
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT content_json, plain_text FROM messages WHERE id = $1
	`, fixture.record.ID).Scan(&storedContent, &storedPlain); err != nil {
		t.Fatal(err)
	}
	if storedPlain != "更新后的机器人消息@Alice[文件]" || !strings.Contains(storedContent, "agent-edit-new") || strings.Contains(storedContent, "agent-edit-old") {
		t.Fatalf("stored Agent edit = content:%s plain:%s", storedContent, storedPlain)
	}
	var attachmentID string
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT attachment_id FROM message_attachments WHERE message_id = $1
	`, fixture.record.ID).Scan(&attachmentID); err != nil {
		t.Fatal(err)
	}
	if attachmentID != "agent-edit-new" {
		t.Fatalf("message attachment after edit = %q", attachmentID)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM workspace_events WHERE type = 'message.edited' AND target_id = $1
	`, fixture.record.ID); got != 1 {
		t.Fatalf("edit events = %d, want 1", got)
	}
	var payload string
	if err := fixture.pool.QueryRow(fixture.ctx, `
		SELECT payload_json FROM workspace_events WHERE type = 'message.edited' AND target_id = $1
	`, fixture.record.ID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(payload, "更新后的机器人消息") || strings.Contains(payload, "agent-edit-new") {
		t.Fatalf("edit event leaked content: %s", payload)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `
		SELECT COUNT(*) FROM audit_logs WHERE action = 'message.edit' AND target_id = $1 AND result = 'success'
	`, fixture.record.ID); got != 1 {
		t.Fatalf("edit audits = %d, want 1", got)
	}
}

func TestPGEditAgentMessageInTxRejectsStaleVersion(t *testing.T) {
	fixture := newPGAgentEditFixture(t)
	oldVersion := AgentMessageRecordVersion(*fixture.record)
	err := fixture.service.Repository().WithTx(fixture.ctx, func(tx Tx) error {
		_, editErr := fixture.service.EditAgentMessageInTx(fixture.ctx, tx, AgentEditInput{
			ActorID: "bot-agent-edit", ConversationID: "conv-messages", MessageID: fixture.record.ID,
			ExpectedVersion: oldVersion, Content: Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: "first edit"}, {Type: "attachment", AttachmentID: "agent-edit-old"}}},
		})
		return editErr
	})
	if err != nil {
		t.Fatalf("first edit: %v", err)
	}
	eventsBefore := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `SELECT COUNT(*) FROM workspace_events WHERE type = 'message.edited' AND target_id = $1`, fixture.record.ID)
	contentBefore := ""
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT content_json FROM messages WHERE id = $1`, fixture.record.ID).Scan(&contentBefore); err != nil {
		t.Fatal(err)
	}
	err = fixture.service.Repository().WithTx(fixture.ctx, func(tx Tx) error {
		_, editErr := fixture.service.EditAgentMessageInTx(fixture.ctx, tx, AgentEditInput{
			ActorID: "bot-agent-edit", ConversationID: "conv-messages", MessageID: fixture.record.ID,
			ExpectedVersion: oldVersion, Content: Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: "stale edit"}, {Type: "attachment", AttachmentID: "agent-edit-old"}}},
		})
		return editErr
	})
	if !isMessageCode(err, CodeMessageRevisionConflict) {
		t.Fatalf("stale edit error = %v", err)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `SELECT COUNT(*) FROM workspace_events WHERE type = 'message.edited' AND target_id = $1`, fixture.record.ID); got != eventsBefore {
		t.Fatalf("stale edit events = %d, want %d", got, eventsBefore)
	}
	var contentAfter string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT content_json FROM messages WHERE id = $1`, fixture.record.ID).Scan(&contentAfter); err != nil {
		t.Fatal(err)
	}
	if contentAfter != contentBefore {
		t.Fatal("stale edit changed stored content")
	}
}

func TestPGEditAgentMessageInTxRollsBackEvidenceAndRelations(t *testing.T) {
	fixture := newPGAgentEditFixture(t)
	contentBefore := ""
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT content_json FROM messages WHERE id = $1`, fixture.record.ID).Scan(&contentBefore); err != nil {
		t.Fatal(err)
	}
	eventsBefore := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `SELECT COUNT(*) FROM workspace_events WHERE type = 'message.edited' AND target_id = $1`, fixture.record.ID)
	auditsBefore := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `SELECT COUNT(*) FROM audit_logs WHERE action = 'message.edit' AND target_id = $1`, fixture.record.ID)
	rollbackErr := errors.New("agent edit rollback")
	err := fixture.service.Repository().WithTx(fixture.ctx, func(tx Tx) error {
		if _, err := fixture.service.EditAgentMessageInTx(fixture.ctx, tx, AgentEditInput{
			ActorID: "bot-agent-edit", ConversationID: "conv-messages", MessageID: fixture.record.ID,
			ExpectedVersion: AgentMessageRecordVersion(*fixture.record), Content: Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: "rolled back"}, {Type: "attachment", AttachmentID: "agent-edit-new"}}},
		}); err != nil {
			return err
		}
		return rollbackErr
	})
	if !errors.Is(err, rollbackErr) {
		t.Fatalf("rollback error = %v", err)
	}
	var contentAfter string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT content_json FROM messages WHERE id = $1`, fixture.record.ID).Scan(&contentAfter); err != nil {
		t.Fatal(err)
	}
	if contentAfter != contentBefore {
		t.Fatal("rolled back edit changed content")
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `SELECT COUNT(*) FROM workspace_events WHERE type = 'message.edited' AND target_id = $1`, fixture.record.ID); got != eventsBefore {
		t.Fatalf("rolled back events = %d, want %d", got, eventsBefore)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `SELECT COUNT(*) FROM audit_logs WHERE action = 'message.edit' AND target_id = $1`, fixture.record.ID); got != auditsBefore {
		t.Fatalf("rolled back audits = %d, want %d", got, auditsBefore)
	}
	var attachmentID string
	if err := fixture.pool.QueryRow(fixture.ctx, `SELECT attachment_id FROM message_attachments WHERE message_id = $1`, fixture.record.ID).Scan(&attachmentID); err != nil {
		t.Fatal(err)
	}
	if attachmentID != "agent-edit-old" {
		t.Fatalf("rolled back attachment = %q", attachmentID)
	}
}

func TestPGEditAgentMessageInTxConcurrentExpectedVersionAllowsOneWriter(t *testing.T) {
	fixture := newPGAgentEditFixture(t)
	version := AgentMessageRecordVersion(*fixture.record)
	results := make(chan error, 2)
	var wait sync.WaitGroup
	for _, text := range []string{"竞争编辑一", "竞争编辑二"} {
		text := text
		wait.Add(1)
		go func() {
			defer wait.Done()
			results <- fixture.service.Repository().WithTx(fixture.ctx, func(tx Tx) error {
				_, err := fixture.service.EditAgentMessageInTx(fixture.ctx, tx, AgentEditInput{
					ActorID: "bot-agent-edit", ConversationID: "conv-messages", MessageID: fixture.record.ID,
					ExpectedVersion: version, Content: Content{Format: MessageContentFormat, Blocks: []Block{{Type: "text", Text: text}, {Type: "attachment", AttachmentID: "agent-edit-old"}}},
				})
				return err
			})
		}()
	}
	wait.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		switch {
		case err == nil:
			successes++
		case isMessageCode(err, CodeMessageRevisionConflict):
			conflicts++
		default:
			t.Fatalf("concurrent edit error = %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent edit outcomes = success:%d conflict:%d", successes, conflicts)
	}
	if got := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `SELECT COUNT(*) FROM workspace_events WHERE type = 'message.edited' AND target_id = $1`, fixture.record.ID); got != 1 {
		t.Fatalf("concurrent edit events = %d, want 1", got)
	}
}
