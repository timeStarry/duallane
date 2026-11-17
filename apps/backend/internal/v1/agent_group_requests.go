package v1

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

type GroupBotRequest struct {
	BotID        string `json:"botId"`
	Name         string `json:"name"`
	Status       string `json:"status"`
	AllowContext bool   `json:"allowContext"`
	MaxMessages  *int   `json:"maxMessages"`
}

type GroupBotRequests struct {
	CanManage bool              `json:"canManage"`
	Requests  []GroupBotRequest `json:"requests"`
	HasMore   bool              `json:"hasMore"`
}

type groupBotRequestsReader interface {
	ListGroupBotRequests(context.Context, string, string) (GroupBotRequests, error)
}

func (s *Service) ListGroupBotRequests(ctx context.Context, actorID, conversationID string) (GroupBotRequests, error) {
	if strings.TrimSpace(actorID) == "" || strings.TrimSpace(conversationID) == "" {
		return GroupBotRequests{}, ErrNotFound
	}
	reader, ok := s.repo.(groupBotRequestsReader)
	if !ok {
		return GroupBotRequests{Requests: []GroupBotRequest{}}, nil
	}
	return reader.ListGroupBotRequests(ctx, actorID, conversationID)
}

func (r *PGRepository) ListGroupBotRequests(ctx context.Context, actorID, conversationID string) (GroupBotRequests, error) {
	result := GroupBotRequests{Requests: []GroupBotRequest{}}
	var kind, groupRole, spaceRole string
	err := r.pool.QueryRow(ctx, `SELECT c.type,cm.role,sm.role FROM conversations c
	 JOIN conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=$1 AND cm.removed_at IS NULL
	 JOIN space_members sm ON sm.user_id=$1 AND sm.space_id=c.space_id AND sm.removed_at IS NULL
	 JOIN users u ON u.id=$1 AND u.kind='human'
	 WHERE c.id=$2 AND c.space_id=$3`, actorID, conversationID, r.spaceID).Scan(&kind, &groupRole, &spaceRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, ErrNotFound
	}
	if err != nil {
		return result, err
	}
	if kind != "group" {
		return result, ErrNotFound
	}
	result.CanManage = (groupRole == "owner" || groupRole == "admin") && spaceRole != "auditor"
	if !result.CanManage {
		return result, nil
	}
	rows, err := r.pool.Query(ctx, `SELECT b.id,b.name,p.status,COALESCE(g.allow_context,0)=1,g.max_messages
	 FROM workspace_agent_bot_group_policies p JOIN workspace_agent_bots b ON b.id=p.bot_id AND b.space_id=p.space_id
	 JOIN workspace_agent_bot_settings s ON s.bot_id=b.id AND s.space_id=b.space_id
	 JOIN conversation_members owner_member ON owner_member.conversation_id=p.conversation_id AND owner_member.user_id=b.owner_user_id AND owner_member.removed_at IS NULL
	 LEFT JOIN workspace_agent_bot_context_grants g ON g.bot_id=b.id AND g.space_id=b.space_id AND g.conversation_id=p.conversation_id
	 WHERE p.space_id=$1 AND p.conversation_id=$2 AND p.status='pending' AND p.invited_by=b.owner_user_id
	 AND b.status='active' AND s.allow_group=1 ORDER BY p.created_at,b.id LIMIT 101`, r.spaceID, conversationID)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var request GroupBotRequest
		if err := rows.Scan(&request.BotID, &request.Name, &request.Status, &request.AllowContext, &request.MaxMessages); err != nil {
			return result, err
		}
		result.Requests = append(result.Requests, request)
	}
	if err := rows.Err(); err != nil {
		return result, err
	}
	if len(result.Requests) > 100 {
		result.HasMore = true
		result.Requests = result.Requests[:100]
	}
	return result, nil
}

func (h *HTTPHandler) handleGroupBotRequests(w http.ResponseWriter, r *http.Request) {
	result, err := h.service.ListGroupBotRequests(r.Context(), actorFromContext(r.Context()).ID, chi.URLParam(r, "conversationId"))
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, 200, result)
}
