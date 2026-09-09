package cards

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type Clock func() time.Time
type IDFactory func() (string, error)

type ServiceOptions struct {
	Repository   Repository
	Registry     *Registry
	SpaceID      string
	Now          Clock
	IDFactory    IDFactory
	SystemBotIDs map[string]struct{}
}

type Service struct {
	repo         Repository
	registry     *Registry
	spaceID      string
	now          Clock
	idFactory    IDFactory
	systemBotIDs map[string]struct{}
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
	idFactory := options.IDFactory
	if idFactory == nil {
		idFactory = func() (string, error) {
			value, err := uuid.NewRandom()
			if err != nil {
				return "", err
			}
			return value.String(), nil
		}
	}
	ids := map[string]struct{}{"usr_system_echo": {}, "usr_system_beacon": {}}
	for id := range options.SystemBotIDs {
		ids[id] = struct{}{}
	}
	return &Service{repo: options.Repository, registry: options.Registry, spaceID: spaceID, now: now, idFactory: idFactory, systemBotIDs: ids}
}

func (s *Service) Repository() Repository {
	if s == nil {
		return nil
	}
	return s.repo
}
func (s *Service) Registry() *Registry {
	if s == nil {
		return nil
	}
	return s.registry
}

func (s *Service) Create(ctx context.Context, input CreateInput) (*Card, error) {
	return s.create(ctx, nil, input)
}

// CreateInTx applies the complete card creation mutation to an already-open
// domain transaction. It is additive to Create so human callers retain their
// existing transaction boundary while aggregate callers can keep card,
// message, event, audit, and idempotency writes in one transaction.
func (s *Service) CreateInTx(ctx context.Context, tx Tx, input CreateInput) (*Card, error) {
	if tx == nil {
		return nil, internalError("create workspace card", errors.New("transaction is required"))
	}
	return s.create(ctx, tx, input)
}

func (s *Service) create(ctx context.Context, externalTx Tx, input CreateInput) (*Card, error) {
	return s.createWithRevision(ctx, externalTx, input, 1)
}

func (s *Service) createWithRevision(ctx context.Context, externalTx Tx, input CreateInput, initialRevision int64) (*Card, error) {
	if s == nil || s.repo == nil {
		return nil, internalError("create workspace card", errors.New("repository is required"))
	}
	spaceID := strings.TrimSpace(input.SpaceID)
	if spaceID == "" {
		spaceID = s.spaceID
	}
	normalizedSpaceID, err := NormalizeIdentifier(spaceID, CodeCardInvalidSpace, "空间 ID 无效")
	if err != nil {
		return nil, toError(err)
	}
	spaceID = normalizedSpaceID
	sourceKind, err := normalizeSourceKind(input.SourceKind)
	if err != nil {
		return nil, err
	}
	visibility, err := normalizeVisibility(input.VisibilityScope)
	if err != nil {
		return nil, err
	}
	conversationID, err := normalizeOptional(input.ConversationID, CodeCardInvalidConversation, "会话 ID 无效")
	if err != nil {
		return nil, toError(err)
	}
	resourceType, err := normalizeOptional(input.ResourceType, CodeCardInvalidResource, "卡片资源类型无效")
	if err != nil {
		return nil, toError(err)
	}
	resourceID, err := normalizeOptional(input.ResourceID, CodeCardInvalidResource, "卡片资源 ID 无效")
	if err != nil {
		return nil, toError(err)
	}
	if visibility == VisibilityConversation && conversationID == nil {
		return nil, NewError(CodeCardConversationRequired, "会话卡片必须绑定会话", 400)
	}
	if visibility == VisibilityResource && (resourceType == nil || resourceID == nil) {
		return nil, NewError(CodeCardResourceRequired, "资源卡片必须绑定资源", 400)
	}
	sourceID, err := normalizeOptional(input.SourceID, CodeCardInvalidSource, "卡片来源 ID 无效")
	if err != nil {
		return nil, toError(err)
	}
	block, err := s.newBlock(input)
	if err != nil {
		return nil, err
	}
	definition := s.registry.Get(block.CardType, block.SchemaVersion)
	payload := input.Payload
	if len(input.RawPayload) > 0 {
		payload = input.RawPayload
	}
	validated, err := s.validatePayload(block, payload, definition, input.AllowUnknownDefinition && input.TrustedCustomBot)
	if err != nil {
		return nil, toError(err)
	}
	if input.ExpiresAt != nil && !input.ExpiresAt.IsZero() && !input.ExpiresAt.UTC().After(s.nowUTC()) {
		return nil, NewError(CodeCardInvalidExpiry, "卡片有效期无效", 400)
	}
	actorID := strings.TrimSpace(input.ActorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	allowBot := sourceKind != SourceWorkspace || input.TrustedCustomBot
	actorRepository := ReadRepository(s.repo)
	if externalTx != nil {
		actorRepository = externalTx
	}
	actor, err := s.requireActor(ctx, actorRepository, spaceID, actorID, allowBot)
	if err != nil {
		return nil, err
	}
	createdBy := actor.ID
	if input.CreatedByUserID != "" && strings.TrimSpace(input.CreatedByUserID) != actor.ID {
		return nil, permissionDeniedError()
	}
	if sourceKind == SourceCustomBot && (!input.TrustedCustomBot || actor.Kind != "bot") {
		return nil, NewError(CodeCardSourceForbidden, "Bot 卡片必须通过受信任网关创建", 403)
	}
	if sourceKind == SourceCustomBot && actor.Kind == "bot" {
		if err := s.requireCustomBot(ctx, actorRepository, spaceID, input.BotID, actor.ID); err != nil {
			return nil, err
		}
	}
	cardID := strings.TrimSpace(input.CardID)
	if cardID == "" {
		value, idErr := s.newID("card")
		if idErr != nil {
			return nil, internalError("generate workspace card id", idErr)
		}
		cardID = "card_" + value
	}
	if _, err := NormalizeIdentifier(cardID, CodeCardInvalidID, "卡片 ID 无效"); err != nil {
		return nil, toError(err)
	}
	now := s.nowUTC()
	insert := CardInsert{CardRecord: CardRecord{ID: cardID, SpaceID: spaceID, ConversationID: conversationID, CardType: block.CardType, SchemaVersion: block.SchemaVersion, PayloadJSON: mustJSON(validated), FallbackText: block.FallbackText, SourceKind: sourceKind, SourceID: sourceID, ResourceType: resourceType, ResourceID: resourceID, VisibilityScope: visibility, CreatedByUserID: &createdBy, Status: StatusActive, Revision: initialRevision, ExpiresAt: cloneTime(input.ExpiresAt), CreatedAt: now, UpdatedAt: now}}
	var result *Card
	write := func(tx Tx) error {
		if err := tx.Lock(ctx, "workspace:card:create:"+spaceID+":"+string(sourceKind)+":"+sourceKey(sourceID, cardID)+":"+block.CardType); err != nil {
			return err
		}
		if ok, err := tx.SpaceExists(ctx, spaceID); err != nil {
			return err
		} else if !ok {
			return NewError("space.not_found", "空间不存在", 404)
		}
		if conversationID != nil {
			conversation, err := tx.GetConversation(ctx, spaceID, *conversationID)
			if err != nil {
				return err
			}
			if conversation == nil {
				return NewError("conversation.not_found", "会话不存在", 404)
			}
			if ok, err := tx.ConversationMemberActive(ctx, spaceID, *conversationID, actor.ID); err != nil {
				return err
			} else if !ok {
				return notFoundError()
			}
		}
		insideActor, err := s.requireActor(ctx, tx, spaceID, actor.ID, allowBot)
		if err != nil {
			return err
		}
		if insideActor.ID != actor.ID {
			return authRequiredError()
		}
		if sourceKind == SourceCustomBot && insideActor.Kind == "bot" {
			if err := s.requireCustomBot(ctx, tx, spaceID, input.BotID, insideActor.ID); err != nil {
				return err
			}
		}
		if sourceID != nil {
			existing, err := tx.GetCardBySource(ctx, spaceID, sourceKind, *sourceID, block.CardType)
			if err != nil {
				return err
			}
			if existing != nil {
				if cardMatches(*existing, insert.CardRecord) {
					result = s.publicCard(existing, definition, validated)
					return nil
				}
				return conflictError(CodeCardSourceConflict, "卡片来源已绑定其他内容")
			}
		}
		stored, inserted, err := tx.InsertCard(ctx, insert)
		if err != nil {
			return err
		}
		if !inserted || stored == nil {
			if sourceID != nil {
				existing, readErr := tx.GetCardBySource(ctx, spaceID, sourceKind, *sourceID, block.CardType)
				if readErr != nil {
					return readErr
				}
				if existing != nil && cardMatches(*existing, insert.CardRecord) {
					result = s.publicCard(existing, definition, validated)
					return nil
				}
				if existing != nil {
					return conflictError(CodeCardSourceConflict, "卡片来源已绑定其他内容")
				}
			}
			return conflictError(CodeCardRevisionConflict, "卡片 ID 已存在")
		}
		if err := s.writeEvent(ctx, tx, EventInput{SpaceID: spaceID, Type: "card.created", ActorID: actor.ID, ConversationID: stringValue(conversationID), TargetType: "workspace.card", TargetID: cardID, PayloadJSON: evidenceJSON(map[string]any{"cardId": cardID, "cardType": block.CardType, "revision": initialRevision, "status": StatusActive}), CreatedAt: now}); err != nil {
			return err
		}
		if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{SpaceID: spaceID, Action: "card.create", TargetType: "workspace.card", TargetID: cardID, Result: "success", CreatedAt: now}); err != nil {
			return err
		}
		result = s.publicCard(stored, definition, validated)
		return nil
	}
	if externalTx != nil {
		err = write(externalTx)
	} else {
		err = s.repo.WithTx(ctx, write)
	}
	if err != nil {
		return nil, normalizeError(err)
	}
	return result, nil
}

// CreateCard is kept as a descriptive alias for transport adapters.
func (s *Service) CreateCard(ctx context.Context, input CreateInput) (*Card, error) {
	return s.Create(ctx, input)
}

func (s *Service) Resolve(ctx context.Context, actorID, cardID string, request Request) (Resolution, error) {
	if s == nil || s.repo == nil {
		return Resolution{}, internalError("resolve workspace card", errors.New("repository is required"))
	}
	cardID, err := NormalizeIdentifier(cardID, CodeCardInvalidID, "卡片 ID 无效")
	if err != nil {
		return Resolution{}, toError(err)
	}
	row, err := s.repo.GetCard(ctx, s.spaceID, cardID)
	if err != nil {
		return Resolution{}, normalizeError(err)
	}
	if row == nil {
		return Resolution{}, notFoundError()
	}
	actor, err := s.requireActor(ctx, s.repo, row.SpaceID, actorID, false)
	if err != nil {
		return Resolution{}, err
	}
	definition := s.registry.Get(row.CardType, row.SchemaVersion)
	if err := s.assertVisible(ctx, s.repo, row, definition, actor, "read", request); err != nil {
		return Resolution{}, err
	}
	status := s.effectiveStatus(row)
	if definition == nil {
		return Resolution{Type: CardFallbackType, Reason: CodeCardUnknownVersion, Block: row.PublicBlock(), FallbackText: row.FallbackText, Status: status, Revision: row.Revision}, nil
	}
	payload, err := decodeJSON(row.PayloadJSON)
	if err != nil {
		return Resolution{}, internalError("decode workspace card payload", err)
	}
	if definition.ProjectPayload != nil {
		payload, err = definition.ProjectPayload(ctx, CardProjectContext{Actor: actor, Card: s.publicCardValue(row, definition, payload, status), Payload: payload, Request: request})
		if err != nil {
			return Resolution{}, toError(err)
		}
	} else if definition.ValidatePayloadJSON != nil {
		payload = json.RawMessage(row.PayloadJSON)
	}
	validated, err := s.registry.ValidatePayload(row.PublicBlock(), payload)
	if err != nil {
		return Resolution{}, toError(err)
	}
	return s.resolutionFromCard(s.publicCard(row, definition, validated.Payload)), nil
}

func (s *Service) ResolveCard(ctx context.Context, actorID, cardID string, request Request) (Resolution, error) {
	return s.Resolve(ctx, actorID, cardID, request)
}

func (s *Service) ValidateMessageCardReference(ctx context.Context, actorID, conversationID string, block CardBlock) (CardBlock, error) {
	return s.validateMessageCardReference(ctx, s.repo, actorID, conversationID, block)
}

// ValidateMessageCardReferenceInTx repeats card ownership, membership, and
// active-status checks through the supplied transaction. This is required when
// the card was created earlier in the same outer Bot Gateway transaction and
// is not visible through a separate pool connection yet.
func (s *Service) ValidateMessageCardReferenceInTx(ctx context.Context, tx Tx, actorID, conversationID string, block CardBlock) (CardBlock, error) {
	if tx == nil {
		return CardBlock{}, internalError("validate workspace card reference", errors.New("transaction is required"))
	}
	return s.validateMessageCardReference(ctx, tx, actorID, conversationID, block)
}

func (s *Service) validateMessageCardReference(ctx context.Context, repository ReadRepository, actorID, conversationID string, block CardBlock) (CardBlock, error) {
	if s == nil || repository == nil {
		return CardBlock{}, internalError("validate workspace card reference", errors.New("repository is required"))
	}
	conversationID, err := NormalizeIdentifier(conversationID, CodeCardInvalidConversation, "会话 ID 无效")
	if err != nil {
		return CardBlock{}, toError(err)
	}
	normalized, err := NormalizeCardBlock(block)
	if err != nil {
		return CardBlock{}, toError(err)
	}
	row, err := repository.GetCard(ctx, s.spaceID, normalized.CardID)
	if err != nil {
		return CardBlock{}, normalizeError(err)
	}
	if row == nil {
		return CardBlock{}, NewError(CodeCardNotFound, "卡片不存在或不可发送", 404)
	}
	actor, err := s.requireActor(ctx, repository, row.SpaceID, actorID, true)
	if err != nil {
		return CardBlock{}, err
	}
	if ok, err := repository.ConversationMemberActive(ctx, row.SpaceID, conversationID, actor.ID); err != nil {
		return CardBlock{}, normalizeError(err)
	} else if !ok {
		return CardBlock{}, notFoundError()
	}
	if stringValue(row.ConversationID) != strings.TrimSpace(conversationID) || row.CardType != normalized.CardType || row.SchemaVersion != normalized.SchemaVersion || row.FallbackText != normalized.FallbackText || s.effectiveStatus(row) != StatusActive {
		return CardBlock{}, conflictError(CodeCardReferenceMismatch, "卡片引用与服务端记录不一致")
	}
	return normalized, nil
}

func (s *Service) ExecuteAction(ctx context.Context, input ActionInput) (ActionOutcome, error) {
	cardID, err := NormalizeIdentifier(input.CardID, CodeCardInvalidID, "卡片 ID 无效")
	if err != nil {
		return ActionOutcome{}, toError(err)
	}
	actionID, err := NormalizeIdentifier(input.ActionID, CodeCardInvalidAction, "卡片操作 ID 无效")
	if err != nil {
		return ActionOutcome{}, toError(err)
	}
	clientActionID, err := NormalizeIdentifier(input.ClientActionID, CodeCardInvalidClientAction, "客户端操作 ID 无效")
	if err != nil {
		return ActionOutcome{}, toError(err)
	}
	if input.ExpectedRevision < 1 {
		return ActionOutcome{}, NewError(CodeCardInvalidRevision, "卡片版本无效", 400)
	}
	var outcome ActionOutcome
	var rejectedErr error
	runID, idErr := s.newID("card action")
	if idErr != nil {
		return ActionOutcome{}, internalError("generate workspace card action id", idErr)
	}
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		actionErr := func() error {
			if err := tx.Lock(ctx, "workspace:card:action:"+cardID); err != nil {
				return err
			}
			row, err := tx.GetCard(ctx, s.spaceID, cardID)
			if err != nil {
				return err
			}
			if row == nil {
				outcome = ActionOutcome{}
				return s.rejected(ctx, tx, nil, nil, input.Meta, "card.action", cardID, notFoundError(), row)
			}
			actor, err := s.requireActor(ctx, tx, row.SpaceID, input.ActorID, false)
			if err != nil {
				outcome = ActionOutcome{}
				return s.rejected(ctx, tx, nil, nil, input.Meta, "card.action", cardID, err, row)
			}
			definition := s.registry.Get(row.CardType, row.SchemaVersion)
			if definition == nil {
				return s.rejected(ctx, tx, actor, nil, input.Meta, "card.action", cardID, unknownVersionError(), row)
			}
			normalizedInput, _, action, err := s.registry.ValidateActionInput(row.PublicBlock(), actionID, input.Input)
			if err != nil {
				return s.rejected(ctx, tx, actor, action, input.Meta, "card.action."+actionID, cardID, toError(err), row)
			}
			hash := hashRequest(map[string]any{"cardId": cardID, "actionId": actionID, "expectedRevision": input.ExpectedRevision, "input": normalizedInput})
			now := s.nowUTC()
			run, inserted, err := tx.InsertActionRun(ctx, ActionRunRecord{ID: "cact_" + runID, CardID: cardID, ActorUserID: actor.ID, ActionID: actionID, ClientActionID: clientActionID, RequestHash: hash, ExpectedRevision: input.ExpectedRevision, Status: "pending", CreatedAt: now})
			if err != nil {
				return err
			}
			if !inserted {
				run, err = tx.GetActionRun(ctx, cardID, actor.ID, clientActionID)
				if err != nil {
					return err
				}
				if run == nil {
					return conflictError(CodeCardRevisionConflict, "卡片操作状态已变化")
				}
				if run.RequestHash != hash {
					return s.rejected(ctx, tx, actor, action, input.Meta, "card.action."+actionID, cardID, conflictError(CodeCardIdempotencyConflict, "操作标识已用于其他请求"), row)
				}
				if run.Status == "succeeded" {
					var result any
					result, _ = decodeJSON(run.ResultJSON)
					revision := input.ExpectedRevision
					if run.ResultingRevision != nil {
						revision = *run.ResultingRevision
					}
					outcome = ActionOutcome{OK: true, Replayed: true, Result: result, Revision: revision}
					return nil
				}
				if run.Status == "failed" {
					return s.rejected(ctx, tx, actor, action, input.Meta, "card.action."+actionID, cardID, conflictError(run.ErrorCode, "卡片操作未完成"), row)
				}
				return s.rejected(ctx, tx, actor, action, input.Meta, "card.action."+actionID, cardID, conflictError(CodeCardActionInProgress, "卡片操作正在处理"), row)
			}
			status := s.effectiveStatus(row)
			if err := s.assertVisible(ctx, tx, row, definition, actor, "action", Request{Meta: input.Meta}); err != nil {
				if !isActionRejection(err) {
					return err
				}
				return s.finishFailed(ctx, tx, run.ID, actor, row, actionID, input.Meta, err)
			}
			if status != StatusActive {
				return s.finishFailed(ctx, tx, run.ID, actor, row, actionID, input.Meta, conflictError(CodeCardNotActionable, "卡片已不可操作"))
			}
			if row.Revision != input.ExpectedRevision {
				return s.finishFailed(ctx, tx, run.ID, actor, row, actionID, input.Meta, conflictError(CodeCardStaleRevision, "卡片状态已变化，请刷新后重试"))
			}
			if action.Authorize != nil {
				allowed, authErr := action.Authorize(ctx, CardAuthorization{Actor: actor, Card: s.publicCardValue(row, definition, nil, status), Operation: "action", Input: normalizedInput, Request: Request{Meta: input.Meta}, ClientActionID: clientActionID})
				if authErr != nil {
					if !isActionRejection(authErr) {
						return authErr
					}
					return s.finishFailed(ctx, tx, run.ID, actor, row, actionID, input.Meta, authErr)
				}
				if !allowed {
					return s.finishFailed(ctx, tx, run.ID, actor, row, actionID, input.Meta, notFoundError())
				}
			}
			payload, err := decodeJSON(row.PayloadJSON)
			if err != nil {
				return internalError("decode workspace card payload", err)
			}
			var executed CardActionResult
			var safeResult any
			var resultingRevision int64
			savepointID := sha256.Sum256([]byte(run.ID))
			savepointErr := tx.WithActionSavepoint(ctx, "card_action_"+hex.EncodeToString(savepointID[:16]), func(actionCtx context.Context) error {
				var execErr error
				executed, execErr = action.Execute(actionCtx, CardActionContext{
					Tx: tx, Actor: actor, Card: s.publicCardValue(row, definition, payload, status), Payload: payload,
					PayloadJSON: append(json.RawMessage(nil), row.PayloadJSON...), Input: normalizedInput,
					ClientActionID: clientActionID, Request: Request{Meta: input.Meta},
				})
				if execErr != nil {
					if isActionRejection(execErr) {
						return actionSavepointRejection{err: execErr}
					}
					return execErr
				}
				result := executed.Result
				if result == nil {
					result = map[string]any{}
				}
				var normalizeErr error
				safeResult, normalizeErr = NormalizeCardPayload(result, Limits{MaxPayloadBytes: MaxActionPayloadBytes, MaxDepth: MaxActionPayloadDepth, MaxNodes: MaxActionPayloadNodes, MaxTextBytes: MaxActionTextBytes}, false)
				if normalizeErr != nil {
					return actionSavepointRejection{err: normalizeErr}
				}
				resultingRevision = row.Revision
				nextStatus := status
				var nextPayload any = json.RawMessage(row.PayloadJSON)
				changed := executed.CardPayload != nil || executed.CardStatus != nil
				if executed.CardPayload != nil {
					validated, validationErr := s.registry.ValidatePayload(row.PublicBlock(), executed.CardPayload)
					if validationErr != nil {
						if !isActionRejection(validationErr) {
							return validationErr
						}
						return actionSavepointRejection{err: validationErr}
					}
					nextPayload = validated.Payload
				}
				if executed.CardStatus != nil {
					nextStatus = *executed.CardStatus
					if nextStatus != StatusActive && nextStatus != StatusInvalidated && nextStatus != StatusExpired {
						return actionSavepointRejection{err: NewError(CodeCardInvalidStatus, "卡片状态无效", 400)}
					}
				}
				if changed {
					updated, didChange, updateErr := tx.UpdateCard(actionCtx, row.ID, row.Revision, nextPayload, nextStatus, row.FallbackText, s.nowUTC())
					if updateErr != nil {
						return updateErr
					}
					if !didChange || updated == nil {
						return actionSavepointRejection{err: conflictError(CodeCardRevisionConflict, "卡片版本已变化")}
					}
					resultingRevision = updated.Revision
					if err := s.writeEvent(actionCtx, tx, EventInput{SpaceID: row.SpaceID, Type: "card.updated", ActorID: actor.ID, ConversationID: stringValue(row.ConversationID), TargetType: "workspace.card", TargetID: row.ID, PayloadJSON: evidenceJSON(map[string]any{"cardId": row.ID, "cardType": row.CardType, "revision": resultingRevision, "status": nextStatus}), CreatedAt: s.nowUTC()}); err != nil {
						return err
					}
				}
				return nil
			})
			if savepointErr != nil {
				var savepointFailure *actionSavepointFailure
				if errors.As(savepointErr, &savepointFailure) {
					return savepointErr
				}
				var rejected actionSavepointRejection
				if errors.As(savepointErr, &rejected) {
					return s.finishFailed(ctx, tx, run.ID, actor, row, actionID, input.Meta, rejected.err)
				}
				return savepointErr
			}
			if err := tx.CompleteActionRun(ctx, run.ID, "succeeded", mustJSON(safeResult), &resultingRevision, s.nowUTC()); err != nil {
				return err
			}
			if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{SpaceID: row.SpaceID, Action: "card.action." + actionID, TargetType: "workspace.card", TargetID: row.ID, Result: "success", CreatedAt: s.nowUTC()}); err != nil {
				return err
			}
			if !executed.ActionEventWritten {
				if err := s.writeEvent(ctx, tx, EventInput{SpaceID: row.SpaceID, Type: "card.action", ActorID: actor.ID, ConversationID: stringValue(row.ConversationID), TargetType: "workspace.card", TargetID: row.ID, PayloadJSON: evidenceJSON(map[string]any{"cardId": row.ID, "actionId": actionID, "revision": resultingRevision}), CreatedAt: s.nowUTC()}); err != nil {
					return err
				}
			}
			outcome = ActionOutcome{OK: true, Result: safeResult, Revision: resultingRevision}
			return nil
		}()
		var rejected rejection
		if actionErr != nil && errors.As(actionErr, &rejected) {
			rejectedErr = rejected.err
			return nil
		}
		return actionErr
	})
	if err != nil {
		return ActionOutcome{}, normalizeError(err)
	}
	if rejectedErr != nil {
		return ActionOutcome{}, rejectedErr
	}
	if !outcome.OK {
		return ActionOutcome{}, conflictError(CodeCardActionInProgress, "卡片操作未完成")
	}
	return outcome, nil
}

func (s *Service) ExecuteCardAction(ctx context.Context, input ActionInput) (ActionOutcome, error) {
	return s.ExecuteAction(ctx, input)
}

func (s *Service) CreateCustomBotCard(ctx context.Context, input CustomBotCreateInput) (*Card, error) {
	input.CreateInput.SourceKind = SourceCustomBot
	input.CreateInput.TrustedCustomBot = true
	input.CreateInput.AllowUnknownDefinition = true
	input.CreateInput.ActorID = input.BotUserID
	input.CreateInput.CreatedByUserID = input.BotUserID
	input.CreateInput.BotID = input.BotID
	return s.Create(ctx, input.CreateInput)
}

// CreateCustomBotCardInTx is the transaction-scoped Bot Gateway card writer.
// It preserves the same custom-bot authorization and card validation as the
// human-compatible Create path while reusing the caller's transaction.
func (s *Service) CreateCustomBotCardInTx(ctx context.Context, tx Tx, input CustomBotCreateInput) (*Card, error) {
	input.CreateInput.SourceKind = SourceCustomBot
	input.CreateInput.TrustedCustomBot = true
	input.CreateInput.AllowUnknownDefinition = true
	input.CreateInput.ActorID = input.BotUserID
	input.CreateInput.CreatedByUserID = input.BotUserID
	input.CreateInput.BotID = input.BotID
	return s.CreateInTx(ctx, tx, input.CreateInput)
}

func (s *Service) UpdateCustomBotCard(ctx context.Context, input CustomBotUpdateInput) (*Card, error) {
	return s.updateCustomBot(ctx, input)
}

func (s *Service) InvalidateCustomBotCard(ctx context.Context, input CustomBotInvalidateInput) (*Card, error) {
	spaceID, err := NormalizeIdentifier(input.SpaceID, CodeCardInvalidSpace, "空间 ID 无效")
	if err != nil {
		return nil, toError(err)
	}
	cardID, err := NormalizeIdentifier(input.CardID, CodeCardInvalidID, "卡片 ID 无效")
	if err != nil {
		return nil, toError(err)
	}
	botID, err := NormalizeIdentifier(input.BotID, CodeCardInvalidSource, "Bot ID 无效")
	if err != nil {
		return nil, toError(err)
	}
	botUserID, err := NormalizeIdentifier(input.BotUserID, CodeCardInvalidOwner, "卡片所有者无效")
	if err != nil {
		return nil, toError(err)
	}
	status := input.Status
	if status == "" {
		status = StatusInvalidated
	}
	if status != StatusInvalidated && status != StatusExpired {
		return nil, NewError(CodeCardInvalidStatus, "卡片状态无效", 400)
	}
	if input.ExpectedRevision < 1 {
		return nil, NewError(CodeCardInvalidRevision, "卡片版本无效", 400)
	}
	actor, err := s.requireActor(ctx, s.repo, spaceID, botUserID, true)
	if err != nil {
		return nil, err
	}
	if actor.Kind != "bot" {
		return nil, NewError(CodeCardInvalidOwner, "卡片所有者无效", 403)
	}
	if err := s.requireCustomBot(ctx, s.repo, spaceID, botID, actor.ID); err != nil {
		return nil, err
	}
	var result *Card
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		if err := s.recheckCustomBotWriter(ctx, tx, spaceID, botID, actor.ID); err != nil {
			return err
		}
		if err := tx.Lock(ctx, "workspace:card:bot-invalidate:"+cardID); err != nil {
			return err
		}
		row, err := tx.GetCard(ctx, spaceID, cardID)
		if err != nil {
			return err
		}
		if row == nil || row.SourceKind != SourceCustomBot || stringValue(row.CreatedByUserID) != actor.ID {
			return notFoundError()
		}
		if !json.Valid(row.PayloadJSON) {
			return internalError("decode workspace card payload", invalidJSONPayload())
		}
		updated, changed, err := tx.UpdateCard(ctx, row.ID, input.ExpectedRevision, json.RawMessage(row.PayloadJSON), status, row.FallbackText, s.nowUTC())
		if err != nil {
			return err
		}
		if !changed || updated == nil {
			return conflictError(CodeCardRevisionConflict, "卡片版本已变化")
		}
		if err := s.writeEvent(ctx, tx, EventInput{SpaceID: row.SpaceID, Type: "card.invalidated", ActorID: actor.ID, ConversationID: stringValue(row.ConversationID), TargetType: "workspace.card", TargetID: row.ID, PayloadJSON: evidenceJSON(map[string]any{"cardId": row.ID, "cardType": row.CardType, "revision": updated.Revision, "status": status}), CreatedAt: s.nowUTC()}); err != nil {
			return err
		}
		if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{SpaceID: row.SpaceID, Action: "card.invalidate", TargetType: "workspace.card", TargetID: row.ID, Result: "success", Reason: string(status), CreatedAt: s.nowUTC()}); err != nil {
			return err
		}
		definition := s.registry.Get(row.CardType, row.SchemaVersion)
		result = s.publicCard(updated, definition, json.RawMessage(row.PayloadJSON))
		return nil
	})
	if err != nil {
		return nil, normalizeError(err)
	}
	return result, nil
}

func (s *Service) Invalidate(ctx context.Context, spaceID, cardID string, status CardStatus, expectedRevision *int64, meta auth.RequestMeta) (*Card, error) {
	normalizedSpaceID, err := NormalizeIdentifier(spaceID, CodeCardInvalidSpace, "空间 ID 无效")
	if err != nil {
		return nil, toError(err)
	}
	spaceID = normalizedSpaceID
	cardID, err = NormalizeIdentifier(cardID, CodeCardInvalidID, "卡片 ID 无效")
	if err != nil {
		return nil, toError(err)
	}
	if status == "" {
		status = StatusInvalidated
	}
	if status != StatusInvalidated && status != StatusExpired {
		return nil, NewError(CodeCardInvalidStatus, "卡片状态无效", 400)
	}
	if expectedRevision != nil && *expectedRevision < 1 {
		return nil, NewError(CodeCardInvalidRevision, "卡片版本无效", 400)
	}
	row, err := s.repo.GetCard(ctx, spaceID, cardID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if row == nil {
		return nil, notFoundError()
	}
	var result *Card
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		if err := tx.Lock(ctx, "workspace:card:invalidate:"+cardID); err != nil {
			return err
		}
		current, err := tx.GetCard(ctx, spaceID, cardID)
		if err != nil {
			return err
		}
		if current == nil {
			return notFoundError()
		}
		revision := current.Revision
		if expectedRevision != nil {
			revision = *expectedRevision
		}
		if !json.Valid(current.PayloadJSON) {
			return internalError("decode workspace card payload", invalidJSONPayload())
		}
		updated, changed, err := tx.UpdateCard(ctx, cardID, revision, json.RawMessage(current.PayloadJSON), status, current.FallbackText, s.nowUTC())
		if err != nil {
			return err
		}
		if !changed || updated == nil {
			return conflictError(CodeCardRevisionConflict, "卡片版本已变化")
		}
		if err := s.writeEvent(ctx, tx, EventInput{SpaceID: spaceID, Type: "card.invalidated", ConversationID: stringValue(current.ConversationID), TargetType: "workspace.card", TargetID: cardID, PayloadJSON: evidenceJSON(map[string]any{"cardId": cardID, "cardType": current.CardType, "revision": updated.Revision, "status": status}), CreatedAt: s.nowUTC()}); err != nil {
			return err
		}
		definition := s.registry.Get(current.CardType, current.SchemaVersion)
		result = s.publicCard(updated, definition, json.RawMessage(current.PayloadJSON))
		return nil
	})
	if err != nil {
		return nil, normalizeError(err)
	}
	return result, nil
}

func (s *Service) updateCustomBot(ctx context.Context, input CustomBotUpdateInput) (*Card, error) {
	spaceID, err := NormalizeIdentifier(input.SpaceID, CodeCardInvalidSpace, "空间 ID 无效")
	if err != nil {
		return nil, toError(err)
	}
	cardID, err := NormalizeIdentifier(input.CardID, CodeCardInvalidID, "卡片 ID 无效")
	if err != nil {
		return nil, toError(err)
	}
	botID, err := NormalizeIdentifier(input.BotID, CodeCardInvalidSource, "Bot ID 无效")
	if err != nil {
		return nil, toError(err)
	}
	botUserID, err := NormalizeIdentifier(input.BotUserID, CodeCardInvalidOwner, "卡片所有者无效")
	if err != nil {
		return nil, toError(err)
	}
	if input.ExpectedRevision < 1 {
		return nil, NewError(CodeCardInvalidRevision, "卡片版本无效", 400)
	}
	actor, err := s.requireActor(ctx, s.repo, spaceID, botUserID, true)
	if err != nil {
		return nil, err
	}
	if actor.Kind != "bot" {
		return nil, NewError(CodeCardInvalidOwner, "卡片所有者无效", 403)
	}
	if err := s.requireCustomBot(ctx, s.repo, spaceID, botID, actor.ID); err != nil {
		return nil, err
	}
	var result *Card
	err = s.repo.WithTx(ctx, func(tx Tx) error {
		if err := s.recheckCustomBotWriter(ctx, tx, spaceID, botID, actor.ID); err != nil {
			return err
		}
		if err := tx.Lock(ctx, "workspace:card:bot-update:"+cardID); err != nil {
			return err
		}
		row, err := tx.GetCard(ctx, spaceID, cardID)
		if err != nil {
			return err
		}
		if row == nil || row.SourceKind != SourceCustomBot || stringValue(row.CreatedByUserID) != actor.ID {
			return notFoundError()
		}
		if s.effectiveStatus(row) != StatusActive {
			return notFoundError()
		}
		if !json.Valid(row.PayloadJSON) {
			return internalError("decode workspace card payload", invalidJSONPayload())
		}
		var payload any = json.RawMessage(row.PayloadJSON)
		if input.Payload != nil {
			payload = input.Payload
		}
		if len(input.RawPayload) > 0 {
			payload = input.RawPayload
		}
		definition := s.registry.Get(row.CardType, row.SchemaVersion)
		validated, err := s.validatePayload(row.PublicBlock(), payload, definition, true)
		if err != nil {
			return toError(err)
		}
		fallback := row.FallbackText
		if input.FallbackText != nil {
			fallback, err = NormalizeFallbackText(*input.FallbackText)
			if err != nil {
				return toError(err)
			}
		}
		updated, changed, err := tx.UpdateCard(ctx, row.ID, input.ExpectedRevision, validated, StatusActive, fallback, s.nowUTC())
		if err != nil {
			return err
		}
		if !changed || updated == nil {
			return conflictError(CodeCardRevisionConflict, "卡片版本已变化")
		}
		if err := s.writeEvent(ctx, tx, EventInput{SpaceID: row.SpaceID, Type: "card.updated", ActorID: actor.ID, ConversationID: stringValue(row.ConversationID), TargetType: "workspace.card", TargetID: row.ID, PayloadJSON: evidenceJSON(map[string]any{"cardId": row.ID, "cardType": row.CardType, "revision": updated.Revision, "status": updated.Status}), CreatedAt: s.nowUTC()}); err != nil {
			return err
		}
		if err := s.writeAudit(ctx, tx, actor, input.Meta, AuditInput{SpaceID: row.SpaceID, Action: "card.update", TargetType: "workspace.card", TargetID: row.ID, Result: "success", CreatedAt: s.nowUTC()}); err != nil {
			return err
		}
		result = s.publicCard(updated, definition, validated)
		return nil
	})
	if err != nil {
		return nil, normalizeError(err)
	}
	return result, nil
}

func (s *Service) recheckCustomBotWriter(ctx context.Context, tx Tx, spaceID, botID, actorID string) error {
	actor, err := s.requireActor(ctx, tx, spaceID, actorID, true)
	if err != nil {
		return err
	}
	if actor.Kind != "bot" {
		return NewError(CodeCardInvalidOwner, "卡片所有者无效", 403)
	}
	return s.requireCustomBot(ctx, tx, spaceID, botID, actor.ID)
}

func (s *Service) requireActor(ctx context.Context, repository ReadRepository, spaceID, actorID string, allowBot bool) (*auth.Actor, error) {
	actorID = strings.TrimSpace(actorID)
	if actorID == "" {
		return nil, authRequiredError()
	}
	actor, err := repository.LookupActor(ctx, spaceID, actorID)
	if err != nil {
		return nil, normalizeError(err)
	}
	if actor == nil || actor.ID != actorID {
		return nil, authRequiredError()
	}
	if actor.Kind == "human" {
		return actor, nil
	}
	if !allowBot || actor.Kind != "bot" {
		return nil, identityForbiddenError()
	}
	if _, ok := s.systemBotIDs[actor.ID]; ok {
		return actor, nil
	}
	if custom, ok := repository.(CustomBotAuthorizer); ok {
		active, err := custom.CustomBotActive(ctx, spaceID, "", actor.ID)
		if err != nil {
			return nil, normalizeError(err)
		}
		if active {
			return actor, nil
		}
	}
	return nil, notFoundError()
}

func (s *Service) requireCustomBot(ctx context.Context, repository ReadRepository, spaceID, botID, botUserID string) error {
	if strings.TrimSpace(botID) == "" {
		if _, ok := s.systemBotIDs[botUserID]; ok {
			return nil
		}
		return notFoundError()
	}
	custom, ok := repository.(CustomBotAuthorizer)
	if !ok {
		return notFoundError()
	}
	active, err := custom.CustomBotActive(ctx, spaceID, botID, botUserID)
	if err != nil {
		return normalizeError(err)
	}
	if !active {
		return notFoundError()
	}
	return nil
}

func (s *Service) assertVisible(ctx context.Context, repository ReadRepository, row *CardRecord, definition *CardDefinition, actor *auth.Actor, operation string, request Request) error {
	if row.VisibilityScope == VisibilityConversation {
		if row.ConversationID == nil {
			return notFoundError()
		}
		ok, err := repository.ConversationMemberActive(ctx, row.SpaceID, *row.ConversationID, actor.ID)
		if err != nil {
			return normalizeError(err)
		}
		if !ok {
			return notFoundError()
		}
	}
	if row.VisibilityScope == VisibilityResource && (row.ResourceType == nil || row.ResourceID == nil || definition == nil || definition.Authorize == nil) {
		return notFoundError()
	}
	if definition != nil && definition.Authorize != nil {
		allowed, err := definition.Authorize(ctx, CardAuthorization{Actor: actor, Card: s.publicCardValue(row, definition, nil, s.effectiveStatus(row)), Operation: operation, Request: request})
		if err != nil {
			return toError(err)
		}
		if !allowed {
			return notFoundError()
		}
	}
	return nil
}

func (s *Service) finishFailed(ctx context.Context, tx Tx, runID string, actor *auth.Actor, row *CardRecord, actionID string, meta auth.RequestMeta, err error) error {
	domain := toError(err)
	if failErr := tx.FailActionRun(ctx, runID, domain.Code, s.nowUTC()); failErr != nil {
		return failErr
	}
	if actor != nil {
		if auditErr := s.writeAudit(ctx, tx, actor, meta, AuditInput{SpaceID: row.SpaceID, Action: "card.action." + actionID, TargetType: "workspace.card", TargetID: row.ID, Result: "rejected", Reason: domain.Code, CreatedAt: s.nowUTC()}); auditErr != nil {
			return auditErr
		}
	}
	return rejection{err: domain}
}

func (s *Service) rejected(ctx context.Context, tx Tx, actor *auth.Actor, _ *CardAction, meta auth.RequestMeta, action, target string, err error, row *CardRecord) error {
	domain := toError(err)
	if actor != nil && row != nil {
		if auditErr := s.writeAudit(ctx, tx, actor, meta, AuditInput{SpaceID: row.SpaceID, Action: action, TargetType: "workspace.card", TargetID: target, Result: "rejected", Reason: domain.Code, CreatedAt: s.nowUTC()}); auditErr != nil {
			return auditErr
		}
	}
	return rejection{err: domain}
}

type rejection struct{ err error }

// actionSavepointRejection is deliberately private. It marks an error from
// the savepoint callback as a controlled card/domain rejection; the savepoint
// implementation can therefore roll back action effects before the outer
// transaction records the failed run and content-free audit. Infrastructure
// errors are returned unwrapped and abort the outer transaction instead.
type actionSavepointRejection struct{ err error }

func (r actionSavepointRejection) Error() string {
	if r.err == nil {
		return ""
	}
	return r.err.Error()
}

func (r actionSavepointRejection) Unwrap() error { return r.err }

func isActionRejection(err error) bool {
	if err == nil {
		return false
	}
	var domainErr *Error
	if errors.As(err, &domainErr) {
		return domainErr != nil && domainErr.Code != CodeInternal && domainErr.StatusCode >= 400 && domainErr.StatusCode < 500
	}
	var validationErr *CardValidationError
	return errors.As(err, &validationErr) && validationErr != nil
}

func (r rejection) Error() string {
	if r.err == nil {
		return ""
	}
	return r.err.Error()
}

func (s *Service) writeAudit(ctx context.Context, tx Tx, actor *auth.Actor, meta auth.RequestMeta, input AuditInput) error {
	meta = meta.Safe()
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

func (s *Service) publicCard(row *CardRecord, definition *CardDefinition, payload any) *Card {
	if row == nil {
		return nil
	}
	if payload == nil {
		payload, _ = decodeJSON(row.PayloadJSON)
	}
	return s.publicCardValue(row, definition, payload, s.effectiveStatus(row)).ptr()
}
func (s *Service) publicCardValue(row *CardRecord, definition *CardDefinition, payload any, status CardStatus) Card {
	if payload == nil {
		payload, _ = decodeJSON(row.PayloadJSON)
	}
	actions := make([]string, 0)
	if definition != nil {
		for id := range definition.Actions {
			actions = append(actions, id)
		}
	}
	sortStrings(actions)
	return Card{ID: row.ID, SpaceID: row.SpaceID, ConversationID: row.ConversationID, Block: row.PublicBlock(), Payload: payload, Status: status, Revision: row.Revision, ExpiresAt: formatOptional(row.ExpiresAt), CreatedAt: formatTimestamp(row.CreatedAt), UpdatedAt: formatTimestamp(row.UpdatedAt), Actions: actions}
}
func (c Card) ptr() *Card { return &c }
func (s *Service) resolutionFromCard(card *Card) Resolution {
	return Resolution{Type: CardBlockType, Block: card.Block, ID: card.ID, SpaceID: card.SpaceID, ConversationID: card.ConversationID, Payload: card.Payload, Status: card.Status, Revision: card.Revision, ExpiresAt: card.ExpiresAt, CreatedAt: card.CreatedAt, UpdatedAt: card.UpdatedAt, Actions: card.Actions}
}

func (s *Service) validatePayload(block CardBlock, payload any, definition *CardDefinition, allowUnknown bool) (any, error) {
	if definition == nil {
		if !allowUnknown {
			return nil, unknownVersionError()
		}
		if raw, ok := payload.(json.RawMessage); ok {
			return normalizeJSONPayload(raw, DefaultLimits, false)
		}
		safe, err := NormalizeCardPayload(payload, DefaultLimits, false)
		if err != nil {
			return nil, err
		}
		return safe, nil
	}
	validated, err := s.registry.ValidatePayload(block, payload)
	if err != nil {
		return nil, err
	}
	return validated.Payload, nil
}

func (s *Service) newBlock(input CreateInput) (CardBlock, error) {
	id := strings.TrimSpace(input.CardID)
	if id == "" {
		id = "pending"
	}
	block := CardBlock{Type: CardBlockType, CardID: id, CardType: input.CardType, SchemaVersion: input.SchemaVersion, FallbackText: input.FallbackText}
	if id == "pending" {
		block.CardID = "card_pending"
	}
	return NormalizeCardBlock(block)
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
	id, err := s.idFactory()
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(id) == "" {
		return "", errors.New(operation + " id factory returned an empty id")
	}
	return strings.TrimSpace(id), nil
}
func (s *Service) effectiveStatus(row *CardRecord) CardStatus {
	if row == nil {
		return StatusInvalidated
	}
	if row.Status == StatusActive && row.ExpiresAt != nil && !row.ExpiresAt.After(s.nowUTC()) {
		return StatusExpired
	}
	return row.Status
}

func normalizeSourceKind(value SourceKind) (SourceKind, error) {
	switch value {
	case SourceWorkspace, SourceSystemBot, SourceCustomBot, SourceEcho, SourceTopic:
		return value, nil
	}
	return "", NewError(CodeCardInvalidSource, "卡片来源无效", 400)
}
func normalizeVisibility(value VisibilityScope) (VisibilityScope, error) {
	switch value {
	case VisibilitySpace, VisibilityConversation, VisibilityResource:
		return value, nil
	}
	return "", NewError(CodeCardInvalidVisibility, "卡片可见范围无效", 400)
}
func normalizeOptional(value, code, message string) (*string, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	normalized, err := NormalizeIdentifier(value, code, message)
	if err != nil {
		return nil, err
	}
	return &normalized, nil
}
func sourceKey(sourceID *string, cardID string) string {
	if sourceID != nil {
		return *sourceID
	}
	return cardID
}
func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copied := value.UTC().Truncate(time.Millisecond)
	return &copied
}
func formatOptional(value *time.Time) *string {
	if value == nil {
		return nil
	}
	result := formatTimestamp(*value)
	return &result
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
func evidenceJSON(value map[string]any) []byte { return mustJSON(value) }
func hashRequest(value any) string {
	encoded := canonicalJSON(value)
	sum := sha256.Sum256(encoded)
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
		var b strings.Builder
		b.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			b.Write(mustJSON(key))
			b.WriteByte(':')
			b.Write(canonicalJSON(typed[key]))
		}
		b.WriteByte('}')
		return []byte(b.String())
	case []any:
		var b strings.Builder
		b.WriteByte('[')
		for i, child := range typed {
			if i > 0 {
				b.WriteByte(',')
			}
			b.Write(canonicalJSON(child))
		}
		b.WriteByte(']')
		return []byte(b.String())
	default:
		return mustJSON(value)
	}
}
func cardMatches(a, b CardRecord) bool {
	return a.SpaceID == b.SpaceID && a.CardType == b.CardType && a.SchemaVersion == b.SchemaVersion && a.FallbackText == b.FallbackText && a.SourceKind == b.SourceKind && stringValue(a.SourceID) == stringValue(b.SourceID) && stringValue(a.ConversationID) == stringValue(b.ConversationID) && stringValue(a.ResourceType) == stringValue(b.ResourceType) && stringValue(a.ResourceID) == stringValue(b.ResourceID) && stringValue(a.CreatedByUserID) == stringValue(b.CreatedByUserID) && jsonEqual(a.PayloadJSON, b.PayloadJSON)
}
func jsonEqual(a, b []byte) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return string(a) == string(b)
	}
	return string(canonicalJSON(x)) == string(canonicalJSON(y))
}
func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
func toError(err error) *Error {
	if err == nil {
		return nil
	}
	var domain *Error
	if errors.As(err, &domain) {
		return domain
	}
	var validation *CardValidationError
	if errors.As(err, &validation) {
		return NewError(validation.Code, validation.Message, 422)
	}
	return internalError("workspace card operation", err)
}
