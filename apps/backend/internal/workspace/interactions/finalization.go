package interactions

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
)

const postCommitFinalizableCommand = "release"

// FinalizeCommandResult persists the one authoritative post-commit result for
// a successful release command. It deliberately replays command recognition
// and request hashing inside the interaction service: runtime adapters pass
// the original trusted execution input, never a client-provided hash or
// command name.
//
// Finalization is separate from ExecuteCommand's acceptance transaction. The
// acceptance transaction remains responsible for the domain mutation and the
// durable delivery rows; this method only freezes the result after delivery
// has produced its authoritative summary.
func (s *Service) FinalizeCommandResult(ctx context.Context, input FinalizeCommandResultInput) (CommandOutcome, error) {
	if s == nil || s.repo == nil {
		return CommandOutcome{}, internalError("finalize workspace command result", errors.New("repository is required"))
	}
	if ctx == nil {
		return CommandOutcome{}, internalError("finalize workspace command result", errors.New("context is required"))
	}

	execution, err := normalizeFinalizationExecution(input.Execution)
	if err != nil {
		return CommandOutcome{}, err
	}
	var finalized CommandOutcome
	var operationErr error
	if err := s.repo.WithTx(ctx, func(tx Tx) error {
		if err := tx.Lock(ctx, commandLockKey(execution.SpaceID, execution.ActorID, execution.ClientInvocationID)); err != nil {
			return err
		}
		actor, err := s.requireActor(ctx, tx, execution.SpaceID, execution.ActorID)
		if err != nil {
			operationErr = err
			return nil
		}
		binding, err := s.finalizationBinding(ctx, tx, execution)
		if err != nil {
			operationErr = err
			return nil
		}
		current, err := tx.GetCommandRun(ctx, execution.SpaceID, actor.ID, execution.ClientInvocationID)
		if err != nil {
			return err
		}
		if current == nil {
			operationErr = conflict(CodeCommandIdempotencyConflict, "调用标识未找到可完成的命令")
			return nil
		}
		if current.ActorUserID != actor.ID || current.SpaceID != execution.SpaceID || current.ClientInvocationID != execution.ClientInvocationID {
			operationErr = permissionDeniedError()
			return nil
		}
		if current.RequestHash != binding.requestHash || current.CommandName != postCommitFinalizableCommand {
			operationErr = conflict(CodeCommandIdempotencyConflict, "调用标识已用于其他命令")
			return nil
		}
		if current.Status != "succeeded" {
			operationErr = conflict(CodeCommandInProgress, "命令尚未完成")
			return nil
		}
		if current.ResultFinalizedAt != nil {
			finalized, err = frozenCommandOutcome(current, input.Original.Replayed)
			return err
		}
		if !input.Original.OK || input.Original.Result == nil {
			operationErr = conflict(CodeCommandIdempotencyConflict, "命令原始结果无效")
			return nil
		}
		expectedOriginal, _, err := normalizeFinalizationResult(input.Original.Result)
		if err != nil {
			operationErr = conflict(CodeCommandIdempotencyConflict, "命令原始结果无效")
			return nil
		}
		if !bytes.Equal(canonicalJSON(expectedOriginal), canonicalJSONFromJSON(current.ResultJSON)) {
			operationErr = conflict(CodeCommandIdempotencyConflict, "命令原始结果不匹配")
			return nil
		}
		result, resultJSON, err := normalizeFinalizationResult(input.Result)
		if err != nil {
			return wrapInfrastructureFailure(err, "validate finalized command result")
		}
		if err := validateReleaseFinalizationResult(expectedOriginal, result); err != nil {
			operationErr = conflict(CodeCommandIdempotencyConflict, "命令结果不可冻结")
			return nil
		}
		updated, changed, err := tx.FinalizeCommandRun(ctx, current.ID, resultJSON, s.nowUTC())
		if err != nil {
			return err
		}
		if !changed || updated == nil || updated.ResultFinalizedAt == nil {
			latest, readErr := tx.GetCommandRun(ctx, execution.SpaceID, actor.ID, execution.ClientInvocationID)
			if readErr != nil {
				return readErr
			}
			if latest != nil && latest.ResultFinalizedAt != nil {
				finalized, readErr = frozenCommandOutcome(latest, input.Original.Replayed)
				return readErr
			}
			return errors.New("command result finalization did not update a succeeded run")
		}
		finalized = CommandOutcome{OK: true, Replayed: input.Original.Replayed, Result: result, ResultCardID: updated.ResultCardID, ResultFinalized: true}
		return nil
	}); err != nil {
		return CommandOutcome{}, normalizeError(err)
	}
	if operationErr != nil {
		return CommandOutcome{}, operationErr
	}
	return finalized, nil
}

type finalizationBinding struct {
	requestHash string
}

func (s *Service) finalizationBinding(ctx context.Context, tx Tx, input ExecuteCommandInput) (finalizationBinding, error) {
	conversation, err := tx.GetConversation(ctx, input.SpaceID, input.ConversationID)
	if err != nil {
		return finalizationBinding{}, normalizeError(err)
	}
	if conversation == nil {
		return finalizationBinding{}, conflict(CodeCommandIdempotencyConflict, "调用标识已用于其他命令")
	}
	if ok, err := tx.ConversationMemberActive(ctx, input.SpaceID, input.ConversationID, input.ActorID); err != nil {
		return finalizationBinding{}, normalizeError(err)
	} else if !ok {
		return finalizationBinding{}, permissionDeniedError()
	}
	if ok, err := tx.BotMemberActive(ctx, input.SpaceID, input.ConversationID, input.BotUserID); err != nil {
		return finalizationBinding{}, normalizeError(err)
	} else if !ok {
		return finalizationBinding{}, botNotAvailableError()
	}
	if s.commands == nil {
		return finalizationBinding{}, internalError("finalize workspace command result", errors.New("command registry is required"))
	}
	recognized, err := s.commands.Recognize(input.Source, RecognitionContext{ConversationType: conversation.Type, BotUserID: input.BotUserID, MentionedBotIDs: input.MentionedBotIDs})
	if err != nil {
		return finalizationBinding{}, toError(err, CodeCommandFailed, "命令结果绑定失败")
	}
	if recognized == nil || recognized.Type != "command" || recognized.Definition == nil || recognized.Name != postCommitFinalizableCommand {
		return finalizationBinding{}, conflict(CodeCommandIdempotencyConflict, "调用标识已用于其他命令")
	}
	return finalizationBinding{requestHash: hashRequest(map[string]any{
		"spaceId":        input.SpaceID,
		"conversationId": input.ConversationID,
		"botUserId":      input.BotUserID,
		"command":        recognized.Definition.Name,
		"version":        recognized.Definition.Version,
		"arguments":      recognized.Arguments,
	})}, nil
}

func normalizeFinalizationExecution(input ExecuteCommandInput) (ExecuteCommandInput, error) {
	spaceID, err := normalizeID(input.SpaceID, CodeSpaceInvalid, "空间 ID 无效")
	if err != nil {
		return ExecuteCommandInput{}, err
	}
	conversationID, err := normalizeID(input.ConversationID, CodeConversationInvalid, "会话 ID 无效")
	if err != nil {
		return ExecuteCommandInput{}, err
	}
	botID, err := normalizeID(input.BotUserID, "bot.invalid_id", "Bot ID 无效")
	if err != nil {
		return ExecuteCommandInput{}, err
	}
	actorID := strings.TrimSpace(input.ActorID)
	if actorID == "" {
		return ExecuteCommandInput{}, authRequiredError()
	}
	invocationID, err := normalizeID(input.ClientInvocationID, CodeCommandInvalidInvocation, "客户端调用 ID 无效")
	if err != nil {
		return ExecuteCommandInput{}, err
	}
	input.ActorID = actorID
	input.SpaceID = spaceID
	input.ConversationID = conversationID
	input.BotUserID = botID
	input.ClientInvocationID = invocationID
	return input, nil
}

func normalizeFinalizationResult(value any) (any, []byte, error) {
	if value == nil {
		value = map[string]any{}
	}
	safe, err := cards.NormalizeCardPayload(value, cards.Limits{MaxPayloadBytes: 32 * 1024, MaxDepth: 8, MaxNodes: 200, MaxTextBytes: 16 * 1024}, false)
	if err != nil {
		return nil, nil, err
	}
	encoded, err := json.Marshal(safe)
	if err != nil {
		return nil, nil, err
	}
	return safe, encoded, nil
}

var releaseFinalizationCountFields = [...]string{
	"recipientCount",
	"pendingCount",
	"sentCount",
	"failedCount",
	"skippedCount",
}

// validateReleaseFinalizationResult constrains the post-commit result to the
// fields that delivery is allowed to change. The original result is the
// trusted, transaction-persisted identity; the candidate may change only the
// five delivery counts, and each count must describe the same recipient set.
func validateReleaseFinalizationResult(original, candidate any) error {
	originalObject, ok := original.(map[string]any)
	if !ok {
		return errors.New("release original result must be an object")
	}
	candidateObject, ok := candidate.(map[string]any)
	if !ok {
		return errors.New("release finalized result must be an object")
	}
	if stringValueFromMap(originalObject["type"]) != "release-published" || stringValueFromMap(candidateObject["type"]) != "release-published" {
		return errors.New("release result type is not release-published")
	}
	if !bytes.Equal(releaseFinalizationNonCountJSON(originalObject), releaseFinalizationNonCountJSON(candidateObject)) {
		return errors.New("release result identity changed")
	}
	if !validReleaseFinalizationCounts(originalObject) || !validReleaseFinalizationCounts(candidateObject) {
		return errors.New("release result counts are invalid")
	}
	return nil
}

func validReleaseFinalizationCounts(object map[string]any) bool {
	recipient, ok := safeReleaseFinalizationCount(object[releaseFinalizationCountFields[0]])
	if !ok {
		return false
	}
	var total uint64
	for _, field := range releaseFinalizationCountFields[1:] {
		count, ok := safeReleaseFinalizationCount(object[field])
		if !ok || count > ^uint64(0)-total {
			return false
		}
		total += count
	}
	return total == recipient
}

func safeReleaseFinalizationCount(value any) (uint64, bool) {
	const maxCount = uint64(9007199254740991)
	switch typed := value.(type) {
	case int:
		if typed < 0 || uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case int8:
		if typed < 0 || uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case int16:
		if typed < 0 || uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case int32:
		if typed < 0 || uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case int64:
		if typed < 0 || uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case uint:
		if uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case uint8:
		if uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case uint16:
		if uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case uint32:
		if uint64(typed) > maxCount {
			return 0, false
		}
		return uint64(typed), true
	case uint64:
		if typed > maxCount {
			return 0, false
		}
		return typed, true
	case float32:
		return safeReleaseFinalizationFloat(float64(typed), maxCount)
	case float64:
		return safeReleaseFinalizationFloat(typed, maxCount)
	case json.Number:
		parsed, err := strconv.ParseUint(string(typed), 10, 53)
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func safeReleaseFinalizationFloat(value float64, maxCount uint64) (uint64, bool) {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || math.Trunc(value) != value || value > float64(maxCount) {
		return 0, false
	}
	return uint64(value), true
}

func releaseFinalizationNonCountJSON(object map[string]any) []byte {
	copy := make(map[string]any, len(object))
	for key, value := range object {
		if !isReleaseFinalizationCountField(key) {
			copy[key] = value
		}
	}
	return canonicalJSON(copy)
}

func isReleaseFinalizationCountField(key string) bool {
	for _, field := range releaseFinalizationCountFields {
		if key == field {
			return true
		}
	}
	return false
}

func stringValueFromMap(value any) string {
	text, _ := value.(string)
	return text
}

func canonicalJSONFromJSON(raw []byte) []byte {
	value, err := decodeJSON(raw)
	if err != nil {
		return nil
	}
	return canonicalJSON(value)
}

func frozenCommandOutcome(record *CommandRunRecord, replayed bool) (CommandOutcome, error) {
	if record == nil || record.ResultFinalizedAt == nil {
		return CommandOutcome{}, errors.New("frozen command result is unavailable")
	}
	result, err := decodeJSON(record.ResultJSON)
	if err != nil {
		return CommandOutcome{}, err
	}
	return CommandOutcome{OK: true, Replayed: replayed, Result: result, ResultCardID: record.ResultCardID, ResultFinalized: true}, nil
}

func commandLockKey(spaceID, actorID, invocationID string) string {
	return "workspace:command:" + spaceID + ":" + actorID + ":" + invocationID
}
