package botgateway

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

const MaxAgentAttachmentContentBytes int64 = 10 * 1024 * 1024
const MaxAgentAttachmentPreviewBytes int64 = 64 * 1024

type AttachmentReadInput struct {
	ConversationID string
	AttachmentID   string
	MessageID      string
	Mode           string
	Meta           auth.RequestMeta
}

// AuthorizeAttachmentRead binds a binary read to a currently visible source
// message. A guessed attachment ID or an old local artifact index is not a grant.
func (s *Service) AuthorizeAttachmentRead(ctx context.Context, value *Auth, input AttachmentReadInput) (Attachment, error) {
	current, err := s.ValidateAuth(ctx, value)
	if err != nil {
		return Attachment{}, err
	}
	attachment, err := s.authorizeAttachmentRead(ctx, current, input)
	if err == nil {
		return attachment, nil
	}
	var domain *Error
	if !errors.As(err, &domain) {
		return Attachment{}, err
	}
	// Denials are content-free; arbitrary query strings and filenames never enter
	// audit. Audit persistence must succeed before the safe rejection is returned.
	auditErr := s.repo.WithTx(ctx, func(tx Tx) error {
		id, idErr := s.newID("bot attachment rejection")
		if idErr != nil {
			return idErr
		}
		meta := input.Meta.Safe()
		return tx.WriteAudit(ctx, AuditInput{ID: "aud_" + id, SpaceID: current.SpaceID, ActorUserID: current.UserID, Action: "bot.gateway.attachment.read", TargetType: "attachment", Result: "rejected", Reason: domain.Code, RequestID: meta.RequestID, IPAddress: meta.IPAddress, UserAgent: meta.UserAgent, CreatedAt: s.nowUTC()})
	})
	if auditErr != nil {
		return Attachment{}, normalizeError(auditErr)
	}
	return Attachment{}, err
}

func (s *Service) authorizeAttachmentRead(ctx context.Context, current *Auth, input AttachmentReadInput) (Attachment, error) {
	mode := strings.TrimSpace(input.Mode)
	if mode == "" {
		mode = "content"
	}
	scope := ScopeFilesReadContent
	if mode == "preview" {
		scope = ScopeFilesReadPreview
	} else if mode != "content" {
		return Attachment{}, NewError(CodeInvalidRequest, "文件读取模式无效", 400)
	}
	if err := RequireScope(current, scope); err != nil {
		return Attachment{}, err
	}
	if err := RequireScope(current, ScopeMessagesReadContext); err != nil {
		return Attachment{}, err
	}
	if _, err := s.RequireContextGrant(ctx, current, input.ConversationID); err != nil {
		return Attachment{}, err
	}
	attachmentID, err := normalizeIdentifier(input.AttachmentID, CodeAttachmentInvalid)
	if err != nil {
		return Attachment{}, err
	}
	messageID, err := normalizeIdentifier(input.MessageID, CodeInvalidRequest)
	if err != nil {
		return Attachment{}, err
	}
	var visible []ContextMessage
	if AgentTaskID(ctx) != "" {
		if err := s.AuthorizeAgentOperation(ctx, current, input.ConversationID); err != nil {
			return Attachment{}, err
		}
		result, readErr := s.GetAgentMessage(ctx, current, messageID)
		if readErr != nil {
			return Attachment{}, readErr
		}
		visible = []ContextMessage{result["message"].(ContextMessage)}
	} else {
		contextResult, readErr := s.GetContext(ctx, current, input.ConversationID, nil)
		if readErr != nil {
			return Attachment{}, readErr
		}
		visible = contextResult["messages"].([]ContextMessage)
	}
	linked := false
	for _, message := range visible {
		if message.ID != messageID {
			continue
		}
		encoded, _ := json.Marshal(message.Content)
		var content struct {
			Blocks []struct {
				Type string `json:"type"`
				ID   string `json:"attachmentId"`
			} `json:"blocks"`
		}
		if json.Unmarshal(encoded, &content) == nil {
			for _, block := range content.Blocks {
				linked = linked || (block.Type == "attachment" && block.ID == attachmentID)
			}
		}
	}
	if !linked {
		return Attachment{}, NewError(CodeAttachmentNotFound, MessageAttachmentNotFound, 404)
	}
	row, err := s.repo.GetAttachment(ctx, current.SpaceID, attachmentID)
	if err != nil {
		return Attachment{}, normalizeError(err)
	}
	if row == nil || row.SpaceID != current.SpaceID || row.Status != "available" || row.Visibility != "conversation" || row.ConversationID == nil || *row.ConversationID != strings.TrimSpace(input.ConversationID) {
		return Attachment{}, NewError(CodeAttachmentNotFound, MessageAttachmentNotFound, 404)
	}
	limit := MaxAgentAttachmentContentBytes
	allowed := false
	switch strings.ToLower(row.MIMEType) {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "application/pdf",
		"text/markdown", "text/csv", "text/html", "text/css", "text/javascript", "application/javascript",
		"text/xml", "application/xml", "application/json",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation":
		allowed = true
	}
	if mode == "preview" {
		settings, settingsErr := s.repo.GetSettings(ctx, current.BotID, current.SpaceID)
		if settingsErr != nil {
			return Attachment{}, normalizeError(settingsErr)
		}
		if settings == nil || !settings.AllowAttachmentPreview {
			return Attachment{}, NewError(CodeContextForbidden, MessageContextForbidden, 403)
		}
		limit = MaxAgentAttachmentPreviewBytes
		allowed = row.MIMEType == "text/plain"
	}
	if !allowed {
		return Attachment{}, NewError("file.unsupported_type", "该文件格式不支持机器人读取", 415)
	}
	if row.ByteSize < 0 || row.ByteSize > limit {
		return Attachment{}, NewError("file.too_large", "文件超过机器人读取上限", 413)
	}
	if err := s.consumeAgentRead(ctx, current, input.ConversationID, row.ByteSize); err != nil {
		return Attachment{}, err
	}
	return projectAttachment(*row), nil
}
