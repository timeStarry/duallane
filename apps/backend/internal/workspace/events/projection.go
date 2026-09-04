package events

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// ProjectEventPayload refreshes references whose public shape depends on
// current state. The returned map is still passed through service.go's
// allowlist, so database rows never become transport JSON directly.
func (r *PGRepository) ProjectEventPayload(ctx context.Context, actor *auth.Actor, event EventRecord, payload map[string]any) (map[string]any, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("project workspace event", errors.New("workspace postgres pool is required"))
	}
	projected := clonePayload(payload)
	switch event.Type {
	case "workspace.member_joined", "workspace.member_updated", "conversation.member_added":
		userID := stringField(projected, "userId")
		if userID == "" {
			userID = pointerString(event.TargetID)
		}
		if userID != "" {
			member, err := r.publicMemberPayload(ctx, event.SpaceID, actor, userID)
			if err != nil {
				return nil, err
			}
			if member != nil {
				projected["member"] = member
			}
		}
	case "conversation.created", "conversation.updated", "conversation.notification_updated":
		conversationID := stringField(projected, "conversationId")
		if conversationID == "" {
			conversationID = pointerString(event.ConversationID)
		}
		if conversationID != "" {
			conversation, err := r.publicConversationPayload(ctx, event.SpaceID, actor, conversationID)
			if err != nil {
				return nil, err
			}
			if conversation != nil {
				projected["conversation"] = conversation
			}
		}
	case "message.created", "message.recalled":
		messageID := stringField(projected, "messageId")
		if messageID == "" {
			messageID = pointerString(event.TargetID)
		}
		if messageID != "" {
			message, err := r.publicMessagePayload(ctx, event.SpaceID, actor, messageID)
			if err != nil {
				return nil, err
			}
			if message != nil {
				projected["message"] = message
			}
		}
		conversationID := stringField(projected, "conversationId")
		if conversationID == "" {
			if message, ok := projected["message"].(map[string]any); ok {
				conversationID = stringField(message, "conversationId")
			}
		}
		if conversationID != "" {
			conversation, err := r.publicConversationPayload(ctx, event.SpaceID, actor, conversationID)
			if err != nil {
				return nil, err
			}
			if conversation != nil {
				projected["conversation"] = conversation
			}
		}
	case "attachment.created", "attachment.available", "attachment.failed", "attachment.removed":
		attachmentID := stringField(projected, "attachmentId")
		if attachmentID == "" && event.TargetID != nil {
			attachmentID = *event.TargetID
		}
		if attachmentID != "" {
			attachment, err := r.publicAttachmentPayload(ctx, event.SpaceID, actor, attachmentID)
			if err != nil {
				return nil, err
			}
			if attachment != nil {
				projected["attachment"] = attachment
			}
		}
	}
	return projected, nil
}

func (r *PGRepository) publicMemberPayload(ctx context.Context, spaceID string, actor *auth.Actor, userID string) (map[string]any, error) {
	if actor == nil {
		return nil, nil
	}
	var id, githubLogin, displayName, kind, role string
	var nickname, remark, avatarURL, recallReason *string
	var discoverable bool
	var joinedAt time.Time
	err := r.pool.QueryRow(ctx, `
		SELECT u.id, u.github_login, u.display_name, u.nickname, ur.remark,
			u.avatar_url, u.search_discoverable, u.recall_reason, u.kind,
			sm.role, sm.joined_at
		FROM users u
		INNER JOIN space_members sm ON sm.user_id = u.id
		LEFT JOIN user_remarks ur ON ur.owner_user_id = $3 AND ur.target_user_id = u.id
		WHERE u.id = $1 AND sm.space_id = $2 AND sm.removed_at IS NULL
	`, userID, spaceID, actor.ID).Scan(&id, &githubLogin, &displayName, &nickname, &remark, &avatarURL,
		&discoverable, &recallReason, &kind, &role, &joinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("project workspace member event", err)
	}
	if id == "usr_system_beacon" {
		displayName, kind, avatarURL = "信标", "bot", stringPointer("/assets/beacon-avatar.png")
	} else if id == "usr_system_echo" {
		displayName, kind, avatarURL = "回声", "bot", stringPointer("/assets/echo-avatar.svg")
	}
	projectedRole := role
	if projectedRole == "owner" && actor.Role != "owner" {
		projectedRole = "admin"
	}
	if projectedRole == "auditor" && actor.Role != "owner" && actor.ID != id {
		projectedRole = "member"
	}
	if projectedRole == "" {
		projectedRole = "member"
	}
	if kind == "human" {
		if actor.ID != id && remark != nil && strings.TrimSpace(*remark) != "" {
			displayName = strings.TrimSpace(*remark)
		} else if nickname != nil && strings.TrimSpace(*nickname) != "" {
			displayName = strings.TrimSpace(*nickname)
		} else if strings.TrimSpace(githubLogin) != "" {
			displayName = strings.TrimSpace(githubLogin)
		} else {
			displayName = "成员"
		}
	}
	result := map[string]any{
		"id":           id,
		"displayName":  displayName,
		"kind":         kind,
		"role":         projectedRole,
		"roleLabel":    roleLabel(projectedRole),
		"joinedAt":     formatTimestamp(joinedAt),
		"capabilities": memberCapabilities(actor, id, kind, role),
	}
	if id == "usr_system_beacon" {
		result["description"] = "文件传输助手"
	} else if id == "usr_system_echo" {
		result["description"] = "需求与反馈助手"
	}
	if kind == "human" {
		result["githubLogin"] = githubLogin
		if nickname == nil {
			result["nickname"] = nil
		} else {
			result["nickname"] = *nickname
		}
		if actor.ID != id && remark != nil && strings.TrimSpace(*remark) != "" {
			result["remark"] = strings.TrimSpace(*remark)
		}
		if safeAvatar := safeWorkspaceAvatarURL(optionalString(avatarURL)); safeAvatar != "" {
			result["avatarUrl"] = safeAvatar
		}
		if actor.ID == id {
			result["searchDiscoverable"] = discoverable
			if recallReason != nil && strings.TrimSpace(*recallReason) != "" {
				result["recallReason"] = strings.TrimSpace(*recallReason)
			} else {
				result["recallReason"] = "内容有误"
			}
		}
	} else if safeAvatar := safeWorkspaceAvatarURL(optionalString(avatarURL)); safeAvatar != "" {
		result["avatarUrl"] = safeAvatar
	}
	return result, nil
}

func (r *PGRepository) publicConversationPayload(ctx context.Context, spaceID string, actor *auth.Actor, conversationID string) (map[string]any, error) {
	if actor == nil {
		return nil, nil
	}
	active, err := r.conversationMemberActive(ctx, spaceID, conversationID, actor.ID)
	if err != nil {
		return nil, err
	}
	if !active {
		return nil, nil
	}
	var id, typ, title string
	var avatarEmoji *string
	var retentionCount int64
	var createdAt time.Time
	err = r.pool.QueryRow(ctx, `
		SELECT id, type, title, avatar_emoji, retention_count, created_at
		FROM conversations WHERE id = $1 AND space_id = $2
	`, conversationID, spaceID).Scan(&id, &typ, &title, &avatarEmoji, &retentionCount, &createdAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("project workspace conversation event", err)
	}
	var messageCount, memberCount int64
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM messages WHERE conversation_id = $1 AND topic_id IS NULL AND deleted_at IS NULL`, id).Scan(&messageCount); err != nil {
		return nil, internalError("project workspace conversation event", err)
	}
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM conversation_members WHERE conversation_id = $1 AND removed_at IS NULL`, id).Scan(&memberCount); err != nil {
		return nil, internalError("project workspace conversation event", err)
	}
	var notificationLevel string
	if err := r.pool.QueryRow(ctx, `
		SELECT COALESCE(notification_level, 'all')
		FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND removed_at IS NULL
	`, id, actor.ID).Scan(&notificationLevel); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, internalError("project workspace conversation notification", err)
	}
	if notificationLevel == "" {
		notificationLevel = "all"
	}
	result := map[string]any{
		"id":                id,
		"spaceId":           spaceID,
		"type":              typ,
		"title":             title,
		"displayTitle":      title,
		"retentionCount":    retentionCount,
		"retentionText":     "保留最近 " + formatInt(retentionCount) + " 条消息",
		"createdAt":         formatTimestamp(createdAt),
		"lastActivityAt":    formatTimestamp(createdAt),
		"messageCount":      messageCount,
		"memberCount":       memberCount,
		"unreadCount":       int64(0),
		"notificationLevel": notificationLevel,
		"members":           []any{},
		"latestMessages":    []any{},
	}
	if avatarEmoji == nil {
		result["avatarEmoji"] = nil
	} else {
		result["avatarEmoji"] = *avatarEmoji
	}
	rows, err := r.pool.Query(ctx, `
		SELECT user_id FROM conversation_members
		WHERE conversation_id = $1 AND removed_at IS NULL ORDER BY user_id
	`, id)
	if err != nil {
		return nil, internalError("project workspace conversation members", err)
	}
	defer rows.Close()
	members := make([]any, 0)
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return nil, internalError("project workspace conversation members", err)
		}
		member, err := r.publicMemberPayload(ctx, spaceID, actor, userID)
		if err != nil {
			return nil, err
		}
		if member != nil {
			members = append(members, member)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("project workspace conversation members", err)
	}
	result["members"] = members
	return result, nil
}

func (r *PGRepository) publicMessagePayload(ctx context.Context, spaceID string, actor *auth.Actor, messageID string) (map[string]any, error) {
	if actor == nil {
		return nil, nil
	}
	var id, conversationID, displayName, authorKind, kind, plainText string
	var authorID, clientMessageID, replyToMessageID *string
	var authorNickname, authorGithubLogin, authorAvatarURL, authorRemark *string
	var contentJSON string
	var createdAt time.Time
	var editedAt, deletedAt, recalledAt *time.Time
	var recallReason *string
	err := r.pool.QueryRow(ctx, `
		SELECT m.id, m.conversation_id, m.author_id,
			COALESCE(ur.remark, u.nickname, u.github_login, u.display_name, ''),
			u.nickname, u.github_login, u.avatar_url, ur.remark,
			m.author_kind, m.kind, m.client_message_id, m.content_json,
			m.plain_text, m.reply_to_message_id, m.created_at, m.edited_at,
			m.deleted_at, m.recalled_at, m.recall_reason
		FROM messages m
		LEFT JOIN users u ON u.id = m.author_id
		LEFT JOIN user_remarks ur ON ur.owner_user_id = $3 AND ur.target_user_id = u.id
		WHERE m.id = $1 AND m.space_id = $2 AND m.topic_id IS NULL AND m.deleted_at IS NULL
	`, messageID, spaceID, actor.ID).Scan(&id, &conversationID, &authorID, &displayName,
		&authorNickname, &authorGithubLogin, &authorAvatarURL, &authorRemark, &authorKind, &kind,
		&clientMessageID, &contentJSON, &plainText, &replyToMessageID, &createdAt, &editedAt,
		&deletedAt, &recalledAt, &recallReason)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("project workspace message event", err)
	}
	if authorID != nil {
		switch *authorID {
		case "usr_system_beacon":
			displayName, authorKind, authorAvatarURL = "信标", "bot", stringPointer("/assets/beacon-avatar.png")
		case "usr_system_echo":
			displayName, authorKind, authorAvatarURL = "回声", "bot", stringPointer("/assets/echo-avatar.svg")
		}
	}
	var content any
	if json.Unmarshal([]byte(contentJSON), &content) != nil {
		content = map[string]any{}
	}
	result := map[string]any{
		"id":                  id,
		"conversationId":      conversationID,
		"authorId":            authorID,
		"authorName":          displayName,
		"authorKind":          authorKind,
		"kind":                kind,
		"clientMessageId":     clientMessageID,
		"content":             content,
		"plainText":           plainText,
		"replyToMessageId":    replyToMessageID,
		"createdAt":           formatTimestamp(createdAt),
		"editedAt":            formatTimePointer(editedAt),
		"deletedAt":           formatTimePointer(deletedAt),
		"recalledAt":          formatTimePointer(recalledAt),
		"recallReason":        recallReason,
		"attachments":         []any{},
		"reactions":           []any{},
		"hiddenByCurrentUser": false,
	}
	if authorKind == "human" {
		result["authorNickname"] = optionalString(authorNickname)
		result["authorRemark"] = optionalString(authorRemark)
		result["authorGithubLogin"] = optionalString(authorGithubLogin)
	}
	result["authorAvatarUrl"] = safeWorkspaceAvatarURL(optionalString(authorAvatarURL))
	if recalledAt != nil {
		reason := optionalString(recallReason)
		if reason == "" {
			reason = "内容有误"
		}
		result["recallReason"] = reason
		result["plainText"] = displayName + "因" + reason + "撤回了一条消息"
		result["content"] = map[string]any{"format": "duallane.message+json;v=1", "plainText": "", "blocks": []any{}}
		return result, nil
	}

	attachments, err := r.publicMessageAttachments(ctx, spaceID, actor, id)
	if err != nil {
		return nil, err
	}
	result["attachments"] = attachments
	reactions, err := r.publicMessageReactions(ctx, spaceID, actor, id)
	if err != nil {
		return nil, err
	}
	result["reactions"] = reactions
	var hidden bool
	if err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM message_hidden_states
			WHERE user_id = $1 AND message_id = $2
		)
	`, actor.ID, id).Scan(&hidden); err != nil {
		return nil, internalError("project workspace message hidden state", err)
	}
	result["hiddenByCurrentUser"] = hidden

	var pinnedBy string
	var pinnedAt time.Time
	err = r.pool.QueryRow(ctx, `
		SELECT pinned_by_user_id, created_at
		FROM conversation_pinned_messages
		WHERE conversation_id = $1 AND message_id = $2
	`, conversationID, id).Scan(&pinnedBy, &pinnedAt)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, internalError("project workspace message pin", err)
	}
	if err == nil {
		canUnpin := actor.Role == "owner" || actor.Role == "admin" || (authorID != nil && *authorID == actor.ID)
		result["pin"] = map[string]any{
			"pinnedByUserId": pinnedBy,
			"pinnedAt":       formatTimestamp(pinnedAt),
			"canUnpin":       canUnpin,
		}
	}
	return result, nil
}

func (r *PGRepository) publicMessageAttachments(ctx context.Context, spaceID string, actor *auth.Actor, messageID string) ([]any, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT a.id
		FROM message_attachments ma
		INNER JOIN attachments a ON a.id = ma.attachment_id AND a.space_id = $1
		WHERE ma.message_id = $2
		ORDER BY a.created_at ASC, a.id ASC
	`, spaceID, messageID)
	if err != nil {
		return nil, internalError("project workspace message attachments", err)
	}
	defer rows.Close()
	items := make([]any, 0)
	for rows.Next() {
		var attachmentID string
		if err := rows.Scan(&attachmentID); err != nil {
			return nil, internalError("project workspace message attachments", err)
		}
		attachment, err := r.publicAttachmentPayload(ctx, spaceID, actor, attachmentID)
		if err != nil {
			return nil, err
		}
		if attachment != nil {
			items = append(items, attachment)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("project workspace message attachments", err)
	}
	return items, nil
}

func (r *PGRepository) publicMessageReactions(ctx context.Context, spaceID string, actor *auth.Actor, messageID string) ([]any, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT mr.emote_key, mr.created_at, u.id,
			COALESCE(ur.remark, u.nickname, u.github_login, u.display_name, ''),
			COALESCE(u.github_login, ''), COALESCE(u.avatar_url, '')
		FROM message_reactions mr
		INNER JOIN messages m ON m.id = mr.message_id AND m.space_id = $1
		INNER JOIN users u ON u.id = mr.user_id
		LEFT JOIN user_remarks ur ON ur.owner_user_id = $2 AND ur.target_user_id = u.id
		WHERE mr.message_id = $3
		ORDER BY mr.created_at ASC, u.display_name ASC, u.id ASC
	`, spaceID, actor.ID, messageID)
	if err != nil {
		return nil, internalError("project workspace message reactions", err)
	}
	defer rows.Close()
	groups := make([]any, 0)
	indexes := make(map[string]int)
	for rows.Next() {
		var emoteKey, userID, displayName, githubLogin, avatarURL string
		var createdAt time.Time
		if err := rows.Scan(&emoteKey, &createdAt, &userID, &displayName, &githubLogin, &avatarURL); err != nil {
			return nil, internalError("project workspace message reactions", err)
		}
		index, exists := indexes[emoteKey]
		if !exists {
			index = len(groups)
			indexes[emoteKey] = index
			groups = append(groups, map[string]any{
				"emoteKey":             emoteKey,
				"count":                int64(0),
				"reactedByCurrentUser": false,
				"users":                []any{},
			})
		}
		group := groups[index].(map[string]any)
		group["count"] = group["count"].(int64) + 1
		if userID == actor.ID {
			group["reactedByCurrentUser"] = true
		}
		user := map[string]any{
			"id":          userID,
			"displayName": displayName,
			"createdAt":   formatTimestamp(createdAt),
		}
		if githubLogin != "" {
			user["githubLogin"] = githubLogin
		}
		if safeAvatar := safeWorkspaceAvatarURL(avatarURL); safeAvatar != "" {
			user["avatarUrl"] = safeAvatar
		}
		group["users"] = append(group["users"].([]any), user)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("project workspace message reactions", err)
	}
	return groups, nil
}

func (r *PGRepository) publicAttachmentPayload(ctx context.Context, spaceID string, actor *auth.Actor, attachmentID string) (map[string]any, error) {
	if actor == nil {
		return nil, nil
	}
	var id, fileName, mimeType, status, visibility, uploaderID, uploaderName string
	var conversationID *string
	var byteSize int64
	var createdAt time.Time
	var completedAt *time.Time
	err := r.pool.QueryRow(ctx, `
		SELECT a.id, a.file_name, a.mime_type, a.byte_size, a.status, a.visibility,
			a.uploader_id, COALESCE(ur.remark, u.nickname, u.github_login, u.display_name, ''),
			a.conversation_id, a.created_at, a.completed_at
		FROM attachments a
		INNER JOIN users u ON u.id = a.uploader_id
		LEFT JOIN user_remarks ur ON ur.owner_user_id = $3 AND ur.target_user_id = u.id
		WHERE a.id = $1 AND a.space_id = $2
	`, attachmentID, spaceID, actor.ID).Scan(&id, &fileName, &mimeType, &byteSize, &status, &visibility,
		&uploaderID, &uploaderName, &conversationID, &createdAt, &completedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("project workspace attachment event", err)
	}
	canRemove := status == "available" && (uploaderID == actor.ID || actor.Role == "owner" || actor.Role == "admin")
	return map[string]any{
		"id":             id,
		"fileName":       fileName,
		"mimeType":       mimeType,
		"byteSize":       byteSize,
		"status":         status,
		"visibility":     visibility,
		"uploaderId":     uploaderID,
		"uploaderName":   uploaderName,
		"conversationId": conversationID,
		"createdAt":      formatTimestamp(createdAt),
		"completedAt":    formatTimePointer(completedAt),
		"availableAt":    formatTimePointer(completedAt),
		"uploader":       map[string]any{"id": uploaderID, "displayName": uploaderName},
		"capabilities":   map[string]any{"canDownload": status == "available", "canRemove": canRemove},
	}, nil
}

func clonePayload(payload map[string]any) map[string]any {
	result := make(map[string]any, len(payload)+1)
	for key, value := range payload {
		result[key] = value
	}
	return result
}

func roleLabel(role string) string {
	switch role {
	case "owner":
		return "空间主人"
	case "admin":
		return "管理员"
	case "auditor":
		return "预留角色"
	default:
		return "成员"
	}
}

func memberCapabilities(actor *auth.Actor, memberID, kind, role string) map[string]any {
	canRead := role == "owner" || role == "admin" || role == "member"
	canManage := actor != nil && role != "" && memberID != "usr_system_beacon" && memberID != "usr_system_echo" && (actor.Role == "owner" || actor.Role == "admin")
	systemIdentity := memberID == "usr_system_beacon" || memberID == "usr_system_echo"
	return map[string]any{
		"canStartDirectConversation": actor != nil && actor.ID != memberID && (systemIdentity || (kind == "human" && role != "auditor")) && (actor.Role == "owner" || actor.Role == "admin" || actor.Role == "member"),
		"canJoinGroups":              kind == "human" && canRead,
		"canManage":                  canManage,
	}
}

func formatTimePointer(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := formatTimestamp(*value)
	return &formatted
}

func stringPointer(value string) *string {
	return &value
}

func formatInt(value int64) string {
	return strconv.FormatInt(value, 10)
}

func safeWorkspaceAvatarURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || strings.Contains(value, "..") {
		return ""
	}
	if strings.HasPrefix(value, "/assets/") || strings.HasPrefix(value, "/api/workspace/avatars/") {
		return value
	}
	parsed, err := url.Parse(value)
	if err == nil && parsed.Scheme == "https" && parsed.Hostname() == "avatars.githubusercontent.com" {
		return value
	}
	return ""
}
