package botgateway

import (
	"context"

	workspacefiles "github.com/timestarry/duallane/apps/backend/internal/workspace/files"
)

type agentFileTransactionProvider interface{ FileTransaction() workspacefiles.Tx }

func (t *pgTx) FileTransaction() workspacefiles.Tx {
	if t.repository != nil && t.repository.fileRepository != nil {
		return t.repository.fileRepository.NewTransaction(t.tx)
	}
	return workspacefiles.NewPGTransaction(t.tx)
}

// AgentFileFinalizeTransaction runs after request bytes have been staged. All
// task and authorization dependencies are locked/rechecked before promotion,
// and the owning files service keeps its quota, digest, event and audit rules.
func (s *Service) AgentFileFinalizeTransaction(ctx context.Context, value *Auth, uploadID string) workspacefiles.FinalizeTransaction {
	if AgentTaskID(ctx) == "" {
		return nil
	}
	return func(fileCtx context.Context, apply func(workspacefiles.Tx) error) error {
		return s.repo.WithTx(fileCtx, func(tx Tx) error {
			store, ok := tx.(AgentTaskMutation)
			if !ok {
				return taskForbidden()
			}
			if err := store.LockAgentAuthorization(fileCtx, AgentTaskID(ctx), s.nowUTC()); err != nil {
				return err
			}
			current, err := tx.ValidateToken(fileCtx, value.TokenID, value.BotID, value.SpaceID, s.nowUTC())
			if err != nil {
				return err
			}
			if current == nil {
				return invalidTokenError()
			}
			if err := RequireScope(current, ScopeFilesWrite); err != nil {
				return err
			}
			task, err := store.GetAgentTask(fileCtx, AgentTaskID(ctx))
			if err != nil {
				return err
			}
			if err := s.validateAgentTask(fileCtx, tx, store, current, task, ""); err != nil {
				return err
			}
			uploads, ok := tx.(agentUploadScopeReader)
			if !ok {
				return taskForbidden()
			}
			conversationID, err := uploads.AgentUploadConversation(fileCtx, current.SpaceID, current.UserID, uploadID)
			if err != nil {
				return err
			}
			if conversationID != task.ConversationID {
				return taskForbidden()
			}
			provider, ok := tx.(agentFileTransactionProvider)
			if !ok {
				return taskForbidden()
			}
			// Use the same root-before-domain ordering as message/card writes.
			if err := store.ConsumeAgentTaskBudget(fileCtx, task.RootTaskID, 0, 0, 0, s.nowUTC()); err != nil {
				return err
			}
			if err := apply(provider.FileTransaction()); err != nil {
				return err
			}
			if err := s.validateAgentTask(fileCtx, tx, store, current, task, ""); err != nil {
				return err
			}
			// Locking the root also orders cancellation against final commit.
			if err := store.ConsumeAgentTaskBudget(fileCtx, task.RootTaskID, 0, 0, 0, s.nowUTC()); err != nil {
				return err
			}
			return s.validateIdempotentOperationInTx(fileCtx, tx, current, "file.complete", true)
		})
	}
}
