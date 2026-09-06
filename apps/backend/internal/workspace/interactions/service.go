package interactions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
)

type Clock func() time.Time
type IDFactory func() (string, error)

type RateLimits struct {
	Command          int
	WorkflowStart    int
	WorkflowContinue int
	WorkflowCancel   int
}

type ServiceOptions struct {
	Repository       Repository
	CommandRegistry  *CommandRegistry
	WorkflowRegistry *WorkflowRegistry
	SpaceID          string
	Now              Clock
	IDFactory        IDFactory
	RateLimits       RateLimits
}

type Service struct {
	repo      Repository
	commands  *CommandRegistry
	workflows *WorkflowRegistry
	spaceID   string
	now       Clock
	idFactory IDFactory
	limits    RateLimits
}

func NewService(options ServiceOptions) *Service {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	spaceID := strings.TrimSpace(options.SpaceID)
	if spaceID == "" {
		spaceID = DefaultSpaceID
	}
	factory := options.IDFactory
	if factory == nil {
		factory = func() (string, error) {
			id, err := uuid.NewRandom()
			if err != nil {
				return "", err
			}
			return id.String(), nil
		}
	}
	limits := options.RateLimits
	if limits.Command == 0 {
		limits.Command = 60
	}
	if limits.WorkflowStart == 0 {
		limits.WorkflowStart = 20
	}
	if limits.WorkflowContinue == 0 {
		limits.WorkflowContinue = 120
	}
	if limits.WorkflowCancel == 0 {
		limits.WorkflowCancel = 30
	}
	return &Service{repo: options.Repository, commands: options.CommandRegistry, workflows: options.WorkflowRegistry, spaceID: spaceID, now: now, idFactory: factory, limits: limits}
}

func (s *Service) ExecuteCommand(ctx context.Context, input ExecuteCommandInput) (CommandOutcome, error) {
	spaceID, err := normalizeID(input.SpaceID, CodeSpaceInvalid, "空间 ID 无效")
	if err != nil {
		return CommandOutcome{}, err
	}
	conversationID, err := normalizeID(input.ConversationID, CodeConversationInvalid, "会话 ID 无效")
	if err != nil {
		return CommandOutcome{}, err
	}
	botID, err := normalizeID(input.BotUserID, "bot.invalid_id", "Bot ID 无效")
	if err != nil {
		return CommandOutcome{}, err
	}
	invocationID, err := normalizeID(input.ClientInvocationID, CodeCommandInvalidInvocation, "客户端调用 ID 无效")
	if err != nil {
		return CommandOutcome{}, err
	}
	actor, err := s.requireActor(ctx, s.repo, spaceID, input.ActorID)
	if err != nil {
		return CommandOutcome{}, err
	}
	conversation, err := s.requireCommandContext(ctx, s.repo, actor.ID, botID, conversationID, spaceID)
	if err != nil {
		s.auditRejected(ctx, actor, spaceID, "command.context", "workspace.conversation", conversationID, input.Request, err)
		return CommandOutcome{}, err
	}
	if s.commands == nil {
		return CommandOutcome{}, internalError("execute workspace command", errors.New("command registry is required"))
	}
	recognized, recognizeErr := s.commands.Recognize(input.Source, RecognitionContext{ConversationType: conversation.Type, BotUserID: botID, MentionedBotIDs: input.MentionedBotIDs})
	if recognizeErr != nil {
		return CommandOutcome{}, toError(recognizeErr, CodeCommandFailed, "命令执行失败")
	}
	if recognized == nil {
		return CommandOutcome{}, NewError(CodeCommandNotTriggered, MessageCommandNotTriggered, 422)
	}
	if recognized.Type == "unknown_command" {
		return CommandOutcome{}, NewError(CodeCommandUnknown, MessageCommandUnknown, 404)
	}
	definition := recognized.Definition
	hash := hashRequest(map[string]any{"spaceId": spaceID, "conversationId": conversationID, "botUserId": botID, "command": definition.Name, "version": definition.Version, "arguments": recognized.Arguments})
	runID, idErr := s.newID("command run")
	if idErr != nil {
		return CommandOutcome{}, internalError("generate workspace command run id", idErr)
	}
	var outcome CommandOutcome
	var operationErr error
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		transactionErr := func() error {
			if err := tx.Lock(ctx, "workspace:command:"+spaceID+":"+actor.ID+":"+invocationID); err != nil {
				return err
			}
			currentActor, err := s.requireActor(ctx, tx, spaceID, actor.ID)
			if err != nil {
				return err
			}
			currentConversation, err := s.requireCommandContext(ctx, tx, currentActor.ID, botID, conversationID, spaceID)
			if err != nil {
				operationErr = err
				return s.auditExpected(ctx, tx, currentActor, spaceID, "command.context", "workspace.conversation", conversationID, input.Request, operationErr)
			}
			actor = currentActor
			conversation = currentConversation
			existing, err := tx.GetCommandRun(ctx, spaceID, actor.ID, invocationID)
			if err != nil {
				return err
			}
			if existing != nil {
				if existing.RequestHash != hash {
					operationErr = conflict(CodeCommandIdempotencyConflict, "调用标识已用于其他命令")
					return s.auditExpected(ctx, tx, actor, spaceID, "command."+definition.Name, "workspace.command", existing.ID, input.Request, operationErr)
				}
				if existing.Status == "succeeded" {
					result, _ := decodeJSON(existing.ResultJSON)
					outcome = CommandOutcome{OK: true, Replayed: true, Result: result, ResultCardID: existing.ResultCardID}
					return nil
				}
				if existing.Status == "failed" {
					code := existing.ErrorCode
					if code == "" {
						code = CodeCommandFailed
					}
					operationErr = conflict(code, "命令执行失败")
					return s.auditExpected(ctx, tx, actor, spaceID, "command."+definition.Name, "workspace.command", existing.ID, input.Request, operationErr)
				}
				operationErr = conflict(CodeCommandInProgress, "命令正在执行")
				return s.auditExpected(ctx, tx, actor, spaceID, "command."+definition.Name, "workspace.command", existing.ID, input.Request, operationErr)
			}
			now := s.nowUTC()
			allowed, retry, err := s.consumeRateLimit(ctx, tx, RateLimitInput{SpaceID: spaceID, ActorUserID: actor.ID, BotUserID: botID, OperationKey: "command:" + definition.Name, Limit: s.limits.Command, UpdatedAt: now})
			if err != nil {
				return err
			}
			if !allowed {
				operationErr = NewError(CodeInteractionRateLimited, MessageRateLimited, 429)
				operationErr.(*Error).Details = map[string]any{"retryAfterSeconds": int(retry.Seconds())}
				return s.auditExpected(ctx, tx, actor, spaceID, "command."+definition.Name, "workspace.command", runID, input.Request, operationErr)
			}
			run, inserted, err := tx.InsertCommandRun(ctx, CommandRunRecord{ID: runID, SpaceID: spaceID, ConversationID: stringPointer(conversationID), ActorUserID: actor.ID, BotUserID: stringPointer(botID), CommandName: definition.Name, CommandVersion: definition.Version, ClientInvocationID: invocationID, RequestHash: hash, ArgumentsJSON: mustJSON(recognized.Arguments), Status: "pending", CreatedAt: now})
			if err != nil {
				return err
			}
			if !inserted {
				run, err = tx.GetCommandRun(ctx, spaceID, actor.ID, invocationID)
				if err != nil {
					return err
				}
				if run == nil {
					return errors.New("command invocation disappeared")
				}
				if run.RequestHash != hash {
					operationErr = conflict(CodeCommandIdempotencyConflict, "调用标识已用于其他命令")
					return s.auditExpected(ctx, tx, actor, spaceID, "command."+definition.Name, "workspace.command", run.ID, input.Request, operationErr)
				}
				if run.Status == "succeeded" {
					result, _ := decodeJSON(run.ResultJSON)
					outcome = CommandOutcome{OK: true, Replayed: true, Result: result, ResultCardID: run.ResultCardID}
					return nil
				}
				operationErr = conflict(CodeCommandInProgress, "命令正在执行")
				return s.auditExpected(ctx, tx, actor, spaceID, "command."+definition.Name, "workspace.command", run.ID, input.Request, operationErr)
			}
			if definition.Authorize != nil {
				permitted, authErr := definition.Authorize(ctx, CommandAuthorization{Actor: actor, Context: conversation, BotUserID: botID, Arguments: recognized.Arguments})
				if authErr != nil {
					return s.failCommand(ctx, tx, run.ID, actor, spaceID, definition.Name, input.Request, authErr)
				}
				if !permitted {
					return s.failCommand(ctx, tx, run.ID, actor, spaceID, definition.Name, input.Request, permissionDeniedError())
				}
			}
			executed, executeErr := definition.Execute(ctx, CommandExecution{Tx: tx, Actor: actor, Context: conversation, BotUserID: botID, Arguments: recognized.Arguments, Request: input.Request, ClientInvocationID: invocationID})
			if executeErr != nil {
				return s.failCommand(ctx, tx, run.ID, actor, spaceID, definition.Name, input.Request, executeErr)
			}
			result := executed.Result
			if result == nil {
				result = map[string]any{}
			}
			safeResult, normalizeErr := cards.NormalizeCardPayload(result, cards.Limits{MaxPayloadBytes: 32 * 1024, MaxDepth: 8, MaxNodes: 200, MaxTextBytes: 16 * 1024}, false)
			if normalizeErr != nil {
				// The executor has already mutated its domains. Invalid generated
				// output is a server failure, not a commit-safe input rejection.
				return wrapInfrastructureFailure(normalizeErr, "validate command result")
			}
			resultCardID := (*string)(nil)
			if strings.TrimSpace(executed.ResultCardID) != "" {
				normalized, idErr := normalizeID(executed.ResultCardID, "command.invalid_result_card", "命令结果卡片无效")
				if idErr != nil {
					return wrapInfrastructureFailure(idErr, "validate command result card")
				}
				resultCardID = &normalized
			}
			if err := tx.CompleteCommandRun(ctx, run.ID, resultCardID, mustJSON(safeResult), s.nowUTC()); err != nil {
				return err
			}
			if err := s.writeAudit(ctx, tx, actor, input.Request, AuditInput{SpaceID: spaceID, Action: "command." + definition.Name, TargetType: "workspace.command", TargetID: run.ID, Result: "success", CreatedAt: s.nowUTC()}); err != nil {
				return err
			}
			if err := s.writeEvent(ctx, tx, EventInput{SpaceID: spaceID, Type: "command.invoked", ActorID: actor.ID, ConversationID: conversationID, TargetType: "workspace.command", TargetID: run.ID, PayloadJSON: mustJSON(map[string]any{"command": definition.Name, "version": definition.Version, "resultCardId": stringValue(resultCardID)}), CreatedAt: s.nowUTC()}); err != nil {
				return err
			}
			outcome = CommandOutcome{OK: true, Result: safeResult, ResultCardID: resultCardID}
			return nil
		}()
		var rejected interactionRejection
		if transactionErr != nil && errors.As(transactionErr, &rejected) {
			operationErr = rejected.err
			return nil
		}
		return transactionErr
	})
	if err != nil {
		return CommandOutcome{}, normalizeError(err)
	}
	if operationErr != nil {
		return CommandOutcome{}, operationErr
	}
	return outcome, nil
}

func (s *Service) StartWorkflow(ctx context.Context, input StartWorkflowInput) (Workflow, error) {
	spaceID, err := normalizeID(input.SpaceID, CodeSpaceInvalid, "空间 ID 无效")
	if err != nil {
		return Workflow{}, err
	}
	conversationID, err := normalizeID(input.ConversationID, CodeConversationInvalid, "会话 ID 无效")
	if err != nil {
		return Workflow{}, err
	}
	botID, err := normalizeID(input.BotUserID, "bot.invalid_id", "Bot ID 无效")
	if err != nil {
		return Workflow{}, err
	}
	invocationID, err := normalizeID(input.ClientInvocationID, CodeWorkflowInvalidInvocation, "客户端调用 ID 无效")
	if err != nil {
		return Workflow{}, err
	}
	actor, err := s.requireActor(ctx, s.repo, spaceID, input.ActorID)
	if err != nil {
		return Workflow{}, err
	}
	conversation, err := s.requireCommandContext(ctx, s.repo, actor.ID, botID, conversationID, spaceID)
	if err != nil {
		s.auditRejected(ctx, actor, spaceID, "workflow.start", "workspace.conversation", conversationID, input.Request, err)
		return Workflow{}, err
	}
	typeName, err := normalizeWorkflowTypeInput(input.Type)
	if err != nil {
		return Workflow{}, err
	}
	version := input.Version
	if version == 0 {
		version = 1
	}
	definition := s.workflows.Get(typeName, version)
	if definition == nil {
		return Workflow{}, NewError(CodeWorkflowUnknown, MessageWorkflowUnknown, 404)
	}
	ttl := input.TTL
	if ttl == 0 {
		ttl = DefaultWorkflowTTL
	}
	if ttl < time.Minute || ttl > MaxWorkflowTTL {
		return Workflow{}, NewError(CodeWorkflowInvalidTTL, "引导流程有效期无效", 400)
	}
	workflowInput := input.Input
	if workflowInput == nil {
		workflowInput = map[string]any{}
	}
	hash := hashRequest(map[string]any{"spaceId": spaceID, "conversationId": conversationID, "botUserId": botID, "type": typeName, "version": version, "input": workflowInput, "ttlMs": ttl.Milliseconds()})
	workflowID, idErr := s.newID("workflow")
	if idErr != nil {
		return Workflow{}, internalError("generate workspace workflow id", idErr)
	}
	var result Workflow
	var operationErr error
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		transactionErr := func() error {
			if err := tx.Lock(ctx, "workspace:workflow:invocation:"+spaceID+":"+actor.ID+":"+invocationID); err != nil {
				return err
			}
			if err := tx.Lock(ctx, "workspace:workflow:lane:"+spaceID+":"+actor.ID+":"+conversationID+":"+botID); err != nil {
				return err
			}
			currentActor, err := s.requireActor(ctx, tx, spaceID, actor.ID)
			if err != nil {
				return err
			}
			currentConversation, err := s.requireCommandContext(ctx, tx, currentActor.ID, botID, conversationID, spaceID)
			if err != nil {
				operationErr = err
				return s.auditExpected(ctx, tx, currentActor, spaceID, "workflow.start", "workspace.conversation", conversationID, input.Request, operationErr)
			}
			actor = currentActor
			conversation = currentConversation
			now := s.nowUTC()
			if err := tx.ExpireWorkflows(ctx, actor.ID, conversationID, botID, now); err != nil {
				return err
			}
			existing, err := tx.GetWorkflowByInvocation(ctx, spaceID, actor.ID, invocationID)
			if err != nil {
				return err
			}
			if existing != nil {
				if stringValue(existing.StartRequestHash) != hash {
					operationErr = conflict(CodeWorkflowIdempotencyConflict, "调用标识已用于其他引导流程")
					return s.auditExpected(ctx, tx, actor, spaceID, "workflow.start", "workspace.workflow", existing.ID, input.Request, operationErr)
				}
				existingState, _ := decodeJSON(existing.StateJSON)
				projected, projectErr := s.projectWorkflow(ctx, definition, existing, actor, existingState)
				if projectErr != nil {
					return projectErr
				}
				if err := s.writeAudit(ctx, tx, actor, input.Request, AuditInput{SpaceID: spaceID, Action: "workflow.start", TargetType: "workspace.workflow", TargetID: existing.ID, Result: "success", Reason: "replayed", CreatedAt: s.nowUTC()}); err != nil {
					return err
				}
				result = projected
				return nil
			}
			active, err := tx.ListActiveWorkflows(ctx, actor.ID, conversationID, botID, 1)
			if err != nil {
				return err
			}
			if len(active) > 0 {
				operationErr = &Error{Code: CodeWorkflowActiveConflict, Message: "当前 Bot 会话已有进行中的引导流程", StatusCode: 409, Details: map[string]any{"activeWorkflowId": active[0].ID}}
				return s.auditExpected(ctx, tx, actor, spaceID, "workflow.start", "workspace.workflow", active[0].ID, input.Request, operationErr)
			}
			allowed, retry, err := s.consumeRateLimit(ctx, tx, RateLimitInput{SpaceID: spaceID, ActorUserID: actor.ID, BotUserID: botID, OperationKey: "workflow.start:" + typeName, Limit: s.limits.WorkflowStart, UpdatedAt: now})
			if err != nil {
				return err
			}
			if !allowed {
				operationErr = &Error{Code: CodeInteractionRateLimited, Message: MessageRateLimited, StatusCode: 429, Details: map[string]any{"retryAfterSeconds": int(retry.Seconds())}}
				return s.auditExpected(ctx, tx, actor, spaceID, "workflow.start", "workspace.workflow", workflowID, input.Request, operationErr)
			}
			if definition.Authorize != nil {
				permitted, authErr := definition.Authorize(ctx, WorkflowAuthorization{Actor: actor, Context: conversation, Operation: "start", Input: workflowInput})
				if authErr != nil {
					return s.auditWorkflowFailure(ctx, tx, actor, spaceID, workflowID, input.Request, authErr)
				}
				if !permitted {
					return s.auditWorkflowFailure(ctx, tx, actor, spaceID, workflowID, input.Request, permissionDeniedError())
				}
			}
			initialized, initErr := definition.Initialize(ctx, WorkflowExecution{Tx: tx, Actor: actor, Context: conversation, Input: workflowInput, BotUserID: botID, Request: input.Request})
			if initErr != nil {
				return s.auditWorkflowFailure(ctx, tx, actor, spaceID, workflowID, input.Request, initErr)
			}
			state, stateErr := s.validateState(definition, initialized.State)
			if stateErr != nil {
				return wrapInfrastructureFailure(stateErr, "validate initialized workflow state")
			}
			status, statusErr := normalizeWorkflowStatus(initialized.Status)
			if statusErr != nil {
				return wrapInfrastructureFailure(statusErr, "validate initialized workflow status")
			}
			record := WorkflowRecord{ID: workflowID, SpaceID: spaceID, ConversationID: stringPointer(conversationID), ActorUserID: actor.ID, BotUserID: stringPointer(botID), WorkflowType: typeName, WorkflowVersion: version, StateJSON: mustJSON(state), Status: status, Revision: 1, ExpiresAt: now.Add(ttl), CreatedAt: now, UpdatedAt: now, ClientInvocationID: stringPointer(invocationID), StartRequestHash: stringPointer(hash)}
			stored, inserted, err := tx.InsertWorkflow(ctx, record)
			if err != nil {
				return err
			}
			if !inserted || stored == nil {
				existing, readErr := tx.GetWorkflowByInvocation(ctx, spaceID, actor.ID, invocationID)
				if readErr != nil {
					return readErr
				}
				if existing != nil && stringValue(existing.StartRequestHash) == hash {
					existingState, _ := decodeJSON(existing.StateJSON)
					result, err = s.projectWorkflow(ctx, definition, existing, actor, existingState)
					return err
				}
				operationErr = conflict(CodeWorkflowActiveConflict, "当前 Bot 会话已有进行中的引导流程")
				return s.auditExpected(ctx, tx, actor, spaceID, "workflow.start", "workspace.workflow", workflowID, input.Request, operationErr)
			}
			if err := s.writeAudit(ctx, tx, actor, input.Request, AuditInput{SpaceID: spaceID, Action: "workflow.start", TargetType: "workspace.workflow", TargetID: workflowID, Result: "success", CreatedAt: s.nowUTC()}); err != nil {
				return err
			}
			if err := s.writeEvent(ctx, tx, EventInput{SpaceID: spaceID, Type: "workflow.started", ActorID: actor.ID, ConversationID: conversationID, TargetType: "workspace.workflow", TargetID: workflowID, PayloadJSON: mustJSON(map[string]any{"workflowType": typeName, "version": version, "revision": 1, "status": record.Status}), CreatedAt: s.nowUTC()}); err != nil {
				return err
			}
			result, err = s.projectWorkflow(ctx, definition, stored, actor, state)
			return err
		}()
		var rejected interactionRejection
		if transactionErr != nil && errors.As(transactionErr, &rejected) {
			operationErr = rejected.err
			return nil
		}
		return transactionErr
	})
	if err != nil {
		return Workflow{}, normalizeError(err)
	}
	if operationErr != nil {
		return Workflow{}, operationErr
	}
	return result, nil
}

func (s *Service) GetWorkflow(ctx context.Context, actorID, workflowID string) (Workflow, error) {
	id, err := normalizeID(workflowID, CodeWorkflowInvalidID, "引导流程 ID 无效")
	if err != nil {
		return Workflow{}, err
	}
	row, err := s.repo.GetWorkflow(ctx, s.spaceID, id)
	if err != nil {
		return Workflow{}, normalizeError(err)
	}
	if row == nil {
		return Workflow{}, workflowNotFoundError()
	}
	actor, err := s.requireActor(ctx, s.repo, row.SpaceID, actorID)
	if err != nil {
		return Workflow{}, err
	}
	if row.ActorUserID != actor.ID {
		return Workflow{}, workflowNotFoundError()
	}
	if _, err := s.requireCommandContext(ctx, s.repo, actor.ID, stringValue(row.BotUserID), stringValue(row.ConversationID), row.SpaceID); err != nil {
		return Workflow{}, err
	}
	definition := s.workflows.Get(row.WorkflowType, row.WorkflowVersion)
	if definition == nil {
		return Workflow{}, NewError("workflow.unknown_version", MessageWorkflowUnknownVersion, 422)
	}
	state, err := decodeJSON(row.StateJSON)
	if err != nil {
		return Workflow{}, internalError("decode workspace workflow state", err)
	}
	return s.projectWorkflow(ctx, definition, row, actor, state)
}

func (s *Service) ContinueWorkflow(ctx context.Context, actorID string, input ContinueWorkflowInput) (WorkflowOutcome, error) {
	id, err := normalizeID(input.WorkflowID, CodeWorkflowInvalidID, "引导流程 ID 无效")
	if err != nil {
		return WorkflowOutcome{}, err
	}
	if input.ExpectedRevision < 1 {
		return WorkflowOutcome{}, NewError(CodeWorkflowInvalidRevision, "引导流程版本无效", 400)
	}
	var result WorkflowOutcome
	var operationErr error
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		if err := tx.Lock(ctx, "workspace:workflow:"+id); err != nil {
			return err
		}
		row, err := tx.GetWorkflow(ctx, s.spaceID, id)
		if err != nil {
			return err
		}
		if row == nil {
			operationErr = workflowNotFoundError()
			return nil
		}
		actor, err := s.requireActor(ctx, tx, row.SpaceID, actorID)
		if err != nil {
			if shouldRollback(err) {
				return wrapInfrastructureFailure(err, "continue workspace workflow")
			}
			operationErr = err
			return nil
		}
		if row.ActorUserID != actor.ID {
			operationErr = workflowNotFoundError()
			return nil
		}
		definition := s.workflows.Get(row.WorkflowType, row.WorkflowVersion)
		if definition == nil {
			operationErr = NewError("workflow.unknown_version", MessageWorkflowUnknownVersion, 422)
			return nil
		}
		if row.Status != "active" {
			operationErr = conflict(CodeWorkflowNotActive, MessageWorkflowNotActive)
			return s.auditExpected(ctx, tx, actor, row.SpaceID, "workflow.continue", "workspace.workflow", row.ID, input.Request, operationErr)
		}
		now := s.nowUTC()
		if !row.ExpiresAt.After(now) {
			if err := tx.ExpireWorkflows(ctx, row.ActorUserID, stringValue(row.ConversationID), stringValue(row.BotUserID), now); err != nil {
				return err
			}
			operationErr = NewError(CodeWorkflowExpired, MessageWorkflowExpired, 409)
			if err := s.writeEvent(ctx, tx, EventInput{SpaceID: row.SpaceID, Type: "workflow.expired", ActorID: actor.ID, ConversationID: stringValue(row.ConversationID), TargetType: "workspace.workflow", TargetID: row.ID, PayloadJSON: mustJSON(map[string]any{"revision": row.Revision + 1, "status": "expired"}), CreatedAt: now}); err != nil {
				return err
			}
			return s.auditExpected(ctx, tx, actor, row.SpaceID, "workflow.continue", "workspace.workflow", row.ID, input.Request, operationErr)
		}
		if row.Revision != input.ExpectedRevision {
			operationErr = conflict(CodeWorkflowStaleRevision, "引导流程状态已变化")
			return s.auditExpected(ctx, tx, actor, row.SpaceID, "workflow.continue", "workspace.workflow", row.ID, input.Request, operationErr)
		}
		conversation, err := s.requireCommandContext(ctx, tx, actor.ID, stringValue(row.BotUserID), stringValue(row.ConversationID), row.SpaceID)
		if err != nil {
			operationErr = err
			return s.auditExpected(ctx, tx, actor, row.SpaceID, "workflow.continue", "workspace.workflow", row.ID, input.Request, operationErr)
		}
		allowed, retry, err := s.consumeRateLimit(ctx, tx, RateLimitInput{SpaceID: row.SpaceID, ActorUserID: actor.ID, BotUserID: stringValue(row.BotUserID), OperationKey: "workflow.continue:" + row.WorkflowType, Limit: s.limits.WorkflowContinue, UpdatedAt: now})
		if err != nil {
			return err
		}
		if !allowed {
			operationErr = &Error{Code: CodeInteractionRateLimited, Message: MessageRateLimited, StatusCode: 429, Details: map[string]any{"retryAfterSeconds": int(retry.Seconds())}}
			return s.auditExpected(ctx, tx, actor, row.SpaceID, "workflow.continue", "workspace.workflow", row.ID, input.Request, operationErr)
		}
		state, err := decodeJSON(row.StateJSON)
		if err != nil {
			return err
		}
		workflowInput := input.Input
		if workflowInput == nil {
			workflowInput = map[string]any{}
		}
		public := publicWorkflow(row, state)
		if definition.Authorize != nil {
			permitted, authErr := definition.Authorize(ctx, WorkflowAuthorization{Actor: actor, Context: conversation, Operation: "continue", Workflow: public, Input: workflowInput})
			if authErr != nil {
				if shouldRollback(authErr) {
					return wrapInfrastructureFailure(authErr, "authorize workspace workflow continuation")
				}
				operationErr = toError(authErr, CodeWorkflowFailed, "引导流程处理失败")
				return s.auditExpected(ctx, tx, actor, row.SpaceID, "workflow.continue", "workspace.workflow", row.ID, input.Request, operationErr)
			}
			if !permitted {
				operationErr = workflowNotFoundError()
				return s.auditExpected(ctx, tx, actor, row.SpaceID, "workflow.continue", "workspace.workflow", row.ID, input.Request, operationErr)
			}
		}
		continued, continueErr := definition.Continue(ctx, WorkflowExecution{Tx: tx, Actor: actor, Context: conversation, Workflow: public, State: state, Input: workflowInput, BotUserID: stringValue(row.BotUserID), Request: input.Request})
		if continueErr != nil {
			if shouldRollback(continueErr) {
				return wrapInfrastructureFailure(continueErr, "continue workspace workflow")
			}
			operationErr = toError(continueErr, CodeWorkflowFailed, "引导流程处理失败")
			return s.auditExpected(ctx, tx, actor, row.SpaceID, "workflow.continue", "workspace.workflow", row.ID, input.Request, operationErr)
		}
		nextState, stateErr := s.validateState(definition, continued.State)
		if stateErr != nil {
			return wrapInfrastructureFailure(stateErr, "validate workspace workflow state")
		}
		status, statusErr := normalizeWorkflowStatus(continued.Status)
		if statusErr != nil {
			return wrapInfrastructureFailure(statusErr, "normalize workspace workflow status")
		}
		safeResult, resultErr := normalizeInteractionResult(continued.Result)
		if resultErr != nil {
			return wrapInfrastructureFailure(resultErr, "normalize workspace workflow result")
		}
		updated, changed, err := tx.UpdateWorkflow(ctx, row.ID, row.Revision, nextState, status, s.nowUTC())
		if err != nil {
			return err
		}
		if !changed || updated == nil {
			operationErr = conflict(CodeWorkflowRaceConflict, "引导流程已被其他请求更新")
			return s.auditExpected(ctx, tx, actor, row.SpaceID, "workflow.continue", "workspace.workflow", row.ID, input.Request, operationErr)
		}
		if err := s.writeAudit(ctx, tx, actor, input.Request, AuditInput{SpaceID: row.SpaceID, Action: "workflow.continue", TargetType: "workspace.workflow", TargetID: row.ID, Result: "success", CreatedAt: s.nowUTC()}); err != nil {
			return err
		}
		if err := s.writeEvent(ctx, tx, EventInput{SpaceID: row.SpaceID, Type: "workflow.continued", ActorID: actor.ID, ConversationID: stringValue(row.ConversationID), TargetType: "workspace.workflow", TargetID: row.ID, PayloadJSON: mustJSON(map[string]any{"revision": updated.Revision, "status": updated.Status}), CreatedAt: s.nowUTC()}); err != nil {
			return err
		}
		projected, err := s.projectWorkflow(ctx, definition, updated, actor, nextState)
		if err != nil {
			return err
		}
		result = WorkflowOutcome{Workflow: projected, Result: safeResult}
		return nil
	})
	if err != nil {
		return WorkflowOutcome{}, normalizeError(err)
	}
	if operationErr != nil {
		return WorkflowOutcome{}, operationErr
	}
	return result, nil
}

func (s *Service) CancelWorkflow(ctx context.Context, actorID string, input CancelWorkflowInput) (Workflow, error) {
	var row *WorkflowRecord
	var err error
	if strings.TrimSpace(input.WorkflowID) != "" {
		id, idErr := normalizeID(input.WorkflowID, CodeWorkflowInvalidID, "引导流程 ID 无效")
		if idErr != nil {
			return Workflow{}, idErr
		}
		row, err = s.repo.GetWorkflow(ctx, s.spaceID, id)
		if err != nil {
			return Workflow{}, normalizeError(err)
		}
		if row == nil {
			return Workflow{}, workflowNotFoundError()
		}
		actor, actorErr := s.requireActor(ctx, s.repo, row.SpaceID, actorID)
		if actorErr != nil {
			return Workflow{}, actorErr
		}
		if row.ActorUserID != actor.ID {
			return Workflow{}, workflowNotFoundError()
		}
	} else {
		spaceID, idErr := normalizeID(input.SpaceID, CodeSpaceInvalid, "空间 ID 无效")
		if idErr != nil {
			return Workflow{}, idErr
		}
		conversationID, idErr := normalizeID(input.ConversationID, CodeConversationInvalid, "会话 ID 无效")
		if idErr != nil {
			return Workflow{}, idErr
		}
		botID, idErr := normalizeID(input.BotUserID, "bot.invalid_id", "Bot ID 无效")
		if idErr != nil {
			return Workflow{}, idErr
		}
		actor, actorErr := s.requireActor(ctx, s.repo, spaceID, actorID)
		if actorErr != nil {
			return Workflow{}, actorErr
		}
		if _, actorErr = s.requireCommandContext(ctx, s.repo, actor.ID, botID, conversationID, spaceID); actorErr != nil {
			s.auditRejected(ctx, actor, spaceID, "workflow.cancel", "workspace.conversation", conversationID, input.Request, actorErr)
			return Workflow{}, actorErr
		}
		if expireErr := s.repo.WithTx(ctx, func(tx Tx) error { return tx.ExpireWorkflows(ctx, actor.ID, conversationID, botID, s.nowUTC()) }); expireErr != nil {
			return Workflow{}, normalizeError(expireErr)
		}
		active, listErr := s.repo.ListActiveWorkflows(ctx, actor.ID, conversationID, botID, 2)
		if listErr != nil {
			return Workflow{}, normalizeError(listErr)
		}
		if len(active) == 0 {
			value := NewError(CodeWorkflowActiveNotFound, "当前 Bot 会话没有进行中的引导流程", 404)
			s.auditRejected(ctx, actor, spaceID, "workflow.cancel", "workspace.conversation", conversationID, input.Request, value)
			return Workflow{}, value
		}
		if len(active) > 1 {
			value := &Error{Code: CodeWorkflowActiveAmbiguous, Message: "当前 Bot 会话存在多个进行中的引导流程", StatusCode: 409}
			s.auditRejected(ctx, actor, spaceID, "workflow.cancel", "workspace.conversation", conversationID, input.Request, value)
			return Workflow{}, value
		}
		copy := active[0]
		row = &copy
	}
	var result Workflow
	var operationErr error
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		if err := tx.Lock(ctx, "workspace:workflow:"+row.ID); err != nil {
			return err
		}
		current, err := tx.GetWorkflow(ctx, row.SpaceID, row.ID)
		if err != nil {
			return err
		}
		if current == nil {
			operationErr = workflowNotFoundError()
			return nil
		}
		actor, err := s.requireActor(ctx, tx, current.SpaceID, actorID)
		if err != nil {
			if shouldRollback(err) {
				return wrapInfrastructureFailure(err, "cancel workspace workflow")
			}
			operationErr = err
			return nil
		}
		if current.ActorUserID != actor.ID {
			operationErr = workflowNotFoundError()
			return nil
		}
		if current.Status != "active" {
			operationErr = conflict(CodeWorkflowNotActive, MessageWorkflowNotActive)
			return s.auditExpected(ctx, tx, actor, current.SpaceID, "workflow.cancel", "workspace.workflow", current.ID, input.Request, operationErr)
		}
		if _, err := s.requireCommandContext(ctx, tx, actor.ID, stringValue(current.BotUserID), stringValue(current.ConversationID), current.SpaceID); err != nil {
			operationErr = err
			return s.auditExpected(ctx, tx, actor, current.SpaceID, "workflow.cancel", "workspace.workflow", current.ID, input.Request, operationErr)
		}
		now := s.nowUTC()
		allowed, retry, err := s.consumeRateLimit(ctx, tx, RateLimitInput{SpaceID: current.SpaceID, ActorUserID: actor.ID, BotUserID: stringValue(current.BotUserID), OperationKey: "workflow.cancel:" + current.WorkflowType, Limit: s.limits.WorkflowCancel, UpdatedAt: now})
		if err != nil {
			return err
		}
		if !allowed {
			operationErr = &Error{Code: CodeInteractionRateLimited, Message: MessageRateLimited, StatusCode: 429, Details: map[string]any{"retryAfterSeconds": int(retry.Seconds())}}
			return s.auditExpected(ctx, tx, actor, current.SpaceID, "workflow.cancel", "workspace.workflow", current.ID, input.Request, operationErr)
		}
		state, err := decodeJSON(current.StateJSON)
		if err != nil {
			return err
		}
		updated, changed, err := tx.UpdateWorkflow(ctx, current.ID, current.Revision, state, "cancelled", now)
		if err != nil {
			return err
		}
		if !changed || updated == nil {
			operationErr = conflict(CodeWorkflowRaceConflict, "引导流程已被其他请求更新")
			return s.auditExpected(ctx, tx, actor, current.SpaceID, "workflow.cancel", "workspace.workflow", current.ID, input.Request, operationErr)
		}
		definition := s.workflows.Get(updated.WorkflowType, updated.WorkflowVersion)
		if definition == nil {
			operationErr = NewError("workflow.unknown_version", MessageWorkflowUnknownVersion, 422)
			return s.auditExpected(ctx, tx, actor, current.SpaceID, "workflow.cancel", "workspace.workflow", current.ID, input.Request, operationErr)
		}
		if err := s.writeAudit(ctx, tx, actor, input.Request, AuditInput{SpaceID: current.SpaceID, Action: "workflow.cancel", TargetType: "workspace.workflow", TargetID: current.ID, Result: "success", CreatedAt: s.nowUTC()}); err != nil {
			return err
		}
		if err := s.writeEvent(ctx, tx, EventInput{SpaceID: current.SpaceID, Type: "workflow.cancelled", ActorID: actor.ID, ConversationID: stringValue(current.ConversationID), TargetType: "workspace.workflow", TargetID: current.ID, PayloadJSON: mustJSON(map[string]any{"revision": updated.Revision, "status": updated.Status}), CreatedAt: s.nowUTC()}); err != nil {
			return err
		}
		result, err = s.projectWorkflow(ctx, definition, updated, actor, state)
		return err
	})
	if err != nil {
		return Workflow{}, normalizeError(err)
	}
	if operationErr != nil {
		return Workflow{}, operationErr
	}
	return result, nil
}

// CancelWorkflowInTx applies workflow cancellation to a caller-owned
// transaction. Every authorization and workflow read is performed through
// tx, so a member removal or bot removal that is uncommitted on the caller's
// connection cannot be bypassed by a pool read. Expected rejections write a
// content-free audit in tx and return TransactionRejection; infrastructure
// errors are returned unchanged and must roll the outer transaction back.
func (s *Service) CancelWorkflowInTx(ctx context.Context, tx Tx, actorID string, input CancelWorkflowInput) (Workflow, error) {
	if s == nil || s.repo == nil {
		return Workflow{}, internalError("cancel workspace workflow", errors.New("repository is required"))
	}
	if tx == nil {
		return Workflow{}, internalError("cancel workspace workflow", errors.New("transaction is required"))
	}
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return Workflow{}, authRequiredError()
	}
	spaceValue := strings.TrimSpace(input.SpaceID)
	if spaceValue == "" {
		spaceValue = s.spaceID
	}
	spaceID, err := normalizeID(spaceValue, CodeSpaceInvalid, "空间 ID 无效")
	if err != nil {
		return Workflow{}, err
	}
	actor, err := s.requireActor(ctx, tx, spaceID, actorID)
	if err != nil {
		return Workflow{}, err
	}

	var candidate *WorkflowRecord
	workflowID := strings.TrimSpace(input.WorkflowID)
	if workflowID != "" {
		id, idErr := normalizeID(workflowID, CodeWorkflowInvalidID, "引导流程 ID 无效")
		if idErr != nil {
			return Workflow{}, idErr
		}
		if err := tx.Lock(ctx, "workspace:workflow:"+id); err != nil {
			return Workflow{}, err
		}
		candidate, err = tx.GetWorkflow(ctx, spaceID, id)
		if err != nil {
			return Workflow{}, err
		}
		if candidate == nil || candidate.ActorUserID != actor.ID {
			return Workflow{}, s.cancelWorkflowRejection(ctx, tx, actor, spaceID, "workspace.workflow", id, input.Request, workflowNotFoundError())
		}
	} else {
		conversationID, conversationErr := normalizeID(input.ConversationID, CodeConversationInvalid, "会话 ID 无效")
		if conversationErr != nil {
			return Workflow{}, conversationErr
		}
		botID, botErr := normalizeID(input.BotUserID, "bot.invalid_id", "Bot ID 无效")
		if botErr != nil {
			return Workflow{}, botErr
		}
		if _, contextErr := s.requireCommandContext(ctx, tx, actor.ID, botID, conversationID, spaceID); contextErr != nil {
			return Workflow{}, s.cancelWorkflowRejection(ctx, tx, actor, spaceID, "workspace.conversation", conversationID, input.Request, contextErr)
		}
		if err := tx.ExpireWorkflows(ctx, actor.ID, conversationID, botID, s.nowUTC()); err != nil {
			return Workflow{}, err
		}
		active, listErr := tx.ListActiveWorkflows(ctx, actor.ID, conversationID, botID, 2)
		if listErr != nil {
			return Workflow{}, listErr
		}
		switch len(active) {
		case 0:
			return Workflow{}, s.cancelWorkflowRejection(ctx, tx, actor, spaceID, "workspace.conversation", conversationID, input.Request, NewError(CodeWorkflowActiveNotFound, "当前 Bot 会话没有进行中的引导流程", 404))
		case 1:
			copy := active[0]
			candidate = &copy
		default:
			return Workflow{}, s.cancelWorkflowRejection(ctx, tx, actor, spaceID, "workspace.conversation", conversationID, input.Request, &Error{Code: CodeWorkflowActiveAmbiguous, Message: "当前 Bot 会话存在多个进行中的引导流程", StatusCode: 409})
		}
	}

	if candidate == nil {
		return Workflow{}, s.cancelWorkflowRejection(ctx, tx, actor, spaceID, "workspace.workflow", workflowID, input.Request, workflowNotFoundError())
	}
	if err := tx.Lock(ctx, "workspace:workflow:"+candidate.ID); err != nil {
		return Workflow{}, err
	}
	current, err := tx.GetWorkflow(ctx, candidate.SpaceID, candidate.ID)
	if err != nil {
		return Workflow{}, err
	}
	if current == nil {
		return Workflow{}, s.cancelWorkflowRejection(ctx, tx, actor, candidate.SpaceID, "workspace.workflow", candidate.ID, input.Request, workflowNotFoundError())
	}
	actor, err = s.requireActor(ctx, tx, current.SpaceID, actorID)
	if err != nil {
		return Workflow{}, err
	}
	if current.ActorUserID != actor.ID {
		return Workflow{}, s.cancelWorkflowRejection(ctx, tx, actor, current.SpaceID, "workspace.workflow", current.ID, input.Request, workflowNotFoundError())
	}
	if current.Status != "active" {
		return Workflow{}, s.cancelWorkflowRejection(ctx, tx, actor, current.SpaceID, "workspace.workflow", current.ID, input.Request, conflict(CodeWorkflowNotActive, MessageWorkflowNotActive))
	}
	if _, contextErr := s.requireCommandContext(ctx, tx, actor.ID, stringValue(current.BotUserID), stringValue(current.ConversationID), current.SpaceID); contextErr != nil {
		return Workflow{}, s.cancelWorkflowRejection(ctx, tx, actor, current.SpaceID, "workspace.workflow", current.ID, input.Request, contextErr)
	}
	now := s.nowUTC()
	allowed, retry, err := s.consumeRateLimit(ctx, tx, RateLimitInput{SpaceID: current.SpaceID, ActorUserID: actor.ID, BotUserID: stringValue(current.BotUserID), OperationKey: "workflow.cancel:" + current.WorkflowType, Limit: s.limits.WorkflowCancel, UpdatedAt: now})
	if err != nil {
		return Workflow{}, err
	}
	if !allowed {
		return Workflow{}, s.cancelWorkflowRejection(ctx, tx, actor, current.SpaceID, "workspace.workflow", current.ID, input.Request, &Error{Code: CodeInteractionRateLimited, Message: MessageRateLimited, StatusCode: 429, Details: map[string]any{"retryAfterSeconds": int(retry.Seconds())}})
	}
	state, err := decodeJSON(current.StateJSON)
	if err != nil {
		return Workflow{}, err
	}
	definition := s.workflows.Get(current.WorkflowType, current.WorkflowVersion)
	if definition == nil {
		return Workflow{}, s.cancelWorkflowRejection(ctx, tx, actor, current.SpaceID, "workspace.workflow", current.ID, input.Request, NewError("workflow.unknown_version", MessageWorkflowUnknownVersion, 422))
	}
	updated, changed, err := tx.UpdateWorkflow(ctx, current.ID, current.Revision, state, "cancelled", now)
	if err != nil {
		return Workflow{}, err
	}
	if !changed || updated == nil {
		return Workflow{}, s.cancelWorkflowRejection(ctx, tx, actor, current.SpaceID, "workspace.workflow", current.ID, input.Request, conflict(CodeWorkflowRaceConflict, "引导流程已被其他请求更新"))
	}
	if err := s.writeAudit(ctx, tx, actor, input.Request, AuditInput{SpaceID: current.SpaceID, Action: "workflow.cancel", TargetType: "workspace.workflow", TargetID: current.ID, Result: "success", CreatedAt: now}); err != nil {
		return Workflow{}, err
	}
	if err := s.writeEvent(ctx, tx, EventInput{SpaceID: current.SpaceID, Type: "workflow.cancelled", ActorID: actor.ID, ConversationID: stringValue(current.ConversationID), TargetType: "workspace.workflow", TargetID: current.ID, PayloadJSON: mustJSON(map[string]any{"revision": updated.Revision, "status": updated.Status}), CreatedAt: now}); err != nil {
		return Workflow{}, err
	}
	return s.projectWorkflow(ctx, definition, updated, actor, state)
}

func (s *Service) cancelWorkflowRejection(ctx context.Context, tx Tx, actor *auth.Actor, spaceID, targetType, targetID string, request Request, err error) error {
	if shouldRollback(err) {
		return wrapInfrastructureFailure(err, "cancel workspace workflow")
	}
	domain := toError(err, CodeWorkflowFailed, "引导流程取消失败")
	if auditErr := s.auditExpected(ctx, tx, actor, spaceID, "workflow.cancel", targetType, targetID, request, domain); auditErr != nil {
		return auditErr
	}
	return &TransactionRejection{Err: domain, TargetID: targetID, Reason: domain.Code}
}

func (s *Service) requireActor(ctx context.Context, repository ReadRepository, spaceID, actorID string) (*auth.Actor, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	actor, err := repository.LookupActor(ctx, spaceID, actorID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if actor == nil || actor.ID != actorID {
		return nil, permissionDeniedError()
	}
	if actor.Kind != "" && actor.Kind != "human" {
		return nil, permissionDeniedError()
	}
	return actor, nil
}
func (s *Service) requireCommandContext(ctx context.Context, repository ReadRepository, actorID, botID, conversationID, spaceID string) (ConversationRecord, error) {
	conversation, err := repository.GetConversation(ctx, spaceID, conversationID)
	if err != nil {
		return ConversationRecord{}, normalizeError(err)
	}
	if conversation == nil {
		return ConversationRecord{}, conversationNotFoundError()
	}
	if ok, err := repository.ConversationMemberActive(ctx, spaceID, conversationID, actorID); err != nil {
		return ConversationRecord{}, normalizeError(err)
	} else if !ok {
		return ConversationRecord{}, conversationNotFoundError()
	}
	if ok, err := repository.BotMemberActive(ctx, spaceID, conversationID, botID); err != nil {
		return ConversationRecord{}, normalizeError(err)
	} else if !ok {
		return ConversationRecord{}, botNotAvailableError()
	}
	return *conversation, nil
}
func (s *Service) consumeRateLimit(ctx context.Context, tx Tx, input RateLimitInput) (bool, time.Duration, error) {
	window := input.UpdatedAt.UTC().Truncate(RateLimitWindow)
	input.WindowStartedAt = window
	if err := tx.Lock(ctx, "workspace:interaction-rate:"+input.SpaceID+":"+input.ActorUserID+":"+input.BotUserID+":"+input.OperationKey+":"+window.Format(time.RFC3339)); err != nil {
		return false, 0, err
	}
	return tx.ConsumeRateLimit(ctx, input)
}
func (s *Service) validateState(definition *WorkflowDefinition, state any) (any, error) {
	if state == nil {
		state = map[string]any{}
	}
	safe, err := cards.NormalizeCardPayload(state, cards.Limits{MaxPayloadBytes: 64 * 1024, MaxDepth: 8, MaxNodes: 300, MaxTextBytes: 32 * 1024}, false)
	if err != nil {
		return nil, err
	}
	if definition.ValidateState != nil {
		return definition.ValidateState(safe)
	}
	return safe, nil
}
func (s *Service) projectWorkflow(ctx context.Context, definition *WorkflowDefinition, row *WorkflowRecord, actor *auth.Actor, state any) (Workflow, error) {
	if definition.Project != nil {
		projected, err := definition.Project(ctx, WorkflowProjectionContext{Actor: actor, Workflow: publicWorkflow(row, state), State: state})
		if err != nil {
			return Workflow{}, toError(err, CodeWorkflowFailed, "引导流程投影失败")
		}
		state = projected
	}
	value := publicWorkflow(row, state)
	return value, nil
}
func (s *Service) nowUTC() time.Time {
	value := time.Now()
	if s != nil && s.now != nil {
		value = s.now()
	}
	if value.IsZero() {
		value = time.Unix(0, 0)
	}
	return value.UTC().Truncate(time.Millisecond)
}
func (s *Service) newID(operation string) (string, error) {
	if s == nil || s.idFactory == nil {
		return "", errors.New(operation + " id factory is required")
	}
	value, err := s.idFactory()
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(value) == "" {
		return "", errors.New(operation + " id factory returned an empty id")
	}
	return strings.TrimSpace(value), nil
}
func (s *Service) auditRejected(ctx context.Context, actor *auth.Actor, spaceID, action, targetType, targetID string, request Request, err error) {
	if actor == nil || s == nil || s.repo == nil {
		return
	}
	_ = s.repo.WithTx(ctx, func(tx Tx) error {
		return s.writeAudit(ctx, tx, actor, request, AuditInput{SpaceID: spaceID, Action: action, TargetType: targetType, TargetID: targetID, Result: "rejected", Reason: toError(err, CodeWorkflowFailed, "操作失败").Code, CreatedAt: s.nowUTC()})
	})
}
func (s *Service) auditExpected(ctx context.Context, tx Tx, actor *auth.Actor, spaceID, action, targetType, targetID string, request Request, err error) error {
	if actor == nil {
		return nil
	}
	if shouldRollback(err) {
		return wrapInfrastructureFailure(err, action)
	}
	operationErr := toError(err, CodeWorkflowFailed, "操作失败")
	return s.writeAudit(ctx, tx, actor, request, AuditInput{SpaceID: spaceID, Action: action, TargetType: targetType, TargetID: targetID, Result: "rejected", Reason: operationErr.Code, CreatedAt: s.nowUTC()})
}
func (s *Service) failCommand(ctx context.Context, tx Tx, runID string, actor *auth.Actor, spaceID, name string, request Request, err error) error {
	if shouldRollback(err) {
		return wrapInfrastructureFailure(err, "execute workspace command")
	}
	domain := toError(err, CodeCommandFailed, "命令执行失败")
	if failErr := tx.FailCommandRun(ctx, runID, domain.Code, s.nowUTC()); failErr != nil {
		return failErr
	}
	if auditErr := s.writeAudit(ctx, tx, actor, request, AuditInput{SpaceID: spaceID, Action: "command." + name, TargetType: "workspace.command", TargetID: runID, Result: "rejected", Reason: domain.Code, CreatedAt: s.nowUTC()}); auditErr != nil {
		return auditErr
	}
	return interactionRejection{err: domain}
}
func (s *Service) auditWorkflowFailure(ctx context.Context, tx Tx, actor *auth.Actor, spaceID, targetID string, request Request, err error) error {
	if shouldRollback(err) {
		return wrapInfrastructureFailure(err, "start workspace workflow")
	}
	domain := toError(err, CodeWorkflowFailed, "引导流程创建失败")
	if auditErr := s.writeAudit(ctx, tx, actor, request, AuditInput{SpaceID: spaceID, Action: "workflow.start", TargetType: "workspace.workflow", TargetID: targetID, Result: "rejected", Reason: domain.Code, CreatedAt: s.nowUTC()}); auditErr != nil {
		return auditErr
	}
	return interactionRejection{err: domain}
}
func (s *Service) writeAudit(ctx context.Context, tx Tx, actor *auth.Actor, request Request, input AuditInput) error {
	meta := request.Meta.Safe()
	input.ActorUserID = actor.ID
	input.ActorGitHubLogin = actor.GitHubLogin
	input.RequestID = meta.RequestID
	input.IPAddress = meta.IPAddress
	input.UserAgent = meta.UserAgent
	return tx.WriteAudit(ctx, input)
}
func (s *Service) writeEvent(ctx context.Context, tx Tx, input EventInput) error {
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	_, err := tx.WriteEvent(ctx, input)
	return err
}

type interactionRejection struct{ err error }

func (r interactionRejection) Error() string {
	if r.err == nil {
		return ""
	}
	return r.err.Error()
}

func normalizeID(value, code, message string) (string, error) {
	normalized := strings.TrimSpace(value)
	if !interactionIdentifierPattern.MatchString(normalized) {
		return "", NewError(code, message, 400)
	}
	return normalized, nil
}
func normalizeWorkflowTypeInput(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if !workflowTypeInputPattern.MatchString(normalized) {
		return "", NewError(CodeWorkflowInvalidType, "引导流程类型无效", 400)
	}
	return normalized, nil
}
func normalizeWorkflowStatus(value string) (string, error) {
	if value == "" {
		return "active", nil
	}
	switch value {
	case "active", "completed", "cancelled", "expired", "conflicted":
		return value, nil
	default:
		return "", NewError("workflow.invalid_status", "引导流程状态无效", 400)
	}
}
func stringPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
func decodeJSON(raw []byte) (any, error) {
	if len(raw) == 0 {
		return map[string]any{}, nil
	}
	var value any
	err := json.Unmarshal(raw, &value)
	return value, err
}
func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte(`{}`)
	}
	return encoded
}
func normalizeInteractionResult(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	return cards.NormalizeCardPayload(value, cards.Limits{MaxPayloadBytes: 16 * 1024, MaxDepth: 6, MaxNodes: 100, MaxTextBytes: 8 * 1024}, false)
}
func toError(err error, fallbackCode, fallbackMessage string) *Error {
	if err == nil {
		return nil
	}
	var domain *Error
	if errors.As(err, &domain) {
		return domain
	}
	var cardErr *cards.CardValidationError
	if errors.As(err, &cardErr) {
		return NewError(cardErr.Code, cardErr.Message, 422)
	}
	var definitionErr *DefinitionError
	if errors.As(err, &definitionErr) {
		return NewError(definitionErr.Code, definitionErr.Message, 400)
	}
	return internalError(fallbackMessage, err)
}
func hashRequest(value any) string {
	sum := sha256.Sum256(canonicalJSON(value))
	return hex.EncodeToString(sum[:])
}
func canonicalJSON(value any) []byte {
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sortStrings(keys)
		var builder strings.Builder
		builder.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				builder.WriteByte(',')
			}
			builder.Write(mustJSON(key))
			builder.WriteByte(':')
			builder.Write(canonicalJSON(typed[key]))
		}
		builder.WriteByte('}')
		return []byte(builder.String())
	case []any:
		var builder strings.Builder
		builder.WriteByte('[')
		for i, child := range typed {
			if i > 0 {
				builder.WriteByte(',')
			}
			builder.Write(canonicalJSON(child))
		}
		builder.WriteByte(']')
		return []byte(builder.String())
	default:
		return mustJSON(value)
	}
}
func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

var interactionIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var workflowTypeInputPattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)
