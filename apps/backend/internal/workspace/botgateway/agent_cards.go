package botgateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"
)

type agentCardUpdater interface {
	UpdateCustomBotCardInTx(context.Context, Tx, CardUpdateRequest) (Card, error)
}
type agentCardBinding interface {
	AgentTaskOwnsCard(context.Context, string, string) (bool, error)
}

func (s *Service) updateAgentCard(ctx context.Context, current *Auth, input CardUpdateRequest) (Card, error) {
	if AgentTaskID(ctx) == "" {
		return s.cardGateway.UpdateCustomBotCard(ctx, input)
	}
	updater, ok := s.cardGateway.(agentCardUpdater)
	if !ok {
		return Card{}, NewError("card.unavailable", "任务卡片修改尚未就绪", 503)
	}
	if input.ExpectedRevision < 1 {
		return Card{}, NewError(CodeCardInvalidVersion, "修改卡片需要当前版本", 400)
	}
	digest := sha256.Sum256([]byte(input.CardID + ":" + strconv.FormatInt(input.ExpectedRevision, 10)))
	key := "card_" + hex.EncodeToString(digest[:])
	hashInput := map[string]any{"cardId": input.CardID, "expectedRevision": input.ExpectedRevision, "payload": input.Payload, "rawPayload": json.RawMessage(input.RawPayload), "fallbackText": input.FallbackText}
	result, err := s.withIdempotency(ctx, current, "card.update", key, hashInput, func(tx Tx) (any, error) {
		binding, ok := tx.(agentCardBinding)
		if !ok {
			return nil, taskForbidden()
		}
		owned, err := binding.AgentTaskOwnsCard(ctx, AgentTaskID(ctx), input.CardID)
		if err != nil {
			return nil, err
		}
		if !owned {
			return nil, taskForbidden()
		}
		card, err := updater.UpdateCustomBotCardInTx(ctx, tx, input)
		if err != nil {
			return nil, err
		}
		return map[string]any{"card": card}, nil
	})
	if err != nil {
		return Card{}, err
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return Card{}, err
	}
	var response struct {
		Card Card `json:"card"`
	}
	if err := json.Unmarshal(encoded, &response); err != nil {
		return Card{}, err
	}
	return response.Card, nil
}

func (t *pgTx) AgentTaskOwnsCard(ctx context.Context, taskID, cardID string) (bool, error) {
	var owns bool
	err := t.tx.QueryRow(ctx, `SELECT EXISTS(
 SELECT 1 FROM workspace_agent_task_operations o
 JOIN workspace_agent_bot_idempotency i ON i.bot_id=o.bot_id AND i.operation=o.operation AND i.idempotency_key=o.idempotency_key
 JOIN messages m ON m.id=(i.response_json::jsonb#>>'{message,id}')
 WHERE o.task_id=$1 AND o.operation='card.send'
 AND i.response_json::jsonb#>>'{card,id}'=$2
 AND m.deleted_at IS NULL AND m.recalled_at IS NULL AND m.topic_id IS NULL
 )`, taskID, cardID).Scan(&owns)
	if err != nil {
		return false, internalError("check task card ownership", err)
	}
	return owns, nil
}
