//go:build postgres_integration

package botgateway

import (
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	platformstorage "github.com/timestarry/duallane/apps/backend/internal/platform/storage"
	workspacefiles "github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

type agentUploadAuthorizationFixture struct {
	*agentPlatformPGFixture
	files *workspacefiles.Service
}

func openAgentUploadAuthorizationFixture(t *testing.T) *agentUploadAuthorizationFixture {
	t.Helper()
	fixture := openAgentPlatformPGFixture(t)
	agentPlatformSetTokenScopes(t, fixture, fixture.auth.TokenID, []string{
		ScopeMessagesReadTrigger,
		ScopeMessagesReadContext,
		ScopeFilesWrite,
	})

	fileRepository := workspacefiles.NewPGRepository(fixture.pool)
	blobStore, err := platformstorage.NewLocalBlobStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fileService := workspacefiles.NewService(workspacefiles.ServiceOptions{
		Repository: fileRepository,
		BlobStore:  blobStore,
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return fixture.now },
	})
	gatewayRepository := NewPGRepositoryWithDomainTransactions(fixture.pool, DomainTransactionOptions{Files: fileRepository})
	gateway := NewService(ServiceOptions{
		Repository: gatewayRepository,
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return fixture.now },
	})
	authValue, err := gateway.Authenticate(fixture.ctx, "Bearer "+agentPlatformRawToken, TokenAuthOptions{SpaceID: DefaultSpaceID})
	if err != nil {
		t.Fatal(err)
	}
	fixture.service = gateway
	fixture.auth = authValue
	return &agentUploadAuthorizationFixture{agentPlatformPGFixture: fixture, files: fileService}
}

func reserveAgentTaskUpload(t *testing.T, fixture *agentUploadAuthorizationFixture) (context.Context, *AgentTask, workspacefiles.UploadResult) {
	t.Helper()
	agentPlatformQueueSeedEvent(t, fixture.agentPlatformPGFixture)
	created, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-botgateway")
	if err != nil {
		t.Fatal(err)
	}
	task := agentPlatformTask(created)
	if task == nil {
		t.Fatal("missing upload task")
	}
	taskContext := WithAgentTaskID(fixture.ctx, task.ID)
	if err := fixture.service.ReserveAgentUploadBudget(taskContext, fixture.auth, task.ConversationID); err != nil {
		t.Fatal(err)
	}
	reserved, err := fixture.files.ReserveAgentBotUpload(taskContext, workspacefiles.ReserveUploadInput{
		ActorID:        fixture.auth.UserID,
		FileName:       "task-input.txt",
		MIMEType:       "text/plain",
		ByteSize:       5,
		Visibility:     string(workspacefiles.VisibilityConversation),
		ConversationID: task.ConversationID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if reserved.Status != string(workspacefiles.TransferReserved) || reserved.Attachment == nil || reserved.ID == "" {
		t.Fatalf("upload reservation = %#v", reserved)
	}
	if err := fixture.service.BindAgentUpload(taskContext, fixture.auth, reserved.ID, task.ConversationID); err != nil {
		t.Fatal(err)
	}
	return taskContext, task, reserved
}

func createSiblingUploadTask(t *testing.T, fixture *agentUploadAuthorizationFixture, parent *AgentTask) *AgentTask {
	t.Helper()
	agentPlatformInsertMessageEventDelivery(t, fixture.agentPlatformPGFixture, agentPlatformEventInput{
		BotID: fixture.auth.BotID, ConversationID: parent.ConversationID, AuthorID: fixture.auth.OwnerUserID,
		MessageID: "message-agent-upload-task-b", EventID: "event-agent-upload-task-b", DeliveryID: "delivery-agent-upload-task-b",
		Sequence: 200, Text: "同会话的另一个任务", CreatedAt: fixture.now.Add(-30 * time.Second),
	})
	created, err := fixture.service.CreateAgentTask(fixture.ctx, fixture.auth, "event-agent-upload-task-b")
	if err != nil {
		t.Fatal(err)
	}
	task := agentPlatformTask(created)
	if task == nil {
		t.Fatal("missing sibling upload task")
	}
	if task.RootTaskID == parent.RootTaskID || task.ConversationID != parent.ConversationID {
		t.Fatalf("sibling task binding = root %q conversation %q", task.RootTaskID, task.ConversationID)
	}
	return task
}

type gatedUploadReader struct {
	payload     []byte
	entered     chan struct{}
	release     chan struct{}
	once        sync.Once
	releaseOnce sync.Once
	done        bool
}

func newGatedUploadReader(payload string) *gatedUploadReader {
	return &gatedUploadReader{
		payload: []byte(payload),
		entered: make(chan struct{}),
		release: make(chan struct{}),
	}
}

func (r *gatedUploadReader) Release() {
	r.releaseOnce.Do(func() { close(r.release) })
}

func (r *gatedUploadReader) Read(destination []byte) (int, error) {
	if r.done {
		return 0, io.EOF
	}
	r.once.Do(func() { close(r.entered) })
	<-r.release
	r.done = true
	return copy(destination, r.payload), nil
}

func TestPGBotAgentFileFinalizeRechecksAuthorizationAfterBodyStaging(t *testing.T) {
	testCases := []struct {
		name       string
		invalidate func(*agentUploadAuthorizationFixture, *AgentTask) error
	}{
		{
			name: "root cancellation",
			invalidate: func(fixture *agentUploadAuthorizationFixture, task *AgentTask) error {
				if _, err := fixture.service.CancelAgentTask(fixture.ctx, fixture.auth, task.ID); err != nil {
					return err
				}
				return nil
			},
		},
		{
			name: "token revocation",
			invalidate: func(fixture *agentUploadAuthorizationFixture, _ *AgentTask) error {
				if _, err := fixture.pool.Exec(fixture.ctx,
					`UPDATE workspace_agent_bot_tokens SET revoked_at = $1 WHERE id = $2`,
					fixture.now, fixture.auth.TokenID,
				); err != nil {
					return err
				}
				return nil
			},
		},
		{
			name: "context grant revocation",
			invalidate: func(fixture *agentUploadAuthorizationFixture, task *AgentTask) error {
				if _, err := fixture.pool.Exec(fixture.ctx, `
					UPDATE workspace_agent_bot_context_grants
					SET allow_context = 0, updated_at = $1
					WHERE bot_id = $2 AND space_id = $3 AND conversation_id = $4
				`, fixture.now, fixture.auth.BotID, fixture.auth.SpaceID, task.ConversationID); err != nil {
					return err
				}
				return nil
			},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := openAgentUploadAuthorizationFixture(t)
			taskContext, task, reserved := reserveAgentTaskUpload(t, fixture)
			body := newGatedUploadReader("hello")
			defer body.Release()
			resultCh := make(chan struct {
				result workspacefiles.UploadResult
				err    error
			}, 1)
			go func() {
				result, err := fixture.files.CompleteAgentBotUpload(taskContext, workspacefiles.CompleteUploadInput{
					FinalizeTransaction: fixture.service.AgentFileFinalizeTransaction(taskContext, fixture.auth, reserved.ID),
					ActorID:             fixture.auth.UserID,
					UploadID:            reserved.ID,
					Mode:                "single",
					Content:             body,
				})
				resultCh <- struct {
					result workspacefiles.UploadResult
					err    error
				}{result: result, err: err}
			}()

			select {
			case <-body.entered:
			case <-time.After(10 * time.Second):
				t.Fatal("upload body was not staged")
			}
			// The request has passed the initial identity and upload checks but has
			// not reached promotion. The finalizer must observe this change.
			if err := testCase.invalidate(fixture, task); err != nil {
				t.Fatal(err)
			}
			body.Release()

			var completion struct {
				result workspacefiles.UploadResult
				err    error
			}
			select {
			case completion = <-resultCh:
			case <-time.After(15 * time.Second):
				t.Fatal("upload completion did not return")
			}
			if completion.err == nil {
				t.Fatalf("completion unexpectedly succeeded: %#v", completion.result)
			}

			attachment, err := fixture.files.Repository().GetAttachment(fixture.ctx, fixture.auth.SpaceID, reserved.Attachment.ID)
			if err != nil {
				t.Fatal(err)
			}
			if attachment == nil || attachment.Status == string(workspacefiles.AttachmentAvailable) {
				t.Fatalf("staged attachment became available: %#v", attachment)
			}
			transfer, err := fixture.files.Repository().GetTransfer(fixture.ctx, fixture.auth.SpaceID, fixture.auth.UserID, reserved.ID, workspacefiles.TransferUpload)
			if err != nil {
				t.Fatal(err)
			}
			if transfer == nil || transfer.Status == string(workspacefiles.TransferCompleted) {
				t.Fatalf("staged transfer became completed: %#v", transfer)
			}

			var availableEvents, messageReceipts int
			if err := fixture.pool.QueryRow(fixture.ctx, `
				SELECT COUNT(*) FROM workspace_events
				WHERE type = 'attachment.available' AND target_type = 'attachment' AND target_id = $1
			`, reserved.Attachment.ID).Scan(&availableEvents); err != nil {
				t.Fatal(err)
			}
			if err := fixture.pool.QueryRow(fixture.ctx, `
				SELECT COUNT(*) FROM messages
				WHERE space_id = $1 AND content_json::text LIKE '%' || $2 || '%'
			`, fixture.auth.SpaceID, reserved.Attachment.ID).Scan(&messageReceipts); err != nil {
				t.Fatal(err)
			}
			if availableEvents != 0 || messageReceipts != 0 {
				t.Fatalf("failed upload emitted publication evidence: availableEvents=%d messageReceipts=%d", availableEvents, messageReceipts)
			}
		})
	}
}

func TestPGBotAgentUploadBindingDoesNotCrossSiblingTasks(t *testing.T) {
	fixture := openAgentUploadAuthorizationFixture(t)
	_, taskA, reserved := reserveAgentTaskUpload(t, fixture)
	taskB := createSiblingUploadTask(t, fixture, taskA)
	taskBContext := WithAgentTaskID(fixture.ctx, taskB.ID)

	if err := fixture.service.AuthorizeAgentUpload(taskBContext, fixture.auth, reserved.ID); err == nil {
		t.Fatal("sibling task queried an upload bound to task A")
	} else if !isCode(err, "task.authorization_required") {
		t.Fatalf("sibling upload query error = %v", err)
	}

	_, err := fixture.files.CompleteAgentBotUpload(taskBContext, workspacefiles.CompleteUploadInput{
		FinalizeTransaction: fixture.service.AgentFileFinalizeTransaction(taskBContext, fixture.auth, reserved.ID),
		ActorID:             fixture.auth.UserID,
		UploadID:            reserved.ID,
		Mode:                "single",
		Content:             strings.NewReader("hello"),
	})
	if err == nil {
		t.Fatal("sibling task completed an upload bound to task A")
	}
	if !isCode(err, "task.authorization_required") && !isCode(err, "task.invalidated") {
		t.Fatalf("sibling upload completion error = %v", err)
	}

	attachment, err := fixture.files.Repository().GetAttachment(fixture.ctx, fixture.auth.SpaceID, reserved.Attachment.ID)
	if err != nil {
		t.Fatal(err)
	}
	transfer, err := fixture.files.Repository().GetTransfer(fixture.ctx, fixture.auth.SpaceID, fixture.auth.UserID, reserved.ID, workspacefiles.TransferUpload)
	if err != nil {
		t.Fatal(err)
	}
	if attachment == nil || attachment.Status == string(workspacefiles.AttachmentAvailable) || transfer == nil || transfer.Status == string(workspacefiles.TransferCompleted) {
		t.Fatalf("sibling task changed upload publication: attachment=%#v transfer=%#v", attachment, transfer)
	}
}
