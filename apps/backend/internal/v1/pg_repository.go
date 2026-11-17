package v1

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PGRepository struct {
	pool    *pgxpool.Pool
	spaceID string
}

func NewPGRepository(pool *pgxpool.Pool, spaceID string) *PGRepository {
	if spaceID == "" {
		spaceID = "spc_default"
	}
	repo := &PGRepository{pool: pool, spaceID: spaceID}
	return repo
}

func formatDirectKey(left, right string) string {
	ids := []string{strings.TrimSpace(left), strings.TrimSpace(right)}
	sort.Strings(ids)
	return ids[0] + ":" + ids[1]
}

// NormalizeLegacyBotPolicies is an explicit, operator-invoked legacy migration
// helper. It is never run from a read path. In particular it does not create
// context grants: visibility normalization must not manufacture message or
// trigger authority.
func (r *PGRepository) NormalizeLegacyBotPolicies(ctx context.Context, now time.Time) error {
	if r == nil || r.pool == nil {
		return nil
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		UPDATE workspace_agent_bot_settings
		SET visibility_policy = 'private',
		    allow_direct = 1,
		    allow_group = 1,
		    updated_at = $2
		WHERE space_id = $1 AND visibility_policy = 'groups'
	`, r.spaceID, now.UTC()); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE workspace_agent_bots
		SET visibility_policy = 'private',
		    conversation_policy = 'group-capable',
		    updated_at = $2
		WHERE space_id = $1 AND visibility_policy = 'groups'
	`, r.spaceID, now.UTC()); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE workspace_agent_bots b
		SET conversation_policy = CASE WHEN COALESCE(bs.allow_group, 0) = 1 THEN 'group-capable' ELSE 'direct-only' END,
		    updated_at = $2
		FROM workspace_agent_bot_settings bs
		WHERE bs.bot_id = b.id
		  AND bs.space_id = b.space_id
		  AND b.space_id = $1
		  AND b.conversation_policy <> (CASE WHEN COALESCE(bs.allow_group, 0) = 1 THEN 'group-capable' ELSE 'direct-only' END)
	`, r.spaceID, now.UTC()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func sanitizeBootstrapAvatarURL(raw string) string {
	candidate := strings.TrimSpace(raw)
	if candidate == "" {
		return ""
	}
	if strings.HasPrefix(candidate, "/assets/") && !strings.Contains(candidate, "..") {
		return candidate
	}
	if strings.HasPrefix(candidate, "/api/workspace/avatars/") && !strings.Contains(candidate, "..") {
		return candidate
	}
	if strings.HasPrefix(candidate, "/api/v1/bots/") && !strings.Contains(candidate, "..") {
		return candidate
	}
	if strings.HasPrefix(candidate, "https://avatars.githubusercontent.com/") {
		return candidate
	}
	return ""
}

func projectBootstrapRole(memberID, memberKind, rawRole, actorID, actorRole string) string {
	if memberKind == "bot" {
		return "member"
	}
	if actorRole != "owner" && actorRole != "admin" {
		if memberID == actorID && rawRole == "auditor" {
			return "auditor"
		}
		return "member"
	}
	if rawRole == "owner" && actorRole != "owner" {
		return "admin"
	}
	if rawRole == "auditor" && memberID != actorID && actorRole != "owner" {
		return "member"
	}
	if rawRole == "" {
		return "member"
	}
	return rawRole
}

func projectBootstrapMember(
	id, githubLogin, displayName, nickname, remark, avatarURL, kind, rawRole, actorID, actorRole string,
) V1BootstrapMember {
	switch id {
	case "usr_system_beacon":
		return V1BootstrapMember{
			ID:          id,
			DisplayName: "信标",
			Kind:        "bot",
			Role:        "member",
			AvatarURL:   "/assets/beacon-avatar.png",
		}
	case "usr_system_echo":
		return V1BootstrapMember{
			ID:          id,
			DisplayName: "回声",
			Kind:        "bot",
			Role:        "member",
			AvatarURL:   "/assets/echo-avatar.svg",
		}
	}

	resolved := ""
	if id != actorID {
		resolved = strings.TrimSpace(remark)
	}
	if resolved == "" {
		resolved = strings.TrimSpace(nickname)
	}
	if kind != "human" && strings.TrimSpace(displayName) != "" {
		resolved = strings.TrimSpace(displayName)
	}
	if resolved == "" {
		resolved = strings.TrimSpace(githubLogin)
	}
	if resolved == "" {
		resolved = strings.TrimSpace(displayName)
	}
	if resolved == "" {
		if kind == "bot" {
			resolved = "Bot"
		} else {
			resolved = "成员"
		}
	}

	out := V1BootstrapMember{
		ID:          id,
		DisplayName: resolved,
		Kind:        kind,
		Role:        projectBootstrapRole(id, kind, rawRole, actorID, actorRole),
		AvatarURL:   sanitizeBootstrapAvatarURL(avatarURL),
	}
	if kind == "human" {
		out.GitHubLogin = strings.TrimSpace(githubLogin)
		out.Nickname = strings.TrimSpace(nickname)
		if id != actorID {
			out.Remark = strings.TrimSpace(remark)
		}
	}
	return out
}

func (r *PGRepository) GetBootstrap(ctx context.Context, actorID string, now time.Time) (V1BootstrapResponse, error) {
	nowUTC := now.UTC()
	quotaSince := nowUTC.Add(-24 * time.Hour)

	var (
		uID, uGitHub, uDisplay, uNick, uAvatar, actorRole string
		dailyQuotaBytes, usedTodayBytes, eventCursor      int64
		prefsRaw, beaconPrefsRaw                          string
	)
	err := r.pool.QueryRow(ctx, `
		SELECT
			u.id,
			coalesce(u.github_login, ''),
			coalesce(u.display_name, ''),
			coalesce(u.nickname, ''),
			coalesce(u.avatar_url, ''),
			sm.role,
			coalesce((SELECT daily_quota_bytes FROM space_policies WHERE space_id = $1), 2147483648),
			coalesce((
				SELECT SUM(byte_size)::bigint
				FROM transfer_ledger
				WHERE space_id = $1 AND user_id = $2 AND created_at >= $3 AND status IN ('reserved', 'completed')
			), 0),
			coalesce((SELECT prefs_json FROM user_preferences WHERE user_id = $2), '{}'),
			coalesce((SELECT prefs_json FROM user_preferences WHERE user_id = 'usr_system_beacon'), '{}'),
			coalesce((SELECT MAX(seq) FROM workspace_events WHERE space_id = $1), 0)
		FROM space_members sm
		JOIN users u ON u.id = sm.user_id
		WHERE sm.space_id = $1 AND sm.user_id = $2 AND sm.removed_at IS NULL AND u.kind = 'human'
	`, r.spaceID, actorID, quotaSince).Scan(
		&uID, &uGitHub, &uDisplay, &uNick, &uAvatar, &actorRole,
		&dailyQuotaBytes, &usedTodayBytes, &prefsRaw, &beaconPrefsRaw, &eventCursor,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return V1BootstrapResponse{}, ErrForbidden
		}
		return V1BootstrapResponse{}, err
	}

	canReadConversations := actorRole == "owner" || actorRole == "admin" || actorRole == "member"

	prefs := map[string]any{}
	_ = json.Unmarshal([]byte(prefsRaw), &prefs)
	if prefs == nil {
		prefs = map[string]any{}
	}

	currentUser := projectBootstrapMember(
		uID, uGitHub, uDisplay, uNick, "", uAvatar, "human", actorRole, actorID, actorRole,
	)
	currentUser.Role = actorRole

	botHeartbeatCutoff := nowUTC.Add(-90 * time.Second)
	memberRows, err := r.pool.Query(ctx, `
		SELECT
			u.id,
			coalesce(u.github_login, ''),
			coalesce(u.display_name, ''),
			coalesce(u.nickname, ''),
			coalesce(ur.remark, ''),
			coalesce(bs_meta.description, ''),
			coalesce(u.avatar_url, bs_meta.avatar_url, ''),
			coalesce(up_bot.prefs_json, '{}'),
			u.kind,
			sm.role,
			b_meta.id IS NOT NULL AS is_external_bot,
			CASE
				WHEN b_meta.id IS NULL THEN FALSE
				WHEN b_meta.status <> 'active' THEN FALSE
				WHEN bc_meta.status = 'connected' AND COALESCE(bc_meta.last_heartbeat_at, bc_meta.connected_at) >= $4 THEN TRUE
				WHEN EXISTS (SELECT 1 FROM bot_webhooks bw WHERE bw.bot_id = b_meta.id AND bw.enabled = TRUE) THEN TRUE
				ELSE FALSE
			END AS bot_online
		FROM space_members sm
		JOIN users u ON u.id = sm.user_id
		LEFT JOIN user_remarks ur ON ur.owner_user_id = $2 AND ur.target_user_id = u.id
		LEFT JOIN workspace_agent_bots b_meta ON b_meta.space_id = $1 AND b_meta.bot_user_id = u.id AND b_meta.status <> 'deleted'
		LEFT JOIN workspace_agent_bot_settings bs_meta ON bs_meta.bot_id = b_meta.id AND bs_meta.space_id = $1
		LEFT JOIN workspace_agent_bot_connections bc_meta ON bc_meta.bot_id = b_meta.id AND bc_meta.space_id = $1
		LEFT JOIN user_preferences up_bot ON up_bot.user_id = u.id AND u.kind = 'bot'
		WHERE sm.space_id = $1
			AND sm.removed_at IS NULL
			AND (
				$3 IN ('owner', 'admin')
				OR u.id = $2
				OR u.id IN ('usr_system_beacon', 'usr_system_echo')
				OR (
					u.kind = 'bot'
					AND EXISTS (
						SELECT 1 FROM workspace_agent_bots b
						WHERE b.space_id = $1
							AND b.bot_user_id = u.id
							AND (
								(b.owner_user_id = $2 AND b.status IN ('active', 'paused'))
								OR (
									b.status = 'active'
									AND (
										b.visibility_policy IN ('space', 'space_members', 'groups')
										OR EXISTS (
											SELECT 1 FROM workspace_agent_bot_visibility_members bvm
											WHERE bvm.bot_id = b.id AND bvm.space_id = $1 AND bvm.user_id = $2
										)
									)
								)
							)
					)
				)
				OR (u.kind = 'human' AND sm.role <> 'auditor' AND u.search_discoverable = TRUE)
				OR EXISTS (
					SELECT 1 FROM member_visibility_grants g
					WHERE g.space_id = $1 AND g.viewer_user_id = $2 AND g.visible_user_id = u.id
				)
				OR EXISTS (
					SELECT 1
					FROM conversation_members cm_self
					JOIN conversations c_shared ON c_shared.id = cm_self.conversation_id AND c_shared.space_id = $1
					JOIN conversation_members cm_peer
						ON cm_peer.conversation_id = cm_self.conversation_id
						AND cm_peer.user_id = u.id
						AND cm_peer.removed_at IS NULL
					WHERE cm_self.user_id = $2 AND cm_self.removed_at IS NULL
				)
			)
		ORDER BY sm.joined_at ASC, u.id ASC
	`, r.spaceID, actorID, actorRole, botHeartbeatCutoff)
	if err != nil {
		return V1BootstrapResponse{}, err
	}
	members := make([]V1BootstrapMember, 0, 16)
	memberByID := make(map[string]V1BootstrapMember, 16)
	for memberRows.Next() {
		var mID, mGitHub, mDisplay, mNick, mRemark, mDesc, mAvatar, mBotPrefsRaw, mKind, mRole string
		var isExternalBot, botOnline bool
		if scanErr := memberRows.Scan(&mID, &mGitHub, &mDisplay, &mNick, &mRemark, &mDesc, &mAvatar, &mBotPrefsRaw, &mKind, &mRole, &isExternalBot, &botOnline); scanErr != nil {
			memberRows.Close()
			return V1BootstrapResponse{}, scanErr
		}
		projected := projectBootstrapMember(
			mID, mGitHub, mDisplay, mNick, mRemark, mAvatar, mKind, mRole, actorID, actorRole,
		)
		if mKind == "bot" {
			if strings.TrimSpace(mDesc) != "" {
				projected.Description = strings.TrimSpace(mDesc)
			}
			if isExternalBot {
				onlineVal := botOnline
				projected.BotOnline = &onlineVal
			}
			if mBotPrefsRaw != "" && mBotPrefsRaw != "{}" {
				var botPrefs map[string]any
				if json.Unmarshal([]byte(mBotPrefsRaw), &botPrefs) == nil {
					if rawCol, ok := botPrefs["botColor"].(string); ok && IsValidBotColor(rawCol) && rawCol != "" {
						projected.AvatarColor = rawCol
					}
				}
			}
		}
		if mID == actorID {
			projected.Role = actorRole
		}
		members = append(members, projected)
		memberByID[mID] = projected
	}
	if err := memberRows.Err(); err != nil {
		memberRows.Close()
		return V1BootstrapResponse{}, err
	}
	memberRows.Close()

	conversations := make([]V1BootstrapConversation, 0, 16)
	if canReadConversations {
		convRows, err := r.pool.Query(ctx, `
			WITH user_convs AS (
				SELECT
					c.id,
					c.type,
					c.title,
					c.avatar_emoji,
					c.created_at,
					cm.last_read_seq,
					cm.last_read_at,
					coalesce(cm.notification_level, 'all') AS notification_level
				FROM conversation_members cm
				JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
				WHERE cm.user_id = $2 AND cm.removed_at IS NULL
			)
			SELECT
				uc.id,
				uc.type,
				uc.title,
				uc.avatar_emoji,
				uc.notification_level,
				CASE
					WHEN latest.id IS NULL THEN ''
					WHEN latest.recalled_at IS NOT NULL THEN '消息已撤回'
					ELSE coalesce(latest.plain_text, '')
				END AS last_plain_text,
				CASE
					WHEN latest.id IS NULL OR latest.recalled_at IS NOT NULL OR latest.kind = 'system' THEN ''
					ELSE coalesce(latest.author_id, '')
				END AS last_sender_id,
				CASE
					WHEN latest.id IS NULL OR latest.recalled_at IS NOT NULL OR latest.kind = 'system' THEN ''
					ELSE coalesce(latest.author_name, '')
				END AS last_sender_name,
				latest.created_at AS last_msg_at,
				coalesce(all_latest.created_at, uc.created_at) AS last_activity_at,
				CASE
					WHEN uc.last_read_seq IS NOT NULL THEN coalesce(su.cnt, 0)
					ELSE coalesce(tu.cnt, 0)
				END AS unread_count,
				GREATEST(
					(SELECT MAX(cm_peer.last_read_at)
					 FROM conversation_members cm_peer
					 WHERE cm_peer.conversation_id = uc.id
					   AND cm_peer.user_id <> $2
					   AND cm_peer.removed_at IS NULL),
					(SELECT MAX(m_peer.created_at)
					 FROM messages m_peer
					 WHERE m_peer.conversation_id = uc.id
					   AND m_peer.space_id = $1
					   AND m_peer.deleted_at IS NULL
					   AND m_peer.kind <> 'system'
					   AND m_peer.author_id IS NOT NULL
					   AND m_peer.author_id <> $2)
				) AS peer_last_read_at
			FROM user_convs uc
			LEFT JOIN LATERAL (
				SELECT COUNT(DISTINCT m.id)::int AS cnt
				FROM workspace_events we
				JOIN messages m ON m.id = we.target_id
				WHERE uc.last_read_seq IS NOT NULL
					AND we.space_id = $1
					AND we.conversation_id = uc.id
					AND we.seq > uc.last_read_seq
					AND we.type = 'message.created'
					AND m.space_id = $1
					AND m.deleted_at IS NULL
					AND m.topic_id IS NULL
					AND (m.thread_root_id IS NULL OR m.also_send_to_channel = TRUE)
					AND m.kind <> 'system'
					AND (m.author_id IS NULL OR m.author_id <> $2)
			) su ON uc.last_read_seq IS NOT NULL
			LEFT JOIN LATERAL (
				SELECT COUNT(m.id)::int AS cnt
				FROM messages m
				WHERE uc.last_read_seq IS NULL
					AND m.conversation_id = uc.id
					AND m.space_id = $1
					AND m.deleted_at IS NULL
					AND m.topic_id IS NULL
					AND (m.thread_root_id IS NULL OR m.also_send_to_channel = TRUE)
					AND m.kind <> 'system'
					AND (m.author_id IS NULL OR m.author_id <> $2)
					AND (uc.last_read_at IS NULL OR m.created_at > uc.last_read_at)
			) tu ON uc.last_read_seq IS NULL
			LEFT JOIN LATERAL (
				SELECT m.created_at
				FROM messages m
				WHERE m.conversation_id = uc.id
					AND m.space_id = $1
					AND m.topic_id IS NULL
					AND (m.thread_root_id IS NULL OR m.also_send_to_channel = TRUE)
					AND m.deleted_at IS NULL
				ORDER BY m.created_at DESC, m.id DESC
				LIMIT 1
			) all_latest ON TRUE
			LEFT JOIN LATERAL (
				SELECT
					m.id,
					m.plain_text,
					m.recalled_at,
					m.created_at,
					m.kind,
					coalesce(m.author_id, '') AS author_id,
					coalesce(NULLIF(u_author.nickname, ''), NULLIF(u_author.display_name, ''), NULLIF(u_author.github_login, ''), '') AS author_name
				FROM messages m
				LEFT JOIN users u_author ON u_author.id = m.author_id
				WHERE m.conversation_id = uc.id
					AND m.space_id = $1
					AND m.topic_id IS NULL
					AND (m.thread_root_id IS NULL OR m.also_send_to_channel = TRUE)
					AND m.deleted_at IS NULL
					AND NOT EXISTS (
						SELECT 1 FROM message_hidden_states h
						WHERE h.message_id = m.id AND h.user_id = $2
					)
				ORDER BY m.created_at DESC, m.id DESC
				LIMIT 1
			) latest ON TRUE
			ORDER BY last_activity_at DESC, uc.id ASC
		`, r.spaceID, actorID)
		if err != nil {
			return V1BootstrapResponse{}, err
		}

		convIDs := make([]string, 0, 16)
		convIndexByID := make(map[string]int, 16)
		for convRows.Next() {
			var (
				c              V1BootstrapConversation
				rawSenderName  string
				lastMsgAt      *time.Time
				activity       time.Time
				peerLastReadAt *time.Time
			)
			if scanErr := convRows.Scan(
				&c.ID,
				&c.Type,
				&c.Title,
				&c.AvatarEmoji,
				&c.NotificationLevel,
				&c.LastMessagePlainText,
				&c.LastMessageSenderID,
				&rawSenderName,
				&lastMsgAt,
				&activity,
				&c.UnreadCount,
				&peerLastReadAt,
			); scanErr != nil {
				convRows.Close()
				return V1BootstrapResponse{}, scanErr
			}
			c.NotificationLevel = strings.TrimSpace(c.NotificationLevel)
			if c.NotificationLevel != "mentions" && c.NotificationLevel != "muted" {
				c.NotificationLevel = "all"
			}
			if c.LastMessageSenderID != "" {
				if mem, ok := memberByID[c.LastMessageSenderID]; ok && strings.TrimSpace(mem.DisplayName) != "" {
					c.LastMessageSenderName = strings.TrimSpace(mem.DisplayName)
				} else {
					cleaned := strings.TrimSpace(rawSenderName)
					if strings.HasPrefix(cleaned, "__duallane_") {
						cleaned = "Bot"
					}
					c.LastMessageSenderName = cleaned
				}
			}
			if c.Type != "group" {
				c.AvatarEmoji = nil
			}
			c.DisplayTitle = c.Title
			if c.Type == "saved" {
				c.DisplayTitle = "我的收藏"
			}
			c.MemberIDs = []string{}
			c.PinnedMessageIDs = []string{}
			if lastMsgAt != nil && !lastMsgAt.IsZero() {
				formatted := lastMsgAt.UTC().Format(time.RFC3339Nano)
				c.LastMessageAt = &formatted
			}
			if peerLastReadAt != nil && !peerLastReadAt.IsZero() {
				formatted := peerLastReadAt.UTC().Format(time.RFC3339Nano)
				c.PeerLastReadAt = &formatted
			}
			convIndexByID[c.ID] = len(conversations)
			convIDs = append(convIDs, c.ID)
			conversations = append(conversations, c)
		}
		if err := convRows.Err(); err != nil {
			convRows.Close()
			return V1BootstrapResponse{}, err
		}
		convRows.Close()

		hasSaved := false
		for i := range conversations {
			if conversations[i].Type == "saved" {
				hasSaved = true
				break
			}
		}
		if !hasSaved {
			if savedID, savedErr := r.GetOrCreateSavedConversation(ctx, actorID, nowUTC); savedErr == nil && savedID != "" {
				savedConv := V1BootstrapConversation{
					ID:                savedID,
					Type:              "saved",
					Title:             "我的收藏",
					DisplayTitle:      "我的收藏",
					NotificationLevel: "all",
					MemberIDs:         []string{actorID},
					PinnedMessageIDs:  []string{},
				}
				convIndexByID[savedID] = len(conversations)
				convIDs = append(convIDs, savedID)
				conversations = append([]V1BootstrapConversation{savedConv}, conversations...)
				// Rebuild convIndexByID after prepend
				for idx := range conversations {
					convIndexByID[conversations[idx].ID] = idx
				}
			}
		}

		if len(convIDs) > 0 {
			cmRows, err := r.pool.Query(ctx, `
				SELECT cm.conversation_id, cm.user_id
				FROM conversation_members cm
				JOIN space_members sm ON sm.space_id = $1 AND sm.user_id = cm.user_id AND sm.removed_at IS NULL
				WHERE cm.conversation_id = ANY($2) AND cm.removed_at IS NULL
				ORDER BY cm.joined_at ASC, cm.user_id ASC
			`, r.spaceID, convIDs)
			if err != nil {
				return V1BootstrapResponse{}, err
			}
			for cmRows.Next() {
				var cID, mID string
				if scanErr := cmRows.Scan(&cID, &mID); scanErr != nil {
					cmRows.Close()
					return V1BootstrapResponse{}, scanErr
				}
				if idx, ok := convIndexByID[cID]; ok {
					conversations[idx].MemberIDs = append(conversations[idx].MemberIDs, mID)
				}
			}
			if err := cmRows.Err(); err != nil {
				cmRows.Close()
				return V1BootstrapResponse{}, err
			}
			cmRows.Close()

			for i := range conversations {
				if conversations[i].Type == "direct" {
					for _, mID := range conversations[i].MemberIDs {
						if mID != actorID {
							if peer, ok := memberByID[mID]; ok && peer.DisplayName != "" {
								conversations[i].DisplayTitle = peer.DisplayName
							}
							break
						}
					}
				}
			}

			pinRows, err := r.pool.Query(ctx, `
				SELECT p.conversation_id, p.message_id
				FROM conversation_pinned_messages p
				JOIN messages m ON m.id = p.message_id
				WHERE p.conversation_id = ANY($1)
					AND m.space_id = $2
					AND m.deleted_at IS NULL
					AND m.recalled_at IS NULL
				ORDER BY p.created_at DESC
			`, convIDs, r.spaceID)
			if err != nil {
				return V1BootstrapResponse{}, err
			}
			for pinRows.Next() {
				var cID, msgID string
				if scanErr := pinRows.Scan(&cID, &msgID); scanErr != nil {
					pinRows.Close()
					return V1BootstrapResponse{}, scanErr
				}
				if idx, ok := convIndexByID[cID]; ok {
					conversations[idx].PinnedMessageIDs = append(conversations[idx].PinnedMessageIDs, msgID)
				}
			}
			if err := pinRows.Err(); err != nil {
				pinRows.Close()
				return V1BootstrapResponse{}, err
			}
			pinRows.Close()
		}
	}

	boundEmail, _ := prefs["boundEmail"].(string)
	boundEmail = strings.TrimSpace(boundEmail)
	ackAnnID, _ := prefs["ackAnnouncementId"].(string)
	ackAnnID = strings.TrimSpace(ackAnnID)
	stripReservedPreferenceKeys(prefs)

	var activeAnnouncement *SystemAnnouncement
	if parsedAnn, ok := parseSystemAnnouncementFromPrefsRaw(beaconPrefsRaw); ok && parsedAnn.Enabled && parsedAnn.ID != "" && parsedAnn.Title != "" {
		parsedAnn.ShouldShow = parsedAnn.DisplayMode == "always" || ackAnnID != parsedAnn.ID
		activeAnnouncement = &parsedAnn
	}

	return V1BootstrapResponse{
		Auth: V1BootstrapAuth{
			Enabled:     true,
			CurrentUser: currentUser,
			BoundEmail:  boundEmail,
		},
		Policy: V1BootstrapPolicy{
			DailyQuotaBytes: dailyQuotaBytes,
			UsedTodayBytes:  usedTodayBytes,
		},
		Preferences:   prefs,
		Announcement:  activeAnnouncement,
		Members:       members,
		Conversations: conversations,
		EventCursor:   eventCursor,
	}, nil
}

func (r *PGRepository) SyncDelta(ctx context.Context, actorID string, sinceSeq int64, limit int) (SyncDeltaResponse, error) {
	var currentSeq int64
	err := r.pool.QueryRow(ctx, `SELECT coalesce(max(seq), 0) FROM workspace_events WHERE space_id = $1`, r.spaceID).Scan(&currentSeq)
	if err != nil {
		return SyncDeltaResponse{}, err
	}

	rows, err := r.pool.Query(ctx, `
		SELECT we.seq, we.type, coalesce(we.conversation_id, ''), we.payload_json, we.created_at
		FROM workspace_events we
		WHERE we.space_id = $1
		  AND we.seq > $2
		  AND (
			we.conversation_id IS NULL
			OR EXISTS (
				SELECT 1 FROM conversation_members cm
				WHERE cm.conversation_id = we.conversation_id AND cm.user_id = $3 AND cm.removed_at IS NULL
			)
		  )
		ORDER BY we.seq ASC
		LIMIT $4
	`, r.spaceID, sinceSeq, actorID, limit+1)
	if err != nil {
		return SyncDeltaResponse{}, err
	}
	defer rows.Close()

	events := make([]SyncEvent, 0)
	for rows.Next() {
		var seq int64
		var evType, convID, payloadRaw string
		var createdAt time.Time
		if err := rows.Scan(&seq, &evType, &convID, &payloadRaw, &createdAt); err != nil {
			return SyncDeltaResponse{}, err
		}
		payload := map[string]any{}
		_ = json.Unmarshal([]byte(payloadRaw), &payload)
		events = append(events, SyncEvent{
			Seq:            seq,
			Type:           evType,
			ConversationID: convID,
			Payload:        payload,
			CreatedAt:      createdAt.UTC().Format(time.RFC3339Nano),
		})
	}
	hasMore := false
	if len(events) > limit {
		hasMore = true
		events = events[:limit]
	}
	return SyncDeltaResponse{
		CurrentSeq:    currentSeq,
		HasMore:       hasMore,
		ResetRequired: sinceSeq > currentSeq,
		Events:        events,
	}, rows.Err()
}

func (r *PGRepository) Search(ctx context.Context, actorID, query, scope string, limit int) (SearchResponse, error) {
	resp := SearchResponse{
		Messages: []SearchMessageHit{},
		Files:    []SearchFileHit{},
	}
	likePattern := "%" + query + "%"

	if scope == "all" || scope == "messages" {
		rows, err := r.pool.Query(ctx, `
			SELECT m.id, m.conversation_id, coalesce(m.thread_root_id, ''), coalesce(m.author_id, ''), coalesce(u.display_name, ''), m.plain_text, m.created_at
			FROM messages m
			JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
			LEFT JOIN users u ON u.id = m.author_id
			WHERE m.space_id = $2
			  AND m.deleted_at IS NULL
			  AND (
				to_tsvector('simple', coalesce(m.plain_text, '')) @@ plainto_tsquery('simple', $3)
				OR m.plain_text ILIKE $4
			  )
			ORDER BY m.created_at DESC
			LIMIT $5
		`, actorID, r.spaceID, query, likePattern, limit)
		if err != nil {
			return SearchResponse{}, err
		}
		for rows.Next() {
			var hit SearchMessageHit
			var createdAt time.Time
			if err := rows.Scan(&hit.ID, &hit.ConversationID, &hit.ThreadRootID, &hit.AuthorID, &hit.AuthorName, &hit.PlainText, &createdAt); err != nil {
				rows.Close()
				return SearchResponse{}, err
			}
			hit.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
			resp.Messages = append(resp.Messages, hit)
		}
		rows.Close()
	}

	if scope == "all" || scope == "files" {
		rows, err := r.pool.Query(ctx, `
			SELECT
				a.id,
				a.file_name,
				a.mime_type,
				a.byte_size,
				coalesce(direct_src.conversation_id, linked_msg.conversation_id, a.conversation_id, ''),
				coalesce(direct_src.id, linked_msg.message_id, ''),
				a.width,
				a.height,
				coalesce(a.thumb_hash, ''),
				a.created_at
			FROM attachments a
			LEFT JOIN messages direct_src
				ON a.source_message_id IS NOT NULL
				AND direct_src.id = a.source_message_id
				AND direct_src.space_id = a.space_id
				AND direct_src.topic_id IS NULL
				AND direct_src.deleted_at IS NULL
				AND direct_src.recalled_at IS NULL
				AND EXISTS (
					SELECT 1 FROM conversation_members dcm
					WHERE dcm.conversation_id = direct_src.conversation_id
					  AND dcm.user_id = $3
					  AND dcm.removed_at IS NULL
				)
			LEFT JOIN LATERAL (
				SELECT m.id AS message_id, m.conversation_id AS conversation_id
				FROM message_attachments ma
				INNER JOIN messages m ON m.id = ma.message_id
				INNER JOIN conversation_members mcm
					ON mcm.conversation_id = m.conversation_id
					AND mcm.user_id = $3
					AND mcm.removed_at IS NULL
				WHERE ma.attachment_id = a.id
				  AND m.space_id = a.space_id
				  AND m.topic_id IS NULL
				  AND m.deleted_at IS NULL
				  AND m.recalled_at IS NULL
				ORDER BY
					CASE WHEN a.conversation_id IS NOT NULL AND m.conversation_id = a.conversation_id THEN 0 ELSE 1 END,
					m.created_at DESC,
					m.id DESC
				LIMIT 1
			) linked_msg ON TRUE
			WHERE a.space_id = $1
			  AND a.status = 'available'
			  AND a.file_name ILIKE $2
			  AND (
				a.visibility = 'space'
				OR a.uploader_id = $3
				OR linked_msg.message_id IS NOT NULL
				OR (a.conversation_id IS NOT NULL AND EXISTS (
					SELECT 1 FROM conversation_members cm
					WHERE cm.conversation_id = a.conversation_id AND cm.user_id = $3 AND cm.removed_at IS NULL
				))
			  )
			ORDER BY a.created_at DESC
			LIMIT $4
		`, r.spaceID, likePattern, actorID, limit)
		if err != nil {
			return SearchResponse{}, err
		}
		for rows.Next() {
			var hit SearchFileHit
			var createdAt time.Time
			if err := rows.Scan(&hit.ID, &hit.FileName, &hit.MIMEType, &hit.ByteSize, &hit.ConversationID, &hit.SourceMessageID, &hit.Width, &hit.Height, &hit.ThumbHash, &createdAt); err != nil {
				rows.Close()
				return SearchResponse{}, err
			}
			hit.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
			resp.Files = append(resp.Files, hit)
		}
		rows.Close()
	}

	return resp, nil
}

func (r *PGRepository) GetOrCreateSavedConversation(ctx context.Context, actorID string, now time.Time) (string, error) {
	directKey := "saved:" + actorID
	var id string
	err := r.pool.QueryRow(ctx, `
		SELECT c.id
		FROM conversations c
		WHERE c.space_id = $1
		  AND (
			c.direct_key = $2
			OR (
				c.type = 'saved'
				AND EXISTS (
					SELECT 1 FROM conversation_members cm
					WHERE cm.conversation_id = c.id AND cm.user_id = $3 AND cm.removed_at IS NULL
				)
			)
		  )
		ORDER BY CASE WHEN c.direct_key = $2 THEN 0 ELSE 1 END, c.created_at ASC
		LIMIT 1
	`, r.spaceID, directKey, actorID).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}

	id = randomID("conv")
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, created_by, created_at)
		VALUES ($1, $2, 'saved', '个人空间', $3, $4, $5)
		ON CONFLICT (space_id, direct_key) DO NOTHING
	`, id, r.spaceID, directKey, actorID, now)
	if err != nil {
		return "", err
	}
	err = tx.QueryRow(ctx, `SELECT id FROM conversations WHERE space_id = $1 AND direct_key = $2`, r.spaceID, directKey).Scan(&id)
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
		VALUES ($1, $2, 'owner', $3)
		ON CONFLICT (conversation_id, user_id) DO NOTHING
	`, id, actorID, now)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

func (r *PGRepository) EditMessage(ctx context.Context, actorID, messageID, plainText string, now time.Time) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	blocks := []map[string]any{{"type": "text", "text": plainText}}
	attRows, err := tx.Query(ctx, `
		SELECT attachment_id
		FROM message_attachments
		WHERE message_id = $1
		ORDER BY attachment_id ASC
	`, messageID)
	if err != nil {
		return err
	}
	for attRows.Next() {
		var attID string
		if scanErr := attRows.Scan(&attID); scanErr != nil {
			attRows.Close()
			return scanErr
		}
		if strings.TrimSpace(attID) != "" {
			blocks = append(blocks, map[string]any{"type": "attachment", "attachmentId": attID})
		}
	}
	if err := attRows.Err(); err != nil {
		attRows.Close()
		return err
	}
	attRows.Close()

	contentObj := map[string]any{
		"format":    "duallane.message+json;v=1",
		"plainText": plainText,
		"blocks":    blocks,
	}
	contentJSON, _ := json.Marshal(contentObj)

	var convID string
	var createdAt time.Time
	err = tx.QueryRow(ctx, `
		UPDATE messages
		SET plain_text = $1, content_json = $2, edited_at = $3
		WHERE space_id = $4 AND id = $5 AND author_id = $6 AND deleted_at IS NULL AND recalled_at IS NULL
		RETURNING conversation_id, created_at
	`, plainText, string(contentJSON), now.UTC(), r.spaceID, messageID, actorID).Scan(&convID, &createdAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		return err
	}

	if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, convID, "message.edited", "message", messageID, map[string]any{
		"conversationId": convID,
		"messageId":      messageID,
		"message": map[string]any{
			"id":             messageID,
			"conversationId": convID,
			"authorId":       actorID,
			"plainText":      plainText,
			"content":        contentObj,
			"createdAt":      createdAt.UTC().Format(time.RFC3339Nano),
			"editedAt":       now.UTC().Format(time.RFC3339Nano),
		},
	}, now); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

func (r *PGRepository) ListBotConversations(ctx context.Context, botID, botUserID string) ([]BotConversationSummary, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT
			c.id,
			c.type,
			CASE
				WHEN c.type = 'direct' THEN COALESCE(NULLIF(peer.peer_name, ''), NULLIF(c.title, ''), '私聊会话')
				ELSE COALESCE(NULLIF(c.title, ''), '群聊会话')
			END AS display_title,
			COALESCE(c.type = 'direct' AND peer.peer_id = b.owner_user_id, FALSE) AS is_owner_direct,
			b.status AS bot_status,
			COALESCE(bs.visibility_policy, b.visibility_policy, 'private') AS vis_policy,
			COALESCE(bs.allow_direct = 1, TRUE) AS allow_direct,
			COALESCE(bs.allow_group = 1, FALSE) AND b.conversation_policy = 'group-capable' AS allow_group_capable,
			COALESCE(bs.trigger_policy, b.trigger_policy, 'mention-or-command') AS trigger_policy,
			cg.allow_trigger AS raw_grant_trigger,
			cg.allow_context AS raw_grant_context,
			LEAST(
				COALESCE(NULLIF(cg.max_messages, 0), NULLIF(bs.max_context_messages, 0), 50),
				COALESCE(NULLIF(bs.max_context_messages, 0), 50)
			) AS max_messages,
			COALESCE(gp.status, '') AS group_policy_status,
			COALESCE(peer.peer_visible, FALSE) AS peer_visible,
			COALESCE(latest.created_at, c.created_at) AS activity_at
		FROM conversation_members cm
		JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
		JOIN workspace_agent_bots b ON b.id = $2 AND b.space_id = $1
		LEFT JOIN workspace_agent_bot_settings bs ON bs.bot_id = b.id AND bs.space_id = $1
		LEFT JOIN workspace_agent_bot_context_grants cg ON cg.bot_id = b.id AND cg.space_id = $1 AND cg.conversation_id = c.id
		LEFT JOIN workspace_agent_bot_group_policies gp ON gp.bot_id = b.id AND gp.space_id = $1 AND gp.conversation_id = c.id
		LEFT JOIN LATERAL (
			SELECT
				u.id AS peer_id,
				COALESCE(NULLIF(u.nickname, ''), NULLIF(u.display_name, ''), NULLIF(u.github_login, ''), '成员') AS peer_name,
				EXISTS (
					SELECT 1 FROM workspace_agent_bot_visibility_members vm
					WHERE vm.bot_id = b.id AND vm.space_id = $1 AND vm.user_id = u.id
				) AS peer_visible
			FROM conversation_members pcm
			JOIN users u ON u.id = pcm.user_id
			WHERE pcm.conversation_id = c.id AND pcm.user_id <> $3 AND pcm.removed_at IS NULL
			ORDER BY pcm.joined_at ASC, u.id ASC
			LIMIT 1
		) peer ON c.type = 'direct'
		LEFT JOIN LATERAL (
			SELECT m.created_at
			FROM messages m
			WHERE m.conversation_id = c.id AND m.space_id = $1 AND m.deleted_at IS NULL
			ORDER BY m.created_at DESC, m.id DESC
			LIMIT 1
		) latest ON TRUE
		WHERE cm.user_id = $3 AND cm.removed_at IS NULL AND c.type IN ('direct', 'group')
		ORDER BY is_owner_direct DESC, activity_at DESC, c.id ASC
	`, r.spaceID, botID, botUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]BotConversationSummary, 0, 8)
	for rows.Next() {
		var (
			item              BotConversationSummary
			botStatus         string
			visPolicy         string
			allowDirect       bool
			allowGroupCapable bool
			triggerPolicy     string
			rawGrantTrigger   *int
			rawGrantContext   *int
			peerVisible       bool
			activityAt        time.Time
		)
		if err := rows.Scan(
			&item.ID,
			&item.Type,
			&item.Title,
			&item.IsOwnerDirect,
			&botStatus,
			&visPolicy,
			&allowDirect,
			&allowGroupCapable,
			&triggerPolicy,
			&rawGrantTrigger,
			&rawGrantContext,
			&item.MaxMessages,
			&item.GroupPolicyStatus,
			&peerVisible,
			&activityAt,
		); err != nil {
			return nil, err
		}

		activeBot := botStatus == "active"
		if item.Type == "direct" {
			item.TriggerMode = "direct"
			grantTrigger := true
			if rawGrantTrigger != nil {
				grantTrigger = *rawGrantTrigger == 1
			}
			if item.IsOwnerDirect {
				grantTrigger = true
			}
			grantContext := true
			if rawGrantContext != nil {
				grantContext = *rawGrantContext == 1
			}
			memberAllowed := item.IsOwnerDirect ||
				visPolicy == "space_members" ||
				(visPolicy == "specified_members" && peerVisible)
			sendAllowed := activeBot && (item.IsOwnerDirect || allowDirect)
			item.AllowSend = sendAllowed
			item.AllowContext = sendAllowed && grantContext
			item.AllowTrigger = sendAllowed && memberAllowed && grantTrigger
			switch {
			case !activeBot:
				item.BlockReason = "bot_paused"
			case !item.IsOwnerDirect && !allowDirect:
				item.BlockReason = "direct_disabled"
			case !memberAllowed:
				item.BlockReason = "peer_not_in_visibility"
			case !grantTrigger:
				item.BlockReason = "trigger_grant_off"
			}
		} else {
			if triggerPolicy == "all-messages" {
				item.TriggerMode = "all_messages"
			} else {
				item.TriggerMode = "mention_or_command"
			}
			grantTrigger := rawGrantTrigger != nil && *rawGrantTrigger == 1
			grantContext := rawGrantContext != nil && *rawGrantContext == 1
			sendAllowed := activeBot && allowGroupCapable && item.GroupPolicyStatus == "active"
			item.AllowSend = sendAllowed
			item.AllowContext = sendAllowed && grantContext
			item.AllowTrigger = sendAllowed && grantTrigger
			switch {
			case !activeBot:
				item.BlockReason = "bot_paused"
			case !allowGroupCapable:
				item.BlockReason = "group_disabled"
			case item.GroupPolicyStatus == "pending":
				item.BlockReason = "group_pending_approval"
			case item.GroupPolicyStatus != "active":
				item.BlockReason = "group_not_authorized"
			case !grantTrigger:
				item.BlockReason = "trigger_grant_off"
			}
		}

		item.UpdatedAt = activityAt.UTC().Format(time.RFC3339Nano)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *PGRepository) ForwardMessages(ctx context.Context, actorID, targetConversationID string, messageIDs []string, now time.Time) ([]string, error) {
	var isMember bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND removed_at IS NULL
		)
	`, targetConversationID, actorID).Scan(&isMember)
	if err != nil || !isMember {
		return nil, ErrForbidden
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	created := make([]string, 0, len(messageIDs))
	for _, srcID := range messageIDs {
		var plainText, contentJSON, origAuthor string
		err := tx.QueryRow(ctx, `
			SELECT m.plain_text, m.content_json, coalesce(u.display_name, '成员')
			FROM messages m
			JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
			LEFT JOIN users u ON u.id = m.author_id
			WHERE m.id = $2 AND m.deleted_at IS NULL
		`, actorID, srcID).Scan(&plainText, &contentJSON, &origAuthor)
		if err != nil {
			return nil, ErrNotFound
		}
		newID := randomID("msg")
		metaJSON, _ := json.Marshal(map[string]any{"sourceMessageId": srcID, "authorName": origAuthor})
		_, err = tx.Exec(ctx, `
			INSERT INTO messages (id, space_id, conversation_id, author_id, author_kind, kind, content_format, content_json, plain_text, forwarded_from_json, created_at)
			VALUES ($1, $2, $3, $4, 'human', 'user', 'duallane.message+json;v=1', $5, $6, $7, $8)
		`, newID, r.spaceID, targetConversationID, actorID, contentJSON, plainText, string(metaJSON), now)
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO message_attachments (message_id, attachment_id)
			SELECT $1, attachment_id FROM message_attachments WHERE message_id = $2
			ON CONFLICT DO NOTHING
		`, newID, srcID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO message_custom_emotes (message_id, custom_emote_id)
			SELECT $1, custom_emote_id FROM message_custom_emotes WHERE message_id = $2
			ON CONFLICT DO NOTHING
		`, newID, srcID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO message_emote_collection_shares (message_id, share_id)
			SELECT $1, share_id FROM message_emote_collection_shares WHERE message_id = $2
			ON CONFLICT DO NOTHING
		`, newID, srcID); err != nil {
			return nil, err
		}
		if err := emitMessageCreatedEvent(ctx, tx, r.spaceID, actorID, targetConversationID, newID, now); err != nil {
			return nil, err
		}
		created = append(created, newID)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return created, nil
}

func emitWorkspaceEventTx(
	ctx context.Context,
	tx pgx.Tx,
	spaceID, actorID, conversationID, eventType, targetType, targetID string,
	payload map[string]any,
	now time.Time,
) error {
	var nextSeq int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO workspace_event_cursors (space_id, next_seq)
		VALUES ($1, 2)
		ON CONFLICT (space_id) DO UPDATE
		SET next_seq = workspace_event_cursors.next_seq + 1
		RETURNING next_seq - 1
	`, spaceID).Scan(&nextSeq); err != nil {
		return err
	}
	payloadBytes, _ := json.Marshal(payload)
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_events (
			id, space_id, seq, type, actor_user_id, conversation_id,
			target_type, target_id, payload_json, created_at
		)
		VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9, $10)
	`, randomID("evt"), spaceID, nextSeq, eventType, actorID, conversationID, targetType, targetID, string(payloadBytes), now.UTC()); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `SELECT pg_notify('duallane_workspace_events', '')`)
	return err
}

func emitMessageCreatedEvent(ctx context.Context, tx pgx.Tx, spaceID, actorID, conversationID, messageID string, now time.Time) error {
	return emitWorkspaceEventTx(ctx, tx, spaceID, actorID, conversationID, "message.created", "message", messageID, map[string]any{
		"conversationId": conversationID,
		"messageId":      messageID,
	}, now)
}

func insertGroupSystemMessageTx(ctx context.Context, tx pgx.Tx, spaceID, actorID, conversationID, plainText string, now time.Time) error {
	text := strings.TrimSpace(plainText)
	if text == "" {
		return nil
	}
	msgID := randomID("msg")
	contentJSON, _ := json.Marshal(map[string]any{
		"format":    "duallane.message+json;v=1",
		"plainText": text,
		"blocks":    []map[string]any{{"type": "text", "text": text}},
	})
	if _, err := tx.Exec(ctx, `
		INSERT INTO messages (
			id, space_id, conversation_id, author_id, author_kind, kind,
			content_format, content_json, plain_text, created_at
		)
		VALUES ($1, $2, $3, NULL, 'system', 'system', 'duallane.message+json;v=1', $4, $5, $6)
	`, msgID, spaceID, conversationID, string(contentJSON), text, now.UTC()); err != nil {
		return err
	}
	return emitWorkspaceEventTx(ctx, tx, spaceID, actorID, conversationID, "message.created", "message", msgID, map[string]any{
		"conversationId": conversationID,
		"messageId":      msgID,
		"message": map[string]any{
			"id":             msgID,
			"conversationId": conversationID,
			"kind":           "system",
			"plainText":      text,
			"createdAt":      now.UTC().Format(time.RFC3339Nano),
		},
	}, now)
}

func resolveHumanSpaceParticipantTx(ctx context.Context, tx pgx.Tx, spaceID, userID string) (role string, displayName string, err error) {
	var kind string
	err = tx.QueryRow(ctx, `
		SELECT sm.role, u.kind, coalesce(nullif(u.nickname, ''), nullif(u.display_name, ''), nullif(u.github_login, ''), '成员')
		FROM space_members sm
		JOIN users u ON u.id = sm.user_id
		WHERE sm.space_id = $1 AND sm.user_id = $2 AND sm.removed_at IS NULL
	`, spaceID, userID).Scan(&role, &kind, &displayName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", ErrForbidden
		}
		return "", "", err
	}
	if kind != "human" || (role != "owner" && role != "admin" && role != "member") {
		return "", "", ErrForbidden
	}
	return role, displayName, nil
}

func canInviteSpaceMemberTx(ctx context.Context, tx pgx.Tx, spaceID, actorID, actorRole, targetID string) (GroupMemberSummary, error) {
	var summary GroupMemberSummary
	var discoverable bool
	err := tx.QueryRow(ctx, `
		SELECT
			u.id,
			coalesce(nullif(u.nickname, ''), nullif(u.display_name, ''), nullif(u.github_login, ''), '成员'),
			coalesce(u.github_login, ''),
			u.kind,
			sm.role,
			coalesce(u.avatar_url, ''),
			u.search_discoverable
		FROM space_members sm
		JOIN users u ON u.id = sm.user_id
		WHERE sm.space_id = $1 AND sm.user_id = $2 AND sm.removed_at IS NULL
	`, spaceID, targetID).Scan(
		&summary.ID,
		&summary.DisplayName,
		&summary.GitHubLogin,
		&summary.Kind,
		&summary.Role,
		&summary.AvatarURL,
		&discoverable,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return GroupMemberSummary{}, fmt.Errorf("%w: 目标成员不存在", ErrInvalidInput)
		}
		return GroupMemberSummary{}, err
	}
	if summary.Role == "auditor" {
		return GroupMemberSummary{}, fmt.Errorf("%w: 该账号不可加入群聊", ErrInvalidInput)
	}
	summary.AvatarURL = sanitizeBootstrapAvatarURL(summary.AvatarURL)
	if summary.Kind == "bot" {
		summary.Role = "member"
		summary.GitHubLogin = ""
		var botAllowed bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1
				FROM workspace_agent_bots b
				LEFT JOIN workspace_agent_bot_settings bs ON bs.bot_id = b.id AND bs.space_id = b.space_id
				WHERE b.space_id = $1
				  AND b.bot_user_id = $2
				  AND b.status = 'active'
				  AND (
					b.owner_user_id = $3
					OR (
						b.conversation_policy = 'group-capable'
						AND COALESCE(bs.allow_group, 1) = 1
						AND (
							$4 IN ('owner', 'admin')
							OR b.visibility_policy IN ('space', 'space_members', 'groups')
							OR EXISTS (
								SELECT 1 FROM workspace_agent_bot_visibility_members bvm
								WHERE bvm.bot_id = b.id AND bvm.space_id = $1 AND bvm.user_id = $3
							)
						)
					)
				  )
			)
		`, spaceID, targetID, actorID, actorRole).Scan(&botAllowed); err != nil {
			return GroupMemberSummary{}, err
		}
		if !botAllowed {
			return GroupMemberSummary{}, fmt.Errorf("%w: 该机器人当前不可加入群聊或尚未启用", ErrInvalidInput)
		}
		return summary, nil
	}
	if summary.Kind != "human" {
		return GroupMemberSummary{}, fmt.Errorf("%w: 该账号不可加入群聊", ErrInvalidInput)
	}
	if actorRole == "owner" || actorRole == "admin" || discoverable {
		return summary, nil
	}
	var visible bool
	err = tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM member_visibility_grants g
			WHERE g.space_id = $1 AND g.viewer_user_id = $2 AND g.visible_user_id = $3
		) OR EXISTS (
			SELECT 1
			FROM conversations c
			JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = $2 AND cm1.removed_at IS NULL
			JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = $3 AND cm2.removed_at IS NULL
			WHERE c.space_id = $1
		)
	`, spaceID, actorID, targetID).Scan(&visible)
	if err != nil {
		return GroupMemberSummary{}, err
	}
	if !visible {
		return GroupMemberSummary{}, ErrForbidden
	}
	return summary, nil
}

func loadGroupSummaryTx(ctx context.Context, tx pgx.Tx, spaceID, conversationID string) (GroupConversationSummary, error) {
	var out GroupConversationSummary
	var createdAt time.Time
	err := tx.QueryRow(ctx, `
		SELECT id, type, title, avatar_emoji, created_at
		FROM conversations
		WHERE space_id = $1 AND id = $2
	`, spaceID, conversationID).Scan(&out.ID, &out.Type, &out.Title, &out.AvatarEmoji, &createdAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return GroupConversationSummary{}, ErrNotFound
		}
		return GroupConversationSummary{}, err
	}
	out.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	out.MemberIDs = []string{}
	out.Members = []GroupMemberSummary{}

	rows, err := tx.Query(ctx, `
		SELECT
			u.id,
			coalesce(nullif(u.nickname, ''), nullif(u.display_name, ''), nullif(u.github_login, ''), '成员'),
			coalesce(u.github_login, ''),
			u.kind,
			coalesce(sm.role, 'member'),
			coalesce(u.avatar_url, '')
		FROM conversation_members cm
		JOIN users u ON u.id = cm.user_id
		LEFT JOIN space_members sm ON sm.space_id = $1 AND sm.user_id = cm.user_id AND sm.removed_at IS NULL
		WHERE cm.conversation_id = $2 AND cm.removed_at IS NULL
		ORDER BY cm.joined_at ASC, u.id ASC
	`, spaceID, conversationID)
	if err != nil {
		return GroupConversationSummary{}, err
	}
	defer rows.Close()

	for rows.Next() {
		var m GroupMemberSummary
		if err := rows.Scan(&m.ID, &m.DisplayName, &m.GitHubLogin, &m.Kind, &m.Role, &m.AvatarURL); err != nil {
			return GroupConversationSummary{}, err
		}
		m.AvatarURL = sanitizeBootstrapAvatarURL(m.AvatarURL)
		if m.Kind == "bot" || strings.HasPrefix(m.GitHubLogin, "__duallane_") {
			m.GitHubLogin = ""
		}
		out.MemberIDs = append(out.MemberIDs, m.ID)
		out.Members = append(out.Members, m)
	}
	return out, rows.Err()
}

func (r *PGRepository) CreateGroupConversation(ctx context.Context, actorID string, input CreateGroupInput, now time.Time) (GroupConversationSummary, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return GroupConversationSummary{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	actorRole, actorName, err := resolveHumanSpaceParticipantTx(ctx, tx, r.spaceID, actorID)
	if err != nil {
		return GroupConversationSummary{}, err
	}

	invitees := make([]GroupMemberSummary, 0, len(input.MemberIDs))
	for _, peerID := range input.MemberIDs {
		member, err := canInviteSpaceMemberTx(ctx, tx, r.spaceID, actorID, actorRole, peerID)
		if err != nil {
			return GroupConversationSummary{}, err
		}
		invitees = append(invitees, member)
	}

	convID := randomID("conv")
	var avatarArg any
	if input.Avatar != nil && strings.TrimSpace(*input.Avatar) != "" {
		avatarArg = strings.TrimSpace(*input.Avatar)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO conversations (id, space_id, type, title, avatar_emoji, direct_key, retention_count, created_by, created_at)
		VALUES ($1, $2, 'group', $3, $4, NULL, 10000, $5, $6)
	`, convID, r.spaceID, input.Title, avatarArg, actorID, now.UTC()); err != nil {
		return GroupConversationSummary{}, err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, removed_at)
		VALUES ($1, $2, 'owner', $3, NULL)
	`, convID, actorID, now.UTC()); err != nil {
		return GroupConversationSummary{}, err
	}
	for _, inv := range invitees {
		if _, err := tx.Exec(ctx, `
			INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, removed_at)
			VALUES ($1, $2, 'member', $3, NULL)
			ON CONFLICT (conversation_id, user_id) DO UPDATE SET removed_at = NULL, joined_at = EXCLUDED.joined_at
		`, convID, inv.ID, now.UTC()); err != nil {
			return GroupConversationSummary{}, err
		}
		if inv.Kind == "bot" {
			if err := ensureBotGroupAccessTx(ctx, tx, r.spaceID, actorID, convID, inv.ID, now); err != nil {
				return GroupConversationSummary{}, err
			}
		}
	}

	summary, err := loadGroupSummaryTx(ctx, tx, r.spaceID, convID)
	if err != nil {
		return GroupConversationSummary{}, err
	}

	if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, convID, "conversation.created", "conversation", convID, map[string]any{
		"conversationId": convID,
		"type":           "group",
		"title":          summary.Title,
		"avatarEmoji":    summary.AvatarEmoji,
		"conversation":   summary,
	}, now); err != nil {
		return GroupConversationSummary{}, err
	}
	for _, inv := range invitees {
		if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, convID, "conversation.member_added", "user", inv.ID, map[string]any{
			"conversationId": convID,
			"userId":         inv.ID,
			"member":         inv,
		}, now); err != nil {
			return GroupConversationSummary{}, err
		}
	}
	if err := insertGroupSystemMessageTx(ctx, tx, r.spaceID, actorID, convID, fmt.Sprintf("%s 创建了群聊「%s」", actorName, summary.Title), now); err != nil {
		return GroupConversationSummary{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return GroupConversationSummary{}, err
	}
	return summary, nil
}

func (r *PGRepository) UpdateGroupConversation(ctx context.Context, actorID, conversationID string, input UpdateGroupInput, now time.Time) (GroupConversationSummary, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return GroupConversationSummary{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, actorName, err := resolveHumanSpaceParticipantTx(ctx, tx, r.spaceID, actorID)
	if err != nil {
		return GroupConversationSummary{}, err
	}

	var convType, currentTitle string
	var currentAvatar *string
	err = tx.QueryRow(ctx, `
		SELECT c.type, c.title, c.avatar_emoji
		FROM conversations c
		JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $3 AND cm.removed_at IS NULL
		WHERE c.space_id = $1 AND c.id = $2
		FOR UPDATE OF c
	`, r.spaceID, conversationID, actorID).Scan(&convType, &currentTitle, &currentAvatar)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return GroupConversationSummary{}, ErrForbidden
		}
		return GroupConversationSummary{}, err
	}
	if convType != "group" {
		return GroupConversationSummary{}, fmt.Errorf("%w: 仅群聊支持编辑资料", ErrInvalidInput)
	}

	nextTitle := currentTitle
	if input.TitleSet && input.Title != nil {
		nextTitle = *input.Title
	}

	nextAvatar := currentAvatar
	avatarKind := ""
	if input.AvatarSet {
		if input.Avatar == nil || strings.TrimSpace(*input.Avatar) == "" {
			nextAvatar = nil
			avatarKind = "empty"
		} else {
			kind, norm, attID, err := NormalizeGroupAvatarValue(*input.Avatar)
			if err != nil {
				return GroupConversationSummary{}, err
			}
			avatarKind = kind
			if kind == "file" {
				var validImage bool
				if err := tx.QueryRow(ctx, `
					SELECT EXISTS (
						SELECT 1 FROM attachments
						WHERE id = $1 AND space_id = $2 AND conversation_id = $3
						  AND status = 'available' AND mime_type LIKE 'image/%'
					)
				`, attID, r.spaceID, conversationID).Scan(&validImage); err != nil {
					return GroupConversationSummary{}, err
				}
				if !validImage {
					return GroupConversationSummary{}, fmt.Errorf("%w: 群头像图片不存在或不属于当前群聊", ErrInvalidInput)
				}
			}
			nextAvatar = &norm
		}
	}

	var avatarArg any
	if nextAvatar != nil {
		avatarArg = *nextAvatar
	}
	if _, err := tx.Exec(ctx, `
		UPDATE conversations SET title = $1, avatar_emoji = $2
		WHERE space_id = $3 AND id = $4 AND type = 'group'
	`, nextTitle, avatarArg, r.spaceID, conversationID); err != nil {
		return GroupConversationSummary{}, err
	}

	summary, err := loadGroupSummaryTx(ctx, tx, r.spaceID, conversationID)
	if err != nil {
		return GroupConversationSummary{}, err
	}

	if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, conversationID, "conversation.updated", "conversation", conversationID, map[string]any{
		"conversationId": conversationID,
		"title":          summary.Title,
		"avatarEmoji":    summary.AvatarEmoji,
		"conversation":   summary,
	}, now); err != nil {
		return GroupConversationSummary{}, err
	}

	if input.TitleSet && nextTitle != currentTitle {
		if err := insertGroupSystemMessageTx(ctx, tx, r.spaceID, actorID, conversationID, fmt.Sprintf("%s 将群聊名称改为「%s」", actorName, nextTitle), now); err != nil {
			return GroupConversationSummary{}, err
		}
	}
	oldAvatarStr := ""
	if currentAvatar != nil {
		oldAvatarStr = *currentAvatar
	}
	newAvatarStr := ""
	if nextAvatar != nil {
		newAvatarStr = *nextAvatar
	}
	if input.AvatarSet && oldAvatarStr != newAvatarStr {
		sysMsg := fmt.Sprintf("%s 恢复了默认群头像", actorName)
		if avatarKind == "file" {
			sysMsg = fmt.Sprintf("%s 更新了群头像", actorName)
		} else if avatarKind == "emoji" && nextAvatar != nil {
			sysMsg = fmt.Sprintf("%s 将群头像改为 %s", actorName, *nextAvatar)
		}
		if err := insertGroupSystemMessageTx(ctx, tx, r.spaceID, actorID, conversationID, sysMsg, now); err != nil {
			return GroupConversationSummary{}, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return GroupConversationSummary{}, err
	}
	return summary, nil
}

func (r *PGRepository) AddGroupMembers(ctx context.Context, actorID, conversationID string, userIDs []string, now time.Time) (GroupConversationSummary, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return GroupConversationSummary{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	actorRole, actorName, err := resolveHumanSpaceParticipantTx(ctx, tx, r.spaceID, actorID)
	if err != nil {
		return GroupConversationSummary{}, err
	}

	var convType string
	err = tx.QueryRow(ctx, `
		SELECT c.type
		FROM conversations c
		JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $3 AND cm.removed_at IS NULL
		WHERE c.space_id = $1 AND c.id = $2
		FOR UPDATE OF c
	`, r.spaceID, conversationID, actorID).Scan(&convType)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return GroupConversationSummary{}, ErrForbidden
		}
		return GroupConversationSummary{}, err
	}
	if convType != "group" {
		return GroupConversationSummary{}, fmt.Errorf("%w: 仅群聊支持邀请成员", ErrInvalidInput)
	}

	addedNames := make([]string, 0, len(userIDs))
	for _, uid := range userIDs {
		member, err := canInviteSpaceMemberTx(ctx, tx, r.spaceID, actorID, actorRole, uid)
		if err != nil {
			return GroupConversationSummary{}, err
		}
		var alreadyActive bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM conversation_members
				WHERE conversation_id = $1 AND user_id = $2 AND removed_at IS NULL
			)
		`, conversationID, member.ID).Scan(&alreadyActive); err != nil {
			return GroupConversationSummary{}, err
		}
		if alreadyActive {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, removed_at)
			VALUES ($1, $2, 'member', $3, NULL)
			ON CONFLICT (conversation_id, user_id) DO UPDATE SET removed_at = NULL, joined_at = EXCLUDED.joined_at
		`, conversationID, member.ID, now.UTC()); err != nil {
			return GroupConversationSummary{}, err
		}
		if member.Kind == "bot" {
			if err := ensureBotGroupAccessTx(ctx, tx, r.spaceID, actorID, conversationID, member.ID, now); err != nil {
				return GroupConversationSummary{}, err
			}
		}
		addedNames = append(addedNames, member.DisplayName)
		if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, conversationID, "conversation.member_added", "user", member.ID, map[string]any{
			"conversationId": conversationID,
			"userId":         member.ID,
			"member":         member,
		}, now); err != nil {
			return GroupConversationSummary{}, err
		}
	}

	summary, err := loadGroupSummaryTx(ctx, tx, r.spaceID, conversationID)
	if err != nil {
		return GroupConversationSummary{}, err
	}

	if len(addedNames) > 0 {
		if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, conversationID, "conversation.updated", "conversation", conversationID, map[string]any{
			"conversationId": conversationID,
			"title":          summary.Title,
			"avatarEmoji":    summary.AvatarEmoji,
			"conversation":   summary,
		}, now); err != nil {
			return GroupConversationSummary{}, err
		}
		if err := insertGroupSystemMessageTx(ctx, tx, r.spaceID, actorID, conversationID, fmt.Sprintf("%s 邀请 %s 加入群聊", actorName, strings.Join(addedNames, "、")), now); err != nil {
			return GroupConversationSummary{}, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return GroupConversationSummary{}, err
	}
	return summary, nil
}

func (r *PGRepository) LeaveGroupConversation(ctx context.Context, actorID, conversationID string, now time.Time) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, actorName, err := resolveHumanSpaceParticipantTx(ctx, tx, r.spaceID, actorID)
	if err != nil {
		return err
	}

	var convType string
	err = tx.QueryRow(ctx, `
		SELECT c.type
		FROM conversations c
		JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $3 AND cm.removed_at IS NULL
		WHERE c.space_id = $1 AND c.id = $2
		FOR UPDATE OF c
	`, r.spaceID, conversationID, actorID).Scan(&convType)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if convType != "group" {
		return fmt.Errorf("%w: 仅群聊支持退出操作", ErrInvalidInput)
	}

	tag, err := tx.Exec(ctx, `
		UPDATE conversation_members
		SET removed_at = $1
		WHERE conversation_id = $2 AND user_id = $3 AND removed_at IS NULL
	`, now.UTC(), conversationID, actorID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}

	if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, conversationID, "conversation.member_removed", "user", actorID, map[string]any{
		"conversationId": conversationID,
		"userId":         actorID,
		"self":           true,
	}, now); err != nil {
		return err
	}
	if err := insertGroupSystemMessageTx(ctx, tx, r.spaceID, actorID, conversationID, fmt.Sprintf("%s 离开了群聊", actorName), now); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

func ensureBotGroupAccessTx(ctx context.Context, tx pgx.Tx, spaceID, actorID, conversationID, botUserID string, now time.Time) error {
	var botID, ownerID string
	err := tx.QueryRow(ctx, `
		SELECT id, owner_user_id
		FROM workspace_agent_bots
		WHERE space_id = $1 AND bot_user_id = $2 AND status <> 'deleted'
	`, spaceID, botUserID).Scan(&botID, &ownerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}
	if ownerID == actorID {
		if _, err := tx.Exec(ctx, `
			UPDATE workspace_agent_bots
			SET conversation_policy = 'group-capable', updated_at = $1
			WHERE id = $2 AND space_id = $3
		`, now.UTC(), botID, spaceID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE workspace_agent_bot_settings
			SET allow_group = 1, updated_at = $1
			WHERE bot_id = $2 AND space_id = $3
		`, now.UTC(), botID, spaceID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_agent_bot_group_policies (
			bot_id, space_id, conversation_id, status, invited_by, approved_by, max_context_messages, created_at, updated_at
		)
		VALUES ($1, $2, $3, 'active', $4, $4, 50, $5, $5)
		ON CONFLICT (bot_id, conversation_id) DO UPDATE
		SET status = 'active',
		    invited_by = EXCLUDED.invited_by,
		    approved_by = EXCLUDED.approved_by,
		    updated_at = EXCLUDED.updated_at
	`, botID, spaceID, conversationID, actorID, now.UTC()); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_agent_bot_context_grants (
			grant_id, bot_id, space_id, conversation_id, allow_trigger, allow_context, max_messages, granted_by, created_at, updated_at
		)
		VALUES ($1, $2, $3, $4, 1, 1, 50, $5, $6, $6)
		ON CONFLICT (bot_id, conversation_id) DO UPDATE
		SET allow_trigger = 1,
		    allow_context = 1,
		    max_messages = GREATEST(COALESCE(workspace_agent_bot_context_grants.max_messages, 0), 50),
		    granted_by = EXCLUDED.granted_by,
		    updated_at = EXCLUDED.updated_at
	`, randomID("bgr"), botID, spaceID, conversationID, actorID, now.UTC()); err != nil {
		return err
	}
	return nil
}

func (r *PGRepository) RemoveGroupMember(ctx context.Context, actorID, conversationID, targetUserID string, now time.Time) (GroupConversationSummary, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return GroupConversationSummary{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	actorRole, actorName, err := resolveHumanSpaceParticipantTx(ctx, tx, r.spaceID, actorID)
	if err != nil {
		return GroupConversationSummary{}, err
	}

	var convType, createdBy string
	err = tx.QueryRow(ctx, `
		SELECT c.type, coalesce(c.created_by, '')
		FROM conversations c
		JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $3 AND cm.removed_at IS NULL
		WHERE c.space_id = $1 AND c.id = $2
		FOR UPDATE OF c
	`, r.spaceID, conversationID, actorID).Scan(&convType, &createdBy)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return GroupConversationSummary{}, ErrForbidden
		}
		return GroupConversationSummary{}, err
	}
	if convType != "group" {
		return GroupConversationSummary{}, fmt.Errorf("%w: 仅群聊支持移除成员", ErrInvalidInput)
	}

	var targetKind, targetName string
	err = tx.QueryRow(ctx, `
		SELECT u.kind, coalesce(nullif(u.nickname, ''), nullif(u.display_name, ''), nullif(u.github_login, ''), '成员')
		FROM conversation_members cm
		JOIN users u ON u.id = cm.user_id
		WHERE cm.conversation_id = $1 AND cm.user_id = $2 AND cm.removed_at IS NULL
	`, conversationID, targetUserID).Scan(&targetKind, &targetName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return GroupConversationSummary{}, ErrNotFound
		}
		return GroupConversationSummary{}, err
	}

	if targetKind != "bot" && actorRole != "owner" && actorRole != "admin" && createdBy != actorID {
		return GroupConversationSummary{}, ErrForbidden
	}

	if _, err := tx.Exec(ctx, `
		UPDATE conversation_members
		SET removed_at = $1
		WHERE conversation_id = $2 AND user_id = $3 AND removed_at IS NULL
	`, now.UTC(), conversationID, targetUserID); err != nil {
		return GroupConversationSummary{}, err
	}
	if targetKind == "bot" {
		_, _ = tx.Exec(ctx, `
			UPDATE workspace_agent_bot_group_policies
			SET status = 'revoked', updated_at = $1
			WHERE space_id = $2 AND conversation_id = $3
			  AND bot_id IN (SELECT id FROM workspace_agent_bots WHERE space_id = $2 AND bot_user_id = $4)
		`, now.UTC(), r.spaceID, conversationID, targetUserID)
	}

	summary, err := loadGroupSummaryTx(ctx, tx, r.spaceID, conversationID)
	if err != nil {
		return GroupConversationSummary{}, err
	}

	if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, conversationID, "conversation.member_removed", "user", targetUserID, map[string]any{
		"conversationId": conversationID,
		"userId":         targetUserID,
		"self":           false,
	}, now); err != nil {
		return GroupConversationSummary{}, err
	}
	if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, conversationID, "conversation.updated", "conversation", conversationID, map[string]any{
		"conversationId": conversationID,
		"title":          summary.Title,
		"avatarEmoji":    summary.AvatarEmoji,
		"conversation":   summary,
	}, now); err != nil {
		return GroupConversationSummary{}, err
	}
	if err := insertGroupSystemMessageTx(ctx, tx, r.spaceID, actorID, conversationID, fmt.Sprintf("%s 将 %s 移出了群聊", actorName, targetName), now); err != nil {
		return GroupConversationSummary{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return GroupConversationSummary{}, err
	}
	return summary, nil
}

func (r *PGRepository) MarkConversationRead(ctx context.Context, actorID, conversationID string, now time.Time) (string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var isMember bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversation_members cm
			JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
			WHERE cm.conversation_id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL
		)
	`, r.spaceID, conversationID, actorID).Scan(&isMember); err != nil {
		return "", err
	}
	if !isMember {
		return "", ErrForbidden
	}

	var messageID *string
	var messageAt *time.Time
	var sequence int64
	if err := tx.QueryRow(ctx, `
		SELECT
			latest.id,
			latest.created_at,
			COALESCE(latest.event_seq, (SELECT COALESCE(MAX(seq), 0) FROM workspace_events WHERE space_id = $1))
		FROM (VALUES (1)) anchor(one)
		LEFT JOIN LATERAL (
			SELECT m.id, m.created_at, we.seq AS event_seq
			FROM messages m
			LEFT JOIN workspace_events we
				ON we.space_id = m.space_id
				AND we.conversation_id = m.conversation_id
				AND we.type = 'message.created'
				AND we.target_id = m.id
			WHERE m.space_id = $1 AND m.conversation_id = $2 AND m.topic_id IS NULL AND m.deleted_at IS NULL
			ORDER BY m.created_at DESC, we.seq DESC NULLS LAST, m.id DESC
			LIMIT 1
		) latest ON TRUE
	`, r.spaceID, conversationID).Scan(&messageID, &messageAt, &sequence); err != nil {
		return "", err
	}

	readAt := now.UTC()
	if messageAt != nil && messageAt.UTC().After(readAt) {
		readAt = messageAt.UTC()
	}

	var msgIDArg any
	if messageID != nil && strings.TrimSpace(*messageID) != "" {
		msgIDArg = strings.TrimSpace(*messageID)
	}
	var compareTime time.Time
	if messageAt != nil {
		compareTime = messageAt.UTC()
	} else {
		compareTime = readAt
	}

	tag, err := tx.Exec(ctx, `
		UPDATE conversation_members
		SET last_read_message_id = COALESCE($1, last_read_message_id),
		    last_read_at = GREATEST(COALESCE(last_read_at, $2), $2),
		    last_read_seq = GREATEST(COALESCE(last_read_seq, $3), $3)
		WHERE conversation_id = $4
		  AND user_id = $5
		  AND removed_at IS NULL
		  AND (
			last_read_seq IS NULL
			OR last_read_seq < $3
			OR last_read_at IS NULL
			OR last_read_at < $6
		  )
	`, msgIDArg, readAt, sequence, conversationID, actorID, compareTime)
	if err != nil {
		return "", err
	}

	readAtStr := readAt.Format(time.RFC3339Nano)
	if tag.RowsAffected() > 0 {
		if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, conversationID, "conversation.read", "conversation", conversationID, map[string]any{
			"conversationId": conversationID,
			"userId":         actorID,
			"readAt":         readAtStr,
		}, readAt); err != nil {
			return "", err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return readAtStr, nil
}

func (r *PGRepository) SendConversationTyping(ctx context.Context, actorID, conversationID, kind, state string, now time.Time) (string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var displayName, userKind string
	err = tx.QueryRow(ctx, `
		SELECT
			coalesce(nullif(u.nickname, ''), nullif(u.display_name, ''), nullif(u.github_login, ''), '成员'),
			u.kind
		FROM conversation_members cm
		JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
		JOIN users u ON u.id = cm.user_id
		WHERE cm.conversation_id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL
	`, r.spaceID, conversationID, actorID).Scan(&displayName, &userKind)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrForbidden
		}
		return "", err
	}

	resolvedKind := "human"
	ttl := 4500 * time.Millisecond
	if userKind == "bot" || kind == "bot" {
		resolvedKind = "bot"
		ttl = 6500 * time.Millisecond
		readAt := now.UTC()
		readTag, readErr := tx.Exec(ctx, `
			UPDATE conversation_members
			SET last_read_at = GREATEST(COALESCE(last_read_at, $1), $1)
			WHERE conversation_id = $2 AND user_id = $3 AND removed_at IS NULL
			  AND (last_read_at IS NULL OR last_read_at < $1)
		`, readAt, conversationID, actorID)
		if readErr == nil && readTag.RowsAffected() > 0 {
			_ = emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, conversationID, "conversation.read", "conversation", conversationID, map[string]any{
				"conversationId": conversationID,
				"userId":         actorID,
				"readAt":         readAt.Format(time.RFC3339Nano),
			}, readAt)
		}
	}

	expiresAt := now.UTC().Add(ttl).Format(time.RFC3339Nano)
	if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, conversationID, "conversation.typing", "conversation", conversationID, map[string]any{
		"conversationId": conversationID,
		"userId":         actorID,
		"displayName":    displayName,
		"kind":           resolvedKind,
		"state":          state,
		"expiresAt":      expiresAt,
	}, now); err != nil {
		return "", err
	}

	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return expiresAt, nil
}

func (r *PGRepository) ListConversationThreads(ctx context.Context, actorID, conversationID string) ([]ConversationThreadItem, error) {
	var isMember bool
	if err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversation_members cm
			JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
			WHERE cm.conversation_id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL
		)
	`, r.spaceID, conversationID, actorID).Scan(&isMember); err != nil {
		return nil, err
	}
	if !isMember {
		return nil, ErrForbidden
	}

	rows, err := r.pool.Query(ctx, `
		WITH thread_agg AS (
			SELECT
				r.thread_root_id,
				COUNT(*)::int AS reply_count,
				MAX(r.created_at) AS last_replied_at,
				(ARRAY_AGG(r.id ORDER BY r.created_at DESC, r.id DESC))[1] AS latest_reply_id
			FROM messages r
			WHERE r.space_id = $1
				AND r.conversation_id = $2
				AND r.thread_root_id IS NOT NULL
				AND r.deleted_at IS NULL
				AND r.recalled_at IS NULL
			GROUP BY r.thread_root_id
		)
		SELECT
			root.id,
			root.conversation_id,
			coalesce(root.thread_title, ''),
			coalesce(root.author_id, ''),
			coalesce(
				NULLIF(ur_root.remark, ''),
				NULLIF(u_root.nickname, ''),
				CASE WHEN u_root.kind = 'bot' OR u_root.github_login LIKE '__duallane_%' THEN NULL ELSE NULLIF(u_root.github_login, '') END,
				NULLIF(u_root.display_name, ''),
				CASE WHEN root.author_kind = 'bot' THEN 'Bot' ELSE '成员' END
			) AS root_author_name,
			CASE WHEN root.recalled_at IS NOT NULL THEN '消息已撤回' ELSE coalesce(root.plain_text, '') END AS root_plain_text,
			root.created_at,
			agg.reply_count,
			agg.last_replied_at,
			coalesce(
				NULLIF(ur_last.remark, ''),
				NULLIF(u_last.nickname, ''),
				CASE WHEN u_last.kind = 'bot' OR u_last.github_login LIKE '__duallane_%' THEN NULL ELSE NULLIF(u_last.github_login, '') END,
				NULLIF(u_last.display_name, ''),
				CASE WHEN last_msg.author_kind = 'bot' THEN 'Bot' ELSE '成员' END
			) AS last_author_name,
			coalesce(last_msg.plain_text, '') AS last_plain_text
		FROM thread_agg agg
		JOIN messages root ON root.id = agg.thread_root_id AND root.space_id = $1 AND root.deleted_at IS NULL
		LEFT JOIN users u_root ON u_root.id = root.author_id
		LEFT JOIN user_remarks ur_root ON ur_root.owner_user_id = $3 AND ur_root.target_user_id = u_root.id
		JOIN messages last_msg ON last_msg.id = agg.latest_reply_id
		LEFT JOIN users u_last ON u_last.id = last_msg.author_id
		LEFT JOIN user_remarks ur_last ON ur_last.owner_user_id = $3 AND ur_last.target_user_id = u_last.id
		ORDER BY agg.last_replied_at DESC, root.id DESC
		LIMIT 60
	`, r.spaceID, conversationID, actorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]ConversationThreadItem, 0, 16)
	for rows.Next() {
		var item ConversationThreadItem
		var rootCreatedAt, lastRepliedAt time.Time
		if scanErr := rows.Scan(
			&item.RootMessageID,
			&item.ConversationID,
			&item.ThreadTitle,
			&item.RootAuthorID,
			&item.RootAuthorName,
			&item.RootPlainText,
			&rootCreatedAt,
			&item.ReplyCount,
			&lastRepliedAt,
			&item.LastAuthorName,
			&item.LastPlainText,
		); scanErr != nil {
			return nil, scanErr
		}
		item.RootCreatedAt = rootCreatedAt.UTC().Format(time.RFC3339Nano)
		item.LastRepliedAt = lastRepliedAt.UTC().Format(time.RFC3339Nano)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *PGRepository) GetThread(ctx context.Context, actorID, rootMessageID string) (ThreadView, error) {
	var convID, threadTitle string
	err := r.pool.QueryRow(ctx, `
		SELECT m.conversation_id, coalesce(m.thread_title, '')
		FROM messages m
		JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
		WHERE m.id = $2 AND m.deleted_at IS NULL
	`, actorID, rootMessageID).Scan(&convID, &threadTitle)
	if err != nil {
		return ThreadView{}, ErrNotFound
	}

	rows, err := r.pool.Query(ctx, `
		SELECT
			m.id,
			m.conversation_id,
			m.thread_root_id,
			m.also_send_to_channel,
			coalesce(m.author_id, ''),
			coalesce(
				NULLIF(ur.remark, ''),
				NULLIF(u.nickname, ''),
				CASE WHEN u.kind = 'bot' OR u.github_login LIKE '__duallane_%' THEN NULL ELSE NULLIF(u.github_login, '') END,
				NULLIF(u.display_name, ''),
				CASE WHEN m.author_kind = 'bot' THEN 'Bot' ELSE '成员' END
			),
			coalesce(u.avatar_url, ''),
			m.plain_text,
			m.edited_at,
			m.created_at
		FROM messages m
		LEFT JOIN users u ON u.id = m.author_id
		LEFT JOIN user_remarks ur ON ur.owner_user_id = $2 AND ur.target_user_id = u.id
		WHERE m.thread_root_id = $1 AND m.deleted_at IS NULL AND m.recalled_at IS NULL
		ORDER BY m.created_at ASC, m.id ASC
	`, rootMessageID, actorID)
	if err != nil {
		return ThreadView{}, err
	}
	defer rows.Close()

	replies := make([]ThreadReply, 0)
	for rows.Next() {
		var item ThreadReply
		var editedAt *time.Time
		var createdAt time.Time
		if err := rows.Scan(&item.ID, &item.ConversationID, &item.ThreadRootID, &item.AlsoSendToChannel, &item.AuthorID, &item.AuthorName, &item.AuthorAvatarURL, &item.PlainText, &editedAt, &createdAt); err != nil {
			return ThreadView{}, err
		}
		if editedAt != nil {
			item.EditedAt = editedAt.UTC().Format(time.RFC3339Nano)
		}
		item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		replies = append(replies, item)
	}
	return ThreadView{
		RootMessageID: rootMessageID,
		ThreadTitle:   threadTitle,
		ReplyCount:    len(replies),
		Replies:       replies,
	}, rows.Err()
}

func (r *PGRepository) ReplyThread(ctx context.Context, actorID, rootMessageID, plainText, threadTitle string, alsoSendToChannel bool, now time.Time) (ThreadReply, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return ThreadReply{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var convID, authorName, authorAvatar string
	err = tx.QueryRow(ctx, `
		SELECT
			m.conversation_id,
			coalesce(NULLIF(u.nickname, ''), NULLIF(u.display_name, ''), '成员'),
			coalesce(u.avatar_url, '')
		FROM messages m
		JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.removed_at IS NULL
		LEFT JOIN users u ON u.id = $1
		WHERE m.id = $2 AND m.deleted_at IS NULL
	`, actorID, rootMessageID).Scan(&convID, &authorName, &authorAvatar)
	if err != nil {
		return ThreadReply{}, ErrNotFound
	}

	if threadTitle != "" {
		_, _ = tx.Exec(ctx, `UPDATE messages SET thread_title = $1 WHERE id = $2 AND (thread_title IS NULL OR thread_title = '')`, threadTitle, rootMessageID)
	}

	msgID := randomID("msg")
	contentJSON, _ := json.Marshal(map[string]any{
		"format":    "duallane.message+json;v=1",
		"plainText": plainText,
		"blocks":    []map[string]any{{"type": "text", "text": plainText}},
	})
	var replyToForChannel any
	if alsoSendToChannel {
		replyToForChannel = rootMessageID
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO messages (id, space_id, conversation_id, author_id, author_kind, kind, content_format, content_json, plain_text, reply_to_message_id, thread_root_id, also_send_to_channel, created_at)
		VALUES ($1, $2, $3, $4, 'human', 'user', 'duallane.message+json;v=1', $5, $6, $7, $8, $9, $10)
	`, msgID, r.spaceID, convID, actorID, string(contentJSON), plainText, replyToForChannel, rootMessageID, alsoSendToChannel, now.UTC())
	if err != nil {
		return ThreadReply{}, err
	}

	// Broadcast updated root message (carrying refreshed threadReplyCount & threadPreviewReplies) to all connected clients
	if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, convID, "message.edited", "message", rootMessageID, map[string]any{
		"conversationId": convID,
		"messageId":      rootMessageID,
	}, now.UTC()); err != nil {
		return ThreadReply{}, err
	}

	// If user checked "also send to channel", broadcast message.created so main timeline shows it immediately
	if alsoSendToChannel {
		if err := emitMessageCreatedEvent(ctx, tx, r.spaceID, actorID, convID, msgID, now.UTC()); err != nil {
			return ThreadReply{}, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return ThreadReply{}, err
	}

	return ThreadReply{
		ID:                msgID,
		ConversationID:    convID,
		ThreadRootID:      rootMessageID,
		AlsoSendToChannel: alsoSendToChannel,
		AuthorID:          actorID,
		AuthorName:        authorName,
		AuthorAvatarURL:   authorAvatar,
		PlainText:         plainText,
		CreatedAt:         now.UTC().Format(time.RFC3339Nano),
	}, nil
}

func (r *PGRepository) PinMessage(ctx context.Context, actorID, conversationID, messageID string, now time.Time) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var isMember bool
	err = tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND removed_at IS NULL
		)
	`, conversationID, actorID).Scan(&isMember)
	if err != nil || !isMember {
		return ErrForbidden
	}

	var msgExists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM messages
			WHERE id = $1 AND conversation_id = $2 AND space_id = $3 AND deleted_at IS NULL
		)
	`, messageID, conversationID, r.spaceID).Scan(&msgExists); err != nil {
		return err
	}
	if !msgExists {
		return ErrNotFound
	}

	tag, err := tx.Exec(ctx, `
		INSERT INTO conversation_pinned_messages (conversation_id, message_id, pinned_by_user_id, created_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (conversation_id, message_id) DO NOTHING
	`, conversationID, messageID, actorID, now.UTC())
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, conversationID, "message.pinned", "message", messageID, map[string]any{
			"conversationId": conversationID,
			"messageId":      messageID,
			"pinnedByUserId": actorID,
		}, now); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *PGRepository) UnpinMessage(ctx context.Context, actorID, conversationID, messageID string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var isMember bool
	err = tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND removed_at IS NULL
		)
	`, conversationID, actorID).Scan(&isMember)
	if err != nil || !isMember {
		return ErrForbidden
	}
	tag, err := tx.Exec(ctx, `DELETE FROM conversation_pinned_messages WHERE conversation_id = $1 AND message_id = $2`, conversationID, messageID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, conversationID, "message.unpinned", "message", messageID, map[string]any{
			"conversationId": conversationID,
			"messageId":      messageID,
		}, time.Now().UTC()); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *PGRepository) ListDevices(ctx context.Context, actorID, currentDeviceID string) ([]UserDevice, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, platform, device_name, app_version, last_active_at
		FROM user_devices
		WHERE user_id = $1 AND revoked_at IS NULL
		ORDER BY last_active_at DESC
	`, actorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	devices := make([]UserDevice, 0)
	for rows.Next() {
		var d UserDevice
		var lastActive time.Time
		if err := rows.Scan(&d.ID, &d.Platform, &d.DeviceName, &d.AppVersion, &lastActive); err != nil {
			return nil, err
		}
		d.LastActiveAt = lastActive.UTC().Format(time.RFC3339Nano)
		d.Current = d.ID == currentDeviceID
		devices = append(devices, d)
	}
	return devices, rows.Err()
}

func (r *PGRepository) RevokeDevice(ctx context.Context, actorID, deviceID string, now time.Time) error {
	tag, err := r.pool.Exec(ctx, `
		UPDATE user_devices SET revoked_at = $1 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL
	`, now, deviceID, actorID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *PGRepository) CreateQRSession(ctx context.Context, platform, deviceName string, now time.Time) (QRLoginSession, error) {
	id := randomID("qr")
	challenge := randomID("chl")
	expiresAt := now.Add(5 * time.Minute)
	_, err := r.pool.Exec(ctx, `
		INSERT INTO qr_login_sessions (id, challenge, status, platform, device_name, expires_at, created_at)
		VALUES ($1, $2, 'pending', $3, $4, $5, $6)
	`, id, challenge, platform, deviceName, expiresAt, now)
	if err != nil {
		return QRLoginSession{}, err
	}
	return QRLoginSession{
		ID:         id,
		Challenge:  challenge,
		Status:     "pending",
		Platform:   platform,
		DeviceName: deviceName,
		ExpiresAt:  expiresAt.UTC().Format(time.RFC3339Nano),
	}, nil
}

func (r *PGRepository) ApproveQRSession(ctx context.Context, actorID, sessionID string, now time.Time) (QRLoginSession, error) {
	var item QRLoginSession
	var expiresAt time.Time
	err := r.pool.QueryRow(ctx, `
		UPDATE qr_login_sessions
		SET status = 'approved', user_id = $1, approved_at = $2
		WHERE id = $3 AND status = 'pending' AND expires_at > $2
		RETURNING id, challenge, status, coalesce(platform, ''), coalesce(device_name, ''), expires_at
	`, actorID, now, sessionID).Scan(&item.ID, &item.Challenge, &item.Status, &item.Platform, &item.DeviceName, &expiresAt)
	if err != nil {
		return QRLoginSession{}, ErrNotFound
	}
	item.ExpiresAt = expiresAt.UTC().Format(time.RFC3339Nano)
	return item, nil
}

func (r *PGRepository) ExchangeQRSession(ctx context.Context, sessionID, challenge string, now time.Time) (string, error) {
	var userID, platform, deviceName string
	err := r.pool.QueryRow(ctx, `
		UPDATE qr_login_sessions
		SET status = 'exchanged', consumed_at = $1
		WHERE id = $2 AND challenge = $3 AND status = 'approved' AND expires_at > $1
		RETURNING user_id, coalesce(platform, 'android'), coalesce(device_name, 'DualLane Mobile')
	`, now, sessionID, challenge).Scan(&userID, &platform, &deviceName)
	if err != nil {
		return "", ErrForbidden
	}

	rawToken := randomID("dlm") + "_" + randomID("sec")
	sum := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(sum[:])
	deviceID := randomID("dev")
	_, err = r.pool.Exec(ctx, `
		INSERT INTO user_devices (id, user_id, platform, device_name, token_hash, last_active_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $6)
	`, deviceID, userID, platform, deviceName, tokenHash, now)
	if err != nil {
		return "", err
	}
	return rawToken, nil
}

var reservedServerPrefKeys = []string{
	"boundEmail",
	"boundEmailAt",
	"ackAnnouncementId",
	"systemAnnouncement",
}

func stripReservedPreferenceKeys(prefs map[string]any) {
	if prefs == nil {
		return
	}
	delete(prefs, "boundEmail")
	delete(prefs, "boundEmailAt")
	delete(prefs, "systemAnnouncement")
}

func (r *PGRepository) GetPreferences(ctx context.Context, actorID string) (map[string]any, error) {
	var raw string
	err := r.pool.QueryRow(ctx, `SELECT prefs_json FROM user_preferences WHERE user_id = $1`, actorID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	_ = json.Unmarshal([]byte(raw), &out)
	stripReservedPreferenceKeys(out)
	return out, nil
}

func (r *PGRepository) SavePreferences(ctx context.Context, actorID string, prefs map[string]any, now time.Time) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var existingRaw string
	err = tx.QueryRow(ctx, `SELECT prefs_json FROM user_preferences WHERE user_id = $1 FOR UPDATE`, actorID).Scan(&existingRaw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	existing := map[string]any{}
	if existingRaw != "" {
		_ = json.Unmarshal([]byte(existingRaw), &existing)
	}
	merged := map[string]any{}
	for k, v := range prefs {
		merged[k] = v
	}
	for _, key := range reservedServerPrefKeys {
		delete(merged, key)
		if val, ok := existing[key]; ok {
			merged[key] = val
		}
	}
	encoded, err := json.Marshal(merged)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO user_preferences (user_id, prefs_json, updated_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET prefs_json = EXCLUDED.prefs_json, updated_at = EXCLUDED.updated_at
	`, actorID, string(encoded), now.UTC()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *PGRepository) RegisterBotCommands(ctx context.Context, actorID, botID string, commands []BotCommand, now time.Time) error {
	var ownerID string
	err := r.pool.QueryRow(ctx, `SELECT owner_user_id FROM workspace_agent_bots WHERE id = $1 AND status <> 'deleted'`, botID).Scan(&ownerID)
	if err != nil || ownerID != actorID {
		return ErrForbidden
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, `DELETE FROM bot_commands WHERE bot_id = $1`, botID)
	if err != nil {
		return err
	}
	for _, c := range commands {
		_, err = tx.Exec(ctx, `
			INSERT INTO bot_commands (id, bot_id, command, description, scope, created_at)
			VALUES ($1, $2, $3, $4, $5, $6)
		`, randomID("bcmd"), botID, c.Command, strings.TrimSpace(c.Description), c.Scope, now)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *PGRepository) ListBotCommands(ctx context.Context, actorID, conversationID string) ([]BotCommand, error) {
	var isMember bool
	if err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM conversation_members cm
			JOIN conversations c ON c.id = cm.conversation_id AND c.space_id = $1
			WHERE cm.conversation_id = $2 AND cm.user_id = $3 AND cm.removed_at IS NULL
		)
	`, r.spaceID, conversationID, actorID).Scan(&isMember); err != nil {
		return nil, err
	}
	if !isMember {
		return nil, ErrForbidden
	}

	rows, err := r.pool.Query(ctx, `
		SELECT bc.command, bc.description, bc.scope, b.id, b.name
		FROM bot_commands bc
		JOIN workspace_agent_bots b ON b.id = bc.bot_id AND b.space_id = $1 AND b.status = 'active'
		JOIN conversation_members cm ON cm.user_id = b.bot_user_id AND cm.conversation_id = $2 AND cm.removed_at IS NULL
		ORDER BY b.name ASC, bc.command ASC
	`, r.spaceID, conversationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]BotCommand, 0)
	for rows.Next() {
		var item BotCommand
		if err := rows.Scan(&item.Command, &item.Description, &item.Scope, &item.BotID, &item.BotName); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *PGRepository) ListBotCommandsByBot(ctx context.Context, actorID, botID string) ([]BotCommand, error) {
	var ownerID string
	err := r.pool.QueryRow(ctx, `SELECT owner_user_id FROM workspace_agent_bots WHERE id = $1 AND status <> 'deleted'`, botID).Scan(&ownerID)
	if err != nil || ownerID != actorID {
		return nil, ErrForbidden
	}
	rows, err := r.pool.Query(ctx, `
		SELECT command, description, scope
		FROM bot_commands
		WHERE bot_id = $1
		ORDER BY command ASC
	`, botID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]BotCommand, 0)
	for rows.Next() {
		var item BotCommand
		if err := rows.Scan(&item.Command, &item.Description, &item.Scope); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *PGRepository) CreateMultiBot(ctx context.Context, actorID, name string, now time.Time) (string, error) {
	var count int
	if err := r.pool.QueryRow(ctx, `SELECT count(*) FROM workspace_agent_bots WHERE space_id = $1 AND owner_user_id = $2 AND status <> 'deleted'`, r.spaceID, actorID).Scan(&count); err != nil {
		return "", err
	}
	if count >= 20 {
		return "", ErrRateLimited
	}
	botID := randomID("bot")
	botUserID := randomID("usr_bot")
	norm := strings.ToLower(strings.TrimSpace(name))
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		INSERT INTO users (id, github_id, github_login, display_name, kind, created_at)
		VALUES ($1, NULL, $2, $3, 'bot', $4)
	`, botUserID, "__duallane_"+botID, strings.TrimSpace(name), now); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO space_members (space_id, user_id, role, joined_at)
		VALUES ($1, $2, 'member', $3)
		ON CONFLICT (space_id, user_id) DO NOTHING
	`, r.spaceID, botUserID, now); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_agent_bots (id, space_id, owner_user_id, bot_user_id, mode, name, name_normalized, visibility_policy, conversation_policy, trigger_policy, status, created_at, updated_at)
		VALUES ($1, $2, $3, $4, 'external_agent', $5, $6, 'private', 'group-capable', 'mention-or-command', 'active', $7, $7)
	`, botID, r.spaceID, actorID, botUserID, strings.TrimSpace(name), norm, now); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_agent_bot_settings (bot_id, space_id, visibility_policy, allow_direct, allow_group, group_inviter_policy, require_owner_approval, proactive_enabled, trigger_policy, created_at, updated_at)
		VALUES ($1, $2, 'private', 1, 1, 'owner', 1, 0, 'mention-or-command', $3, $3)
	`, botID, r.spaceID, now); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_agent_bot_limits (bot_id, space_id, created_at, updated_at)
		VALUES ($1, $2, $3, $3)
	`, botID, r.spaceID, now); err != nil {
		return "", err
	}
	// Guarantee Creator Sovereignty out-of-the-box: provision the creator's 1v1 DM & grant immediately.
	dmConvID := randomID("conv")
	dmKey := formatDirectKey(actorID, botUserID)
	if err := tx.QueryRow(ctx, `
		INSERT INTO conversations (id, space_id, type, title, direct_key, retention_count, created_by, created_at)
		VALUES ($1, $2, 'direct', $3, $4, 10000, $5, $6)
		ON CONFLICT (space_id, direct_key)
		DO UPDATE SET title = EXCLUDED.title
		RETURNING id
	`, dmConvID, r.spaceID, strings.TrimSpace(name), dmKey, actorID, now.UTC()).Scan(&dmConvID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO conversation_members (conversation_id, user_id, joined_at, removed_at)
		VALUES ($1, $2, $3, NULL), ($1, $4, $3, NULL)
		ON CONFLICT (conversation_id, user_id) DO UPDATE SET removed_at = NULL
	`, dmConvID, actorID, now.UTC(), botUserID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO workspace_agent_bot_context_grants (
			grant_id, bot_id, space_id, conversation_id, allow_trigger, allow_context, max_messages, granted_by, created_at, updated_at
		)
		VALUES ($1, $2, $3, $4, 1, 1, 50, $5, $6, $6)
		ON CONFLICT (bot_id, conversation_id) DO UPDATE
		SET allow_trigger = 1, allow_context = 1, updated_at = EXCLUDED.updated_at
	`, randomID("bgr"), botID, r.spaceID, dmConvID, actorID, now.UTC()); err != nil {
		return "", err
	}
	_ = emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, "", "workspace.member_joined", "user", botUserID, map[string]any{
		"userId": botUserID,
		"member": map[string]any{
			"id":          botUserID,
			"displayName": strings.TrimSpace(name),
			"kind":        "bot",
			"role":        "member",
		},
	}, now)
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return botID, nil
}

func (r *PGRepository) UpdateBotProfile(ctx context.Context, actorID, botID string, input BotProfileUpdateInput, now time.Time) (BotProfileResult, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return BotProfileResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var ownerID, botUserID, curName, curDesc, curAvatar, rawPrefs string
	err = tx.QueryRow(ctx, `
		SELECT
			b.owner_user_id,
			b.bot_user_id,
			b.name,
			coalesce(bs.description, ''),
			coalesce(u.avatar_url, bs.avatar_url, ''),
			coalesce((SELECT prefs_json FROM user_preferences WHERE user_id = b.bot_user_id), '{}')
		FROM workspace_agent_bots b
		JOIN users u ON u.id = b.bot_user_id
		LEFT JOIN workspace_agent_bot_settings bs ON bs.bot_id = b.id AND bs.space_id = b.space_id
		WHERE b.space_id = $1 AND b.id = $2 AND b.status <> 'deleted'
		FOR UPDATE OF b
	`, r.spaceID, botID).Scan(&ownerID, &botUserID, &curName, &curDesc, &curAvatar, &rawPrefs)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return BotProfileResult{}, ErrNotFound
		}
		return BotProfileResult{}, err
	}
	if ownerID != actorID {
		return BotProfileResult{}, ErrForbidden
	}

	prefs := map[string]any{}
	_ = json.Unmarshal([]byte(rawPrefs), &prefs)
	if prefs == nil {
		prefs = map[string]any{}
	}
	curColor, _ := prefs["botColor"].(string)
	nextColor := curColor
	if input.ColorSet && input.Color != nil {
		nextColor = strings.ToLower(strings.TrimSpace(*input.Color))
		if nextColor == "" {
			delete(prefs, "botColor")
		} else {
			prefs["botColor"] = nextColor
		}
		encodedPrefs, _ := json.Marshal(prefs)
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_preferences (user_id, prefs_json, updated_at)
			VALUES ($1, $2, $3)
			ON CONFLICT (user_id) DO UPDATE SET prefs_json = EXCLUDED.prefs_json, updated_at = EXCLUDED.updated_at
		`, botUserID, string(encodedPrefs), now.UTC()); err != nil {
			return BotProfileResult{}, err
		}
	}

	nextName := curName
	if input.NameSet && input.Name != nil {
		nextName = strings.TrimSpace(*input.Name)
	}
	nextDesc := curDesc
	if input.DescriptionSet && input.Description != nil {
		nextDesc = strings.TrimSpace(*input.Description)
	}

	if nextName != curName {
		norm := strings.ToLower(nextName)
		if _, err := tx.Exec(ctx, `
			UPDATE workspace_agent_bots
			SET name = $1, name_normalized = $2, updated_at = $3
			WHERE space_id = $4 AND id = $5
		`, nextName, norm, now.UTC(), r.spaceID, botID); err != nil {
			return BotProfileResult{}, fmt.Errorf("%w: 机器人名称已被使用", ErrInvalidInput)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE users SET display_name = $1 WHERE id = $2
		`, nextName, botUserID); err != nil {
			return BotProfileResult{}, err
		}
	}

	var descArg any
	if nextDesc != "" {
		descArg = nextDesc
	}
	if _, err := tx.Exec(ctx, `
		UPDATE workspace_agent_bot_settings
		SET description = $1, updated_at = $2
		WHERE space_id = $3 AND bot_id = $4
	`, descArg, now.UTC(), r.spaceID, botID); err != nil {
		return BotProfileResult{}, err
	}

	cleanAvatar := sanitizeBootstrapAvatarURL(curAvatar)
	if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, "", "workspace.member_updated", "user", botUserID, map[string]any{
		"userId": botUserID,
		"member": map[string]any{
			"id":          botUserID,
			"displayName": nextName,
			"description": nextDesc,
			"avatarUrl":   cleanAvatar,
			"avatarColor": nextColor,
			"kind":        "bot",
			"role":        "member",
		},
	}, now); err != nil {
		return BotProfileResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return BotProfileResult{}, err
	}
	return BotProfileResult{
		BotID:       botID,
		BotUserID:   botUserID,
		Name:        nextName,
		Description: nextDesc,
		AvatarURL:   cleanAvatar,
		AvatarColor: nextColor,
	}, nil
}

func (r *PGRepository) UploadBotAvatar(ctx context.Context, actorID, botID, mimeType string, data []byte, now time.Time) (BotProfileResult, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return BotProfileResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var ownerID, botUserID, botName, botDesc, rawPrefs string
	err = tx.QueryRow(ctx, `
		SELECT
			b.owner_user_id,
			b.bot_user_id,
			b.name,
			coalesce(bs.description, ''),
			coalesce((SELECT prefs_json FROM user_preferences WHERE user_id = b.bot_user_id), '{}')
		FROM workspace_agent_bots b
		LEFT JOIN workspace_agent_bot_settings bs ON bs.bot_id = b.id AND bs.space_id = b.space_id
		WHERE b.space_id = $1 AND b.id = $2 AND b.status <> 'deleted'
		FOR UPDATE OF b
	`, r.spaceID, botID).Scan(&ownerID, &botUserID, &botName, &botDesc, &rawPrefs)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return BotProfileResult{}, ErrNotFound
		}
		return BotProfileResult{}, err
	}
	if ownerID != actorID {
		return BotProfileResult{}, ErrForbidden
	}

	prefs := map[string]any{}
	_ = json.Unmarshal([]byte(rawPrefs), &prefs)
	if prefs == nil {
		prefs = map[string]any{}
	}
	prefs["botAvatarMime"] = mimeType
	prefs["botAvatarBase64"] = base64.StdEncoding.EncodeToString(data)
	botColor, _ := prefs["botColor"].(string)
	if !IsValidBotColor(botColor) {
		botColor = ""
	}
	encodedPrefs, _ := json.Marshal(prefs)

	if _, err := tx.Exec(ctx, `
		INSERT INTO user_preferences (user_id, prefs_json, updated_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET prefs_json = EXCLUDED.prefs_json, updated_at = EXCLUDED.updated_at
	`, botUserID, string(encodedPrefs), now.UTC()); err != nil {
		return BotProfileResult{}, err
	}

	avatarURL := fmt.Sprintf("/api/v1/bots/%s/avatar?v=%d", botID, now.UTC().UnixMilli())
	if _, err := tx.Exec(ctx, `UPDATE users SET avatar_url = $1 WHERE id = $2`, avatarURL, botUserID); err != nil {
		return BotProfileResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE workspace_agent_bot_settings SET avatar_url = $1, updated_at = $2
		WHERE space_id = $3 AND bot_id = $4
	`, avatarURL, now.UTC(), r.spaceID, botID); err != nil {
		return BotProfileResult{}, err
	}

	if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, "", "workspace.member_updated", "user", botUserID, map[string]any{
		"userId": botUserID,
		"member": map[string]any{
			"id":          botUserID,
			"displayName": botName,
			"description": botDesc,
			"avatarUrl":   avatarURL,
			"avatarColor": botColor,
			"kind":        "bot",
			"role":        "member",
		},
	}, now); err != nil {
		return BotProfileResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return BotProfileResult{}, err
	}
	return BotProfileResult{
		BotID:       botID,
		BotUserID:   botUserID,
		Name:        botName,
		Description: botDesc,
		AvatarURL:   avatarURL,
		AvatarColor: botColor,
	}, nil
}

func (r *PGRepository) DeleteBotAvatar(ctx context.Context, actorID, botID string, now time.Time) (BotProfileResult, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return BotProfileResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var ownerID, botUserID, botName, botDesc, rawPrefs string
	err = tx.QueryRow(ctx, `
		SELECT
			b.owner_user_id,
			b.bot_user_id,
			b.name,
			coalesce(bs.description, ''),
			coalesce((SELECT prefs_json FROM user_preferences WHERE user_id = b.bot_user_id), '{}')
		FROM workspace_agent_bots b
		LEFT JOIN workspace_agent_bot_settings bs ON bs.bot_id = b.id AND bs.space_id = b.space_id
		WHERE b.space_id = $1 AND b.id = $2 AND b.status <> 'deleted'
		FOR UPDATE OF b
	`, r.spaceID, botID).Scan(&ownerID, &botUserID, &botName, &botDesc, &rawPrefs)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return BotProfileResult{}, ErrNotFound
		}
		return BotProfileResult{}, err
	}
	if ownerID != actorID {
		return BotProfileResult{}, ErrForbidden
	}

	prefs := map[string]any{}
	_ = json.Unmarshal([]byte(rawPrefs), &prefs)
	delete(prefs, "botAvatarMime")
	delete(prefs, "botAvatarBase64")
	botColor, _ := prefs["botColor"].(string)
	if !IsValidBotColor(botColor) {
		botColor = ""
	}
	encodedPrefs, _ := json.Marshal(prefs)

	if _, err := tx.Exec(ctx, `
		INSERT INTO user_preferences (user_id, prefs_json, updated_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET prefs_json = EXCLUDED.prefs_json, updated_at = EXCLUDED.updated_at
	`, botUserID, string(encodedPrefs), now.UTC()); err != nil {
		return BotProfileResult{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET avatar_url = NULL WHERE id = $1`, botUserID); err != nil {
		return BotProfileResult{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE workspace_agent_bot_settings SET avatar_url = NULL, updated_at = $1
		WHERE space_id = $2 AND bot_id = $3
	`, now.UTC(), r.spaceID, botID); err != nil {
		return BotProfileResult{}, err
	}

	if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, "", "workspace.member_updated", "user", botUserID, map[string]any{
		"userId": botUserID,
		"member": map[string]any{
			"id":          botUserID,
			"displayName": botName,
			"description": botDesc,
			"avatarUrl":   "",
			"avatarColor": botColor,
			"kind":        "bot",
			"role":        "member",
		},
	}, now); err != nil {
		return BotProfileResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return BotProfileResult{}, err
	}
	return BotProfileResult{
		BotID:       botID,
		BotUserID:   botUserID,
		Name:        botName,
		Description: botDesc,
		AvatarURL:   "",
		AvatarColor: botColor,
	}, nil
}

func (r *PGRepository) GetBotAvatar(ctx context.Context, actorID, botID string) (BotAvatarPayload, error) {
	var isSpaceMember bool
	if err := r.pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM space_members
			WHERE space_id = $1 AND user_id = $2 AND removed_at IS NULL
		)
	`, r.spaceID, actorID).Scan(&isSpaceMember); err != nil {
		return BotAvatarPayload{}, err
	}
	if !isSpaceMember {
		return BotAvatarPayload{}, ErrForbidden
	}

	var rawPrefs string
	err := r.pool.QueryRow(ctx, `
		SELECT coalesce(up.prefs_json, '{}')
		FROM workspace_agent_bots b
		LEFT JOIN user_preferences up ON up.user_id = b.bot_user_id
		WHERE b.space_id = $1 AND b.id = $2 AND b.status <> 'deleted'
	`, r.spaceID, botID).Scan(&rawPrefs)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return BotAvatarPayload{}, ErrNotFound
		}
		return BotAvatarPayload{}, err
	}

	prefs := map[string]any{}
	_ = json.Unmarshal([]byte(rawPrefs), &prefs)
	mimeType, _ := prefs["botAvatarMime"].(string)
	b64, _ := prefs["botAvatarBase64"].(string)
	if mimeType == "" || b64 == "" {
		return BotAvatarPayload{}, ErrNotFound
	}
	decoded, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(decoded) == 0 {
		return BotAvatarPayload{}, ErrNotFound
	}
	return BotAvatarPayload{
		MIMEType: mimeType,
		Data:     decoded,
	}, nil
}

func (r *PGRepository) UnbindBotToken(ctx context.Context, botID, tokenID string, now time.Time) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
		UPDATE workspace_agent_bot_tokens
		SET revoked_at = COALESCE(revoked_at, $1)
		WHERE id = $2 AND bot_id = $3 AND space_id = $4
	`, now.UTC(), tokenID, botID, r.spaceID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}

	var activeCount int
	if err := tx.QueryRow(ctx, `
		SELECT COUNT(*) FROM workspace_agent_bot_tokens
		WHERE bot_id = $1 AND space_id = $2 AND revoked_at IS NULL
		  AND (expires_at IS NULL OR expires_at > $3)
	`, botID, r.spaceID, now.UTC()).Scan(&activeCount); err == nil && activeCount == 0 {
		_, _ = tx.Exec(ctx, `
			UPDATE workspace_agent_bot_connections
			SET status = 'disconnected', disconnected_at = $1, updated_at = $1
			WHERE bot_id = $2 AND space_id = $3
		`, now.UTC(), botID, r.spaceID)
	}

	return tx.Commit(ctx)
}

func (r *PGRepository) UpsertBotWebhook(ctx context.Context, actorID, botID, url, secret string, enabled bool, now time.Time) (BotWebhookConfig, error) {
	var ownerID string
	err := r.pool.QueryRow(ctx, `SELECT owner_user_id FROM workspace_agent_bots WHERE id = $1 AND status <> 'deleted'`, botID).Scan(&ownerID)
	if err != nil || ownerID != actorID {
		return BotWebhookConfig{}, ErrForbidden
	}

	sum := sha256.Sum256([]byte(secret))
	secretHash := hex.EncodeToString(sum[:])
	_, err = r.pool.Exec(ctx, `
		INSERT INTO bot_webhooks (bot_id, url, secret_hash, enabled, updated_at)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (bot_id) DO UPDATE SET url = EXCLUDED.url, secret_hash = EXCLUDED.secret_hash, enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at
	`, botID, url, secretHash, enabled, now)
	if err != nil {
		return BotWebhookConfig{}, fmt.Errorf("upsert bot webhook: %w", err)
	}
	return BotWebhookConfig{BotID: botID, URL: url, Enabled: enabled}, nil
}

func (r *PGRepository) ListBotRecentDeliveries(ctx context.Context, botID string, limit int) ([]BotDeliveryDiagnostic, error) {
	if limit <= 0 || limit > 30 {
		limit = 8
	}
	rows, err := r.pool.Query(ctx, `
		SELECT
			d.id,
			d.sequence,
			d.event_type,
			COALESCE(d.conversation_id, ''),
			COALESCE(c.title, ''),
			d.status,
			d.attempts,
			d.created_at,
			d.acked_at
		FROM workspace_agent_bot_deliveries d
		LEFT JOIN conversations c ON c.id = d.conversation_id AND c.space_id = d.space_id
		WHERE d.space_id = $1 AND d.bot_id = $2
		ORDER BY d.sequence DESC
		LIMIT $3
	`, r.spaceID, botID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]BotDeliveryDiagnostic, 0, limit)
	for rows.Next() {
		var (
			item      BotDeliveryDiagnostic
			createdAt time.Time
			ackedAt   *time.Time
		)
		if err := rows.Scan(
			&item.ID,
			&item.Sequence,
			&item.EventType,
			&item.ConversationID,
			&item.ConversationTitle,
			&item.Status,
			&item.Attempts,
			&createdAt,
			&ackedAt,
		); err != nil {
			return nil, err
		}
		item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		if ackedAt != nil {
			item.AckedAt = ackedAt.UTC().Format(time.RFC3339Nano)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *PGRepository) GetBotConsoleOverview(ctx context.Context, actorID, botID string, now time.Time) (BotConsoleOverview, error) {
	var ownerID, botUserID, botName string
	err := r.pool.QueryRow(ctx, `
		SELECT owner_user_id, bot_user_id, name
		FROM workspace_agent_bots
		WHERE space_id = $1 AND id = $2 AND status <> 'deleted'
	`, r.spaceID, botID).Scan(&ownerID, &botUserID, &botName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return BotConsoleOverview{}, ErrNotFound
		}
		return BotConsoleOverview{}, err
	}
	if ownerID != actorID {
		return BotConsoleOverview{}, ErrForbidden
	}

	// Diagnostics never create conversations, restore membership or grant access.
	convs, err := r.ListBotConversations(ctx, botID, botUserID)
	if err != nil {
		return BotConsoleOverview{}, err
	}
	deliveries, err := r.ListBotRecentDeliveries(ctx, botID, 8)
	if err != nil {
		return BotConsoleOverview{}, err
	}

	var webhook *BotWebhookConfig
	var whURL string
	var whEnabled bool
	var whLastStatus *int
	var whLastError *string
	if whErr := r.pool.QueryRow(ctx, `
		SELECT url, enabled, last_status, last_error
		FROM bot_webhooks
		WHERE bot_id = $1
	`, botID).Scan(&whURL, &whEnabled, &whLastStatus, &whLastError); whErr == nil {
		errText := ""
		if whLastError != nil {
			errText = *whLastError
		}
		webhook = &BotWebhookConfig{
			BotID:      botID,
			URL:        whURL,
			Enabled:    whEnabled,
			LastStatus: whLastStatus,
			LastError:  errText,
		}
	}

	return BotConsoleOverview{
		BotID:            botID,
		BotUserID:        botUserID,
		LatestSDKVersion: LatestAgentSDKVersion,
		Conversations:    convs,
		RecentDeliveries: deliveries,
		Webhook:          webhook,
	}, nil
}

func (r *PGRepository) RequestBotRuntimeUpgrade(ctx context.Context, actorID, botID string, now time.Time) (string, error) {
	var ownerID, botUserID string
	err := r.pool.QueryRow(ctx, `
		SELECT owner_user_id, bot_user_id
		FROM workspace_agent_bots
		WHERE space_id = $1 AND id = $2 AND status <> 'deleted'
	`, r.spaceID, botID).Scan(&ownerID, &botUserID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	if ownerID != actorID {
		return "", ErrForbidden
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, "", "bot.runtime_upgrade", "agent_bot", botID, map[string]any{
		"botId":         botID,
		"botUserId":     botUserID,
		"targetVersion": LatestAgentSDKVersion,
		"reason":        "console_request",
	}, now.UTC()); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return LatestAgentSDKVersion, nil
}

func (r *PGRepository) resolveSpaceManager(ctx context.Context, actorID string) (string, string, error) {
	var role, githubLogin string
	err := r.pool.QueryRow(ctx, `
		SELECT sm.role, coalesce(u.github_login, '')
		FROM space_members sm
		JOIN users u ON u.id = sm.user_id
		WHERE sm.space_id = $1 AND sm.user_id = $2 AND sm.removed_at IS NULL AND u.kind = 'human'
	`, r.spaceID, actorID).Scan(&role, &githubLogin)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", ErrForbidden
		}
		return "", "", err
	}
	if role != "owner" && role != "admin" {
		return "", "", ErrForbidden
	}
	return role, githubLogin, nil
}

func (r *PGRepository) GetAdminOverview(ctx context.Context, actorID string, now time.Time) (AdminOverviewResponse, error) {
	role, _, err := r.resolveSpaceManager(ctx, actorID)
	if err != nil {
		return AdminOverviewResponse{}, err
	}

	var resp AdminOverviewResponse
	resp.ViewerRole = role
	resp.Storage.RecentOperatorRuns = []StorageOperatorRunSummary{}

	var spaceCreatedAt time.Time
	if err := r.pool.QueryRow(ctx, `
		SELECT id, name, slug, created_at FROM spaces WHERE id = $1
	`, r.spaceID).Scan(&resp.Space.ID, &resp.Space.Name, &resp.Space.Slug, &spaceCreatedAt); err != nil {
		return AdminOverviewResponse{}, err
	}
	resp.Space.CreatedAt = spaceCreatedAt.UTC().Format(time.RFC3339Nano)

	dayStart := time.Date(now.UTC().Year(), now.UTC().Month(), now.UTC().Day(), 0, 0, 0, 0, time.UTC)
	if err := r.pool.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM space_members WHERE space_id = $1 AND removed_at IS NULL),
			(SELECT COUNT(*) FROM conversations WHERE space_id = $1),
			(SELECT COUNT(*) FROM messages WHERE space_id = $1 AND deleted_at IS NULL),
			(SELECT COUNT(*) FROM attachments WHERE space_id = $1 AND status = 'available'),
			(SELECT COALESCE(SUM(byte_size), 0) FROM attachments WHERE space_id = $1 AND status = 'available'),
			(SELECT COUNT(*) FROM space_members WHERE space_id = $1 AND removed_at IS NULL AND joined_at >= $2),
			(SELECT COUNT(*) FROM conversations WHERE space_id = $1 AND created_at >= $2),
			(SELECT COUNT(*) FROM messages WHERE space_id = $1 AND deleted_at IS NULL AND created_at >= $2),
			(SELECT COUNT(*) FROM attachments WHERE space_id = $1 AND status = 'available' AND COALESCE(completed_at, created_at) >= $2),
			(SELECT COALESCE(SUM(byte_size), 0) FROM attachments WHERE space_id = $1 AND status = 'available' AND COALESCE(completed_at, created_at) >= $2)
	`, r.spaceID, dayStart).Scan(
		&resp.Totals.Members, &resp.Totals.Conversations, &resp.Totals.Messages, &resp.Totals.Files, &resp.Totals.UploadedBytes,
		&resp.Today.Members, &resp.Today.Conversations, &resp.Today.Messages, &resp.Today.Files, &resp.Today.UploadedBytes,
	); err != nil {
		return AdminOverviewResponse{}, err
	}

	resp.Policy = AdminSpacePolicy{
		DailyQuotaBytes:       2 * 1024 * 1024 * 1024,
		MessageRetentionCount: 10000,
	}
	var policyUpdatedAt time.Time
	if err := r.pool.QueryRow(ctx, `
		SELECT daily_quota_bytes, message_retention_count, updated_at
		FROM space_policies
		WHERE space_id = $1
	`, r.spaceID).Scan(&resp.Policy.DailyQuotaBytes, &resp.Policy.MessageRetentionCount, &policyUpdatedAt); err == nil {
		resp.Policy.UpdatedAt = policyUpdatedAt.UTC().Format(time.RFC3339Nano)
	}

	_ = r.pool.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE status = 'available'),
			COALESCE(SUM(byte_size) FILTER (WHERE status = 'available'), 0),
			COUNT(*) FILTER (WHERE status = 'pending'),
			COALESCE(SUM(byte_size) FILTER (WHERE status = 'pending'), 0),
			COUNT(*) FILTER (WHERE status IN ('failed', 'removed')),
			COALESCE(SUM(byte_size) FILTER (WHERE status IN ('failed', 'removed')), 0)
		FROM attachments
		WHERE space_id = $1
	`, r.spaceID).Scan(
		&resp.Storage.ActiveAttachments,
		&resp.Storage.ActiveBytes,
		&resp.Storage.PendingUploads,
		&resp.Storage.PendingBytes,
		&resp.Storage.ReclaimableAttachments,
		&resp.Storage.ReclaimableBytes,
	)

	_ = r.pool.QueryRow(ctx, `
		SELECT COUNT(*), COALESCE(SUM(byte_size), 0)
		FROM workspace_storage_objects
		WHERE deleted_at IS NULL
	`).Scan(&resp.Storage.CASObjects, &resp.Storage.CASBytes)

	runRows, runErr := r.pool.Query(ctx, `
		SELECT id, operation, state, phase, total_items, processed_items, COALESCE(last_error_code, ''), started_at, COALESCE(completed_at, '')
		FROM workspace_storage_operator_runs
		ORDER BY started_at DESC
		LIMIT 5
	`)
	if runErr == nil {
		defer runRows.Close()
		for runRows.Next() {
			var run StorageOperatorRunSummary
			if err := runRows.Scan(&run.ID, &run.Operation, &run.State, &run.Phase, &run.TotalItems, &run.ProcessedItems, &run.LastErrorCode, &run.StartedAt, &run.CompletedAt); err == nil {
				resp.Storage.RecentOperatorRuns = append(resp.Storage.RecentOperatorRuns, run)
			}
		}
	}

	return resp, nil
}

func (r *PGRepository) ListAdminInvites(ctx context.Context, actorID string, now time.Time) (AdminInviteListResponse, error) {
	role, _, err := r.resolveSpaceManager(ctx, actorID)
	if err != nil {
		return AdminInviteListResponse{}, err
	}

	viewAllRoles := role == "owner"
	resp := AdminInviteListResponse{
		Invites: []AdminInviteItem{},
	}

	rows, err := r.pool.Query(ctx, `
		SELECT i.id, i.code_preview, i.default_role, i.max_uses, i.uses, i.expires_at, i.revoked_at, i.created_at, COALESCE(u.display_name, u.github_login, '')
		FROM invites i
		LEFT JOIN users u ON u.id = i.created_by
		WHERE i.space_id = $1 AND ($2 OR i.default_role = 'member')
		ORDER BY i.created_at DESC
		LIMIT 100
	`, r.spaceID, viewAllRoles)
	if err != nil {
		return AdminInviteListResponse{}, err
	}
	defer rows.Close()

	nowUTC := now.UTC()
	for rows.Next() {
		var item AdminInviteItem
		var expiresAt, revokedAt *time.Time
		var createdAt time.Time
		if err := rows.Scan(&item.ID, &item.CodePreview, &item.DefaultRole, &item.MaxUses, &item.Uses, &expiresAt, &revokedAt, &createdAt, &item.CreatedByName); err != nil {
			return AdminInviteListResponse{}, err
		}
		item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		if expiresAt != nil {
			s := expiresAt.UTC().Format(time.RFC3339Nano)
			item.ExpiresAt = &s
		}
		if revokedAt != nil {
			s := revokedAt.UTC().Format(time.RFC3339Nano)
			item.RevokedAt = &s
		}

		switch {
		case revokedAt != nil:
			item.Status = "revoked"
		case expiresAt != nil && !expiresAt.UTC().After(nowUTC):
			item.Status = "expired"
		case item.Uses >= item.MaxUses:
			item.Status = "exhausted"
		default:
			item.Status = "active"
			resp.Active++
			resp.AvailableUses += item.MaxUses - item.Uses
		}
		resp.Total++
		resp.AcceptedUses += item.Uses
		resp.Invites = append(resp.Invites, item)
	}
	return resp, rows.Err()
}

func (r *PGRepository) ListAdminAuditLogs(ctx context.Context, actorID, resultFilter, query string, limit int) ([]AdminAuditLogItem, error) {
	if _, _, err := r.resolveSpaceManager(ctx, actorID); err != nil {
		return nil, err
	}

	like := "%" + query + "%"
	rows, err := r.pool.Query(ctx, `
		SELECT
			a.id,
			COALESCE(a.actor_user_id, ''),
			COALESCE(u.display_name, a.actor_github_login, '系统'),
			COALESCE(a.actor_github_login, ''),
			a.action,
			a.target_type,
			COALESCE(a.target_id, ''),
			a.result,
			COALESCE(a.reason, ''),
			COALESCE(a.ip_address, ''),
			COALESCE(a.request_id, ''),
			a.created_at
		FROM audit_logs a
		LEFT JOIN users u ON u.id = a.actor_user_id
		WHERE (a.space_id = $1 OR a.space_id IS NULL)
		  AND ($2 = '' OR a.result = $2)
		  AND (
			$3 = ''
			OR a.action ILIKE $4
			OR a.target_type ILIKE $4
			OR COALESCE(a.target_id, '') ILIKE $4
			OR COALESCE(a.actor_github_login, '') ILIKE $4
			OR COALESCE(u.display_name, '') ILIKE $4
			OR COALESCE(a.reason, '') ILIKE $4
			OR COALESCE(a.ip_address, '') ILIKE $4
		  )
		ORDER BY a.created_at DESC
		LIMIT $5
	`, r.spaceID, resultFilter, query, like, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]AdminAuditLogItem, 0)
	for rows.Next() {
		var item AdminAuditLogItem
		var createdAt time.Time
		if err := rows.Scan(
			&item.ID,
			&item.ActorUserID,
			&item.ActorDisplayName,
			&item.ActorGitHubLogin,
			&item.Action,
			&item.TargetType,
			&item.TargetID,
			&item.Result,
			&item.Reason,
			&item.IPAddress,
			&item.RequestID,
			&createdAt,
		); err != nil {
			return nil, err
		}
		item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *PGRepository) UpdateSpacePolicy(ctx context.Context, actorID string, input AdminPolicyUpdateInput, now time.Time) (AdminSpacePolicy, error) {
	role, githubLogin, err := r.resolveSpaceManager(ctx, actorID)
	if err != nil {
		return AdminSpacePolicy{}, err
	}
	if role != "owner" {
		_, _ = r.pool.Exec(ctx, `
			INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, created_at)
			VALUES ($1, $2, $3, NULLIF($4, ''), 'space.policy_update', 'space', $2, 'rejected', 'owner required', $5)
		`, randomID("aud"), r.spaceID, actorID, githubLogin, now.UTC())
		return AdminSpacePolicy{}, ErrForbidden
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return AdminSpacePolicy{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if input.SpaceName != "" {
		if _, err := tx.Exec(ctx, `UPDATE spaces SET name = $2 WHERE id = $1`, r.spaceID, input.SpaceName); err != nil {
			return AdminSpacePolicy{}, err
		}
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO space_policies (space_id, daily_quota_bytes, message_retention_count, updated_by, updated_at)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (space_id) DO UPDATE
		SET daily_quota_bytes = EXCLUDED.daily_quota_bytes,
		    message_retention_count = EXCLUDED.message_retention_count,
		    updated_by = EXCLUDED.updated_by,
		    updated_at = EXCLUDED.updated_at
	`, r.spaceID, input.DailyQuotaBytes, input.MessageRetentionCount, actorID, now.UTC()); err != nil {
		return AdminSpacePolicy{}, err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, created_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), 'space.policy_update', 'space', $2, 'success', $5, $6)
	`, randomID("aud"), r.spaceID, actorID, githubLogin, fmt.Sprintf("quota=%d retention=%d", input.DailyQuotaBytes, input.MessageRetentionCount), now.UTC()); err != nil {
		return AdminSpacePolicy{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return AdminSpacePolicy{}, err
	}

	return AdminSpacePolicy{
		DailyQuotaBytes:       input.DailyQuotaBytes,
		MessageRetentionCount: input.MessageRetentionCount,
		UpdatedAt:             now.UTC().Format(time.RFC3339Nano),
	}, nil
}

func (r *PGRepository) CleanupStaleStorage(ctx context.Context, actorID string, now time.Time) (AdminStorageCleanupResult, error) {
	_, githubLogin, err := r.resolveSpaceManager(ctx, actorID)
	if err != nil {
		return AdminStorageCleanupResult{}, err
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return AdminStorageCleanupResult{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	cutoff := now.UTC().Add(-15 * time.Minute)
	var result AdminStorageCleanupResult

	if err := tx.QueryRow(ctx, `
		WITH rel AS (
			UPDATE transfer_ledger
			SET status = 'released', released_at = $3
			WHERE space_id = $1 AND status = 'reserved' AND created_at < $2
			RETURNING byte_size
		)
		SELECT COUNT(*), COALESCE(SUM(byte_size), 0) FROM rel
	`, r.spaceID, cutoff, now.UTC()).Scan(&result.ReleasedTransfers, &result.ReclaimedBytes); err != nil {
		return AdminStorageCleanupResult{}, err
	}

	tag, err := tx.Exec(ctx, `
		UPDATE attachments
		SET status = 'failed'
		WHERE space_id = $1 AND status = 'pending' AND created_at < $2
	`, r.spaceID, cutoff)
	if err != nil {
		return AdminStorageCleanupResult{}, err
	}
	result.CleanedAttachments = tag.RowsAffected()

	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, created_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), 'storage.cleanup', 'workspace', $2, 'success', $5, $6)
	`, randomID("aud"), r.spaceID, actorID, githubLogin, fmt.Sprintf("transfers=%d attachments=%d", result.ReleasedTransfers, result.CleanedAttachments), now.UTC()); err != nil {
		return AdminStorageCleanupResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return AdminStorageCleanupResult{}, err
	}
	return result, nil
}

func parseSystemAnnouncementFromPrefsRaw(raw string) (SystemAnnouncement, bool) {
	if strings.TrimSpace(raw) == "" {
		return SystemAnnouncement{}, false
	}
	var outer map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &outer); err != nil {
		return SystemAnnouncement{}, false
	}
	annBytes, ok := outer["systemAnnouncement"]
	if !ok || len(annBytes) == 0 {
		return SystemAnnouncement{}, false
	}
	var ann SystemAnnouncement
	if err := json.Unmarshal(annBytes, &ann); err != nil {
		return SystemAnnouncement{}, false
	}
	if ann.DisplayMode != "always" {
		ann.DisplayMode = "once"
	}
	return ann, true
}

func (r *PGRepository) GetAdminAnnouncement(ctx context.Context, actorID string) (SystemAnnouncement, error) {
	if _, _, err := r.resolveSpaceManager(ctx, actorID); err != nil {
		return SystemAnnouncement{}, err
	}
	var raw string
	err := r.pool.QueryRow(ctx, `SELECT prefs_json FROM user_preferences WHERE user_id = 'usr_system_beacon'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return SystemAnnouncement{DisplayMode: "once"}, nil
	}
	if err != nil {
		return SystemAnnouncement{}, err
	}
	if ann, ok := parseSystemAnnouncementFromPrefsRaw(raw); ok {
		return ann, nil
	}
	return SystemAnnouncement{DisplayMode: "once"}, nil
}

func (r *PGRepository) UpsertAdminAnnouncement(ctx context.Context, actorID string, ann SystemAnnouncement, now time.Time) (SystemAnnouncement, error) {
	_, githubLogin, err := r.resolveSpaceManager(ctx, actorID)
	if err != nil {
		return SystemAnnouncement{}, err
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return SystemAnnouncement{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var existingRaw string
	err = tx.QueryRow(ctx, `SELECT prefs_json FROM user_preferences WHERE user_id = 'usr_system_beacon' FOR UPDATE`).Scan(&existingRaw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return SystemAnnouncement{}, err
	}
	prefs := map[string]any{}
	if existingRaw != "" {
		_ = json.Unmarshal([]byte(existingRaw), &prefs)
	}
	stored := ann
	stored.ShouldShow = false
	prefs["systemAnnouncement"] = stored
	encoded, err := json.Marshal(prefs)
	if err != nil {
		return SystemAnnouncement{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO user_preferences (user_id, prefs_json, updated_at)
		VALUES ('usr_system_beacon', $1, $2)
		ON CONFLICT (user_id) DO UPDATE SET prefs_json = EXCLUDED.prefs_json, updated_at = EXCLUDED.updated_at
	`, string(encoded), now.UTC()); err != nil {
		return SystemAnnouncement{}, err
	}

	reason := fmt.Sprintf("enabled=%t mode=%s id=%s", ann.Enabled, ann.DisplayMode, ann.ID)
	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, created_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), 'space.announcement_update', 'space', $2, 'success', $5, $6)
	`, randomID("aud"), r.spaceID, actorID, githubLogin, reason, now.UTC()); err != nil {
		return SystemAnnouncement{}, err
	}

	if err := emitWorkspaceEventTx(ctx, tx, r.spaceID, actorID, "", "workspace.announcement_updated", "space", r.spaceID, map[string]any{
		"announcement": stored,
	}, now.UTC()); err != nil {
		return SystemAnnouncement{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return SystemAnnouncement{}, err
	}
	return stored, nil
}

func (r *PGRepository) AckAnnouncement(ctx context.Context, actorID, announcementID string, now time.Time) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var exists bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM space_members sm
			JOIN users u ON u.id = sm.user_id
			WHERE sm.space_id = $1 AND sm.user_id = $2 AND sm.removed_at IS NULL AND u.kind = 'human'
		)
	`, r.spaceID, actorID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrForbidden
	}

	var existingRaw string
	err = tx.QueryRow(ctx, `SELECT prefs_json FROM user_preferences WHERE user_id = $1 FOR UPDATE`, actorID).Scan(&existingRaw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	prefs := map[string]any{}
	if existingRaw != "" {
		_ = json.Unmarshal([]byte(existingRaw), &prefs)
	}
	prefs["ackAnnouncementId"] = announcementID
	encoded, err := json.Marshal(prefs)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO user_preferences (user_id, prefs_json, updated_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET prefs_json = EXCLUDED.prefs_json, updated_at = EXCLUDED.updated_at
	`, actorID, string(encoded), now.UTC()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *PGRepository) FindBoundEmailOwner(ctx context.Context, normalizedEmail string) (string, error) {
	var userID string
	err := r.pool.QueryRow(ctx, `
		SELECT u.id
		FROM space_members sm
		JOIN users u ON u.id = sm.user_id
		JOIN user_preferences up ON up.user_id = u.id
		WHERE sm.space_id = $1
		  AND sm.removed_at IS NULL
		  AND u.kind = 'human'
		  AND lower(coalesce((up.prefs_json::jsonb ->> 'boundEmail'), '')) = $2
		LIMIT 1
	`, r.spaceID, strings.ToLower(strings.TrimSpace(normalizedEmail))).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return userID, nil
}

func (r *PGRepository) CheckEmailChallengeCooldown(ctx context.Context, userID string, now time.Time) error {
	nowUTC := now.UTC()
	var count int
	var latest *time.Time
	err := r.pool.QueryRow(ctx, `
		SELECT COUNT(*), MAX(created_at)
		FROM notification_email_challenges
		WHERE user_id = $1 AND created_at >= $2
	`, userID, nowUTC.Add(-time.Hour)).Scan(&count, &latest)
	if err != nil {
		return err
	}
	if count >= 5 {
		return fmt.Errorf("%w: 验证码发送次数已达每小时上限，请稍后再试", ErrRateLimited)
	}
	if latest != nil && nowUTC.Sub(latest.UTC()) < 60*time.Second {
		return fmt.Errorf("%w: 请等待 60 秒后再重新获取验证码", ErrRateLimited)
	}
	return nil
}

func (r *PGRepository) SaveEmailChallenge(ctx context.Context, challengeID, userID, normalizedEmail, codeHash string, now, expiresAt time.Time) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	prefix := "echl_%"
	if strings.HasPrefix(challengeID, "echl_bind_") {
		prefix = "echl_bind_%"
	} else if strings.HasPrefix(challengeID, "echl_login_") {
		prefix = "echl_login_%"
	}
	if _, err := tx.Exec(ctx, `
		UPDATE notification_email_challenges
		SET consumed_at = $3
		WHERE user_id = $1 AND id LIKE $2 AND consumed_at IS NULL
	`, userID, prefix, now.UTC()); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO notification_email_challenges (id, user_id, pending_email, code_hash, attempts, created_at, expires_at)
		VALUES ($1, $2, $3, $4, 0, $5, $6)
	`, challengeID, userID, normalizedEmail, codeHash, now.UTC(), expiresAt.UTC()); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *PGRepository) VerifyAndConsumeEmailChallenge(
	ctx context.Context,
	challengeID string,
	verifyFn func(rec EmailChallengeStoreRecord) (bool, error),
	now time.Time,
) (EmailChallengeStoreRecord, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return EmailChallengeStoreRecord{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var rec EmailChallengeStoreRecord
	err = tx.QueryRow(ctx, `
		SELECT id, user_id, pending_email, code_hash, attempts, created_at, expires_at, consumed_at
		FROM notification_email_challenges
		WHERE id = $1
		FOR UPDATE
	`, challengeID).Scan(
		&rec.ID, &rec.UserID, &rec.PendingEmail, &rec.CodeHash,
		&rec.Attempts, &rec.CreatedAt, &rec.ExpiresAt, &rec.ConsumedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return EmailChallengeStoreRecord{}, ErrChallengeInvalid
	}
	if err != nil {
		return EmailChallengeStoreRecord{}, err
	}
	nowUTC := now.UTC()
	if rec.ConsumedAt != nil || !rec.ExpiresAt.After(nowUTC) || rec.Attempts >= 5 {
		return EmailChallengeStoreRecord{}, ErrChallengeInvalid
	}
	matched, verifyErr := verifyFn(rec)
	if verifyErr != nil {
		return EmailChallengeStoreRecord{}, verifyErr
	}
	if !matched {
		if _, err := tx.Exec(ctx, `
			UPDATE notification_email_challenges SET attempts = attempts + 1 WHERE id = $1
		`, challengeID); err != nil {
			return EmailChallengeStoreRecord{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return EmailChallengeStoreRecord{}, err
		}
		return EmailChallengeStoreRecord{}, ErrChallengeInvalid
	}
	if _, err := tx.Exec(ctx, `
		UPDATE notification_email_challenges SET consumed_at = $2 WHERE id = $1
	`, challengeID, nowUTC); err != nil {
		return EmailChallengeStoreRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return EmailChallengeStoreRecord{}, err
	}
	return rec, nil
}

func (r *PGRepository) BindAccountEmail(ctx context.Context, actorID, normalizedEmail string, now time.Time) error {
	normalized := strings.ToLower(strings.TrimSpace(normalizedEmail))
	nowUTC := now.UTC()

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "duallane:bound-email:"+normalized); err != nil {
		return err
	}

	var githubLogin string
	err = tx.QueryRow(ctx, `
		SELECT coalesce(u.github_login, '')
		FROM space_members sm
		JOIN users u ON u.id = sm.user_id
		WHERE sm.space_id = $1 AND sm.user_id = $2 AND sm.removed_at IS NULL AND u.kind = 'human'
	`, r.spaceID, actorID).Scan(&githubLogin)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}

	var conflictID string
	err = tx.QueryRow(ctx, `
		SELECT u.id
		FROM space_members sm
		JOIN users u ON u.id = sm.user_id
		JOIN user_preferences up ON up.user_id = u.id
		WHERE sm.space_id = $1
		  AND sm.removed_at IS NULL
		  AND u.kind = 'human'
		  AND u.id <> $2
		  AND lower(coalesce((up.prefs_json::jsonb ->> 'boundEmail'), '')) = $3
		LIMIT 1
	`, r.spaceID, actorID, normalized).Scan(&conflictID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if conflictID != "" {
		return ErrEmailAlreadyBound
	}

	var existingRaw string
	err = tx.QueryRow(ctx, `SELECT prefs_json FROM user_preferences WHERE user_id = $1 FOR UPDATE`, actorID).Scan(&existingRaw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	prefs := map[string]any{}
	if existingRaw != "" {
		_ = json.Unmarshal([]byte(existingRaw), &prefs)
	}
	prefs["boundEmail"] = normalized
	prefs["boundEmailAt"] = nowUTC.Format(time.RFC3339)
	encoded, err := json.Marshal(prefs)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO user_preferences (user_id, prefs_json, updated_at)
		VALUES ($1, $2, $3)
		ON CONFLICT (user_id) DO UPDATE SET prefs_json = EXCLUDED.prefs_json, updated_at = EXCLUDED.updated_at
	`, actorID, string(encoded), nowUTC); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO user_notification_preferences (
			user_id, email, email_source, email_verified_at, enabled, immediate_enabled, digest_enabled, updated_at
		)
		VALUES ($1, $2, 'custom', $3, 1, 0, 1, $3)
		ON CONFLICT (user_id) DO UPDATE
		SET email = EXCLUDED.email,
		    email_source = 'custom',
		    email_verified_at = EXCLUDED.email_verified_at,
		    updated_at = EXCLUDED.updated_at
	`, actorID, normalized, nowUTC); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, created_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), 'account.email_bind', 'user', $3, 'success', $5)
	`, randomID("aud"), r.spaceID, actorID, githubLogin, nowUTC); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

func (r *PGRepository) UnbindAccountEmail(ctx context.Context, actorID string, now time.Time) error {
	nowUTC := now.UTC()
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var githubLogin string
	err = tx.QueryRow(ctx, `
		SELECT coalesce(u.github_login, '')
		FROM space_members sm
		JOIN users u ON u.id = sm.user_id
		WHERE sm.space_id = $1 AND sm.user_id = $2 AND sm.removed_at IS NULL AND u.kind = 'human'
	`, r.spaceID, actorID).Scan(&githubLogin)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}

	var existingRaw string
	err = tx.QueryRow(ctx, `SELECT prefs_json FROM user_preferences WHERE user_id = $1 FOR UPDATE`, actorID).Scan(&existingRaw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if existingRaw != "" {
		prefs := map[string]any{}
		_ = json.Unmarshal([]byte(existingRaw), &prefs)
		delete(prefs, "boundEmail")
		delete(prefs, "boundEmailAt")
		encoded, err := json.Marshal(prefs)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE user_preferences SET prefs_json = $2, updated_at = $3 WHERE user_id = $1
		`, actorID, string(encoded), nowUTC); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, created_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), 'account.email_unbind', 'user', $3, 'success', $5)
	`, randomID("aud"), r.spaceID, actorID, githubLogin, nowUTC); err != nil {
		return err
	}

	return tx.Commit(ctx)
}

func (r *PGRepository) ResolveEmailLoginMember(ctx context.Context, userID, normalizedEmail string, now time.Time) (V1BootstrapMember, error) {
	normalized := strings.ToLower(strings.TrimSpace(normalizedEmail))
	nowUTC := now.UTC()

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return V1BootstrapMember{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var uID, uGitHub, uDisplay, uNick, uAvatar, role string
	err = tx.QueryRow(ctx, `
		SELECT
			u.id,
			coalesce(u.github_login, ''),
			coalesce(u.display_name, ''),
			coalesce(u.nickname, ''),
			coalesce(u.avatar_url, ''),
			sm.role
		FROM space_members sm
		JOIN users u ON u.id = sm.user_id
		JOIN user_preferences up ON up.user_id = u.id
		WHERE sm.space_id = $1
		  AND sm.user_id = $2
		  AND sm.removed_at IS NULL
		  AND u.kind = 'human'
		  AND lower(coalesce((up.prefs_json::jsonb ->> 'boundEmail'), '')) = $3
	`, r.spaceID, userID, normalized).Scan(&uID, &uGitHub, &uDisplay, &uNick, &uAvatar, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return V1BootstrapMember{}, ErrChallengeInvalid
	}
	if err != nil {
		return V1BootstrapMember{}, err
	}

	if _, err := tx.Exec(ctx, `UPDATE users SET last_login_at = $2 WHERE id = $1`, uID, nowUTC); err != nil {
		return V1BootstrapMember{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, created_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), 'auth.email.login', 'user', $3, 'success', $5)
	`, randomID("aud"), r.spaceID, uID, uGitHub, nowUTC); err != nil {
		return V1BootstrapMember{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return V1BootstrapMember{}, err
	}

	member := projectBootstrapMember(uID, uGitHub, uDisplay, uNick, "", uAvatar, "human", role, uID, role)
	member.Role = role
	return member, nil
}

func parseMobileReleaseFromPrefsRaw(raw string) (MobileClientRelease, bool) {
	if strings.TrimSpace(raw) == "" {
		return MobileClientRelease{}, false
	}
	var outer map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &outer); err != nil {
		return MobileClientRelease{}, false
	}
	relBytes, ok := outer["mobileClientRelease"]
	if !ok || len(relBytes) == 0 {
		return MobileClientRelease{}, false
	}
	var rel MobileClientRelease
	if err := json.Unmarshal(relBytes, &rel); err != nil {
		return MobileClientRelease{}, false
	}
	if rel.DownloadURL == "" && rel.SHA256 != "" && rel.ByteSize > 0 {
		rel.DownloadURL = "/api/v1/mobile/android/latest.apk"
	}
	if rel.OTA != nil && rel.OTA.DownloadURL == "" && rel.OTA.SHA256 != "" && rel.OTA.ByteSize > 0 {
		rel.OTA.DownloadURL = "/api/v1/mobile/android/latest-ota.zip"
	}
	return rel, true
}

func (r *PGRepository) GetPublicMobileRelease(ctx context.Context) (MobileClientRelease, error) {
	var raw string
	err := r.pool.QueryRow(ctx, `SELECT prefs_json FROM user_preferences WHERE user_id = 'usr_system_beacon'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return MobileClientRelease{}, ErrNotFound
	}
	if err != nil {
		return MobileClientRelease{}, err
	}
	rel, ok := parseMobileReleaseFromPrefsRaw(raw)
	hasAPK := rel.SHA256 != "" && rel.ByteSize > 0
	hasOTA := rel.OTA != nil && rel.OTA.Enabled && rel.OTA.SHA256 != "" && rel.OTA.ByteSize > 0
	if !ok || !rel.Enabled || rel.Version == "" || (!hasAPK && !hasOTA) {
		return MobileClientRelease{}, ErrNotFound
	}
	return rel, nil
}

func (r *PGRepository) GetAdminMobileRelease(ctx context.Context, actorID string) (MobileClientRelease, error) {
	if _, _, err := r.resolveSpaceManager(ctx, actorID); err != nil {
		return MobileClientRelease{}, err
	}
	var raw string
	err := r.pool.QueryRow(ctx, `SELECT prefs_json FROM user_preferences WHERE user_id = 'usr_system_beacon'`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return MobileClientRelease{DownloadURL: "/api/v1/mobile/android/latest.apk"}, nil
	}
	if err != nil {
		return MobileClientRelease{}, err
	}
	if rel, ok := parseMobileReleaseFromPrefsRaw(raw); ok {
		return rel, nil
	}
	return MobileClientRelease{DownloadURL: "/api/v1/mobile/android/latest.apk"}, nil
}

func (r *PGRepository) UpsertAdminMobileRelease(ctx context.Context, actorID string, rel MobileClientRelease, now time.Time) (MobileClientRelease, error) {
	_, githubLogin, err := r.resolveSpaceManager(ctx, actorID)
	if err != nil {
		return MobileClientRelease{}, err
	}
	nowUTC := now.UTC()

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return MobileClientRelease{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var existingRaw string
	err = tx.QueryRow(ctx, `SELECT prefs_json FROM user_preferences WHERE user_id = 'usr_system_beacon' FOR UPDATE`).Scan(&existingRaw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return MobileClientRelease{}, err
	}
	prefs := map[string]any{}
	if existingRaw != "" {
		_ = json.Unmarshal([]byte(existingRaw), &prefs)
	}
	stored := rel
	if stored.DownloadURL == "" {
		stored.DownloadURL = "/api/v1/mobile/android/latest.apk"
	}
	stored.UpdatedBy = actorID
	prefs["mobileClientRelease"] = stored
	encoded, err := json.Marshal(prefs)
	if err != nil {
		return MobileClientRelease{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO user_preferences (user_id, prefs_json, updated_at)
		VALUES ('usr_system_beacon', $1, $2)
		ON CONFLICT (user_id) DO UPDATE SET prefs_json = EXCLUDED.prefs_json, updated_at = EXCLUDED.updated_at
	`, string(encoded), nowUTC); err != nil {
		return MobileClientRelease{}, err
	}

	reason := fmt.Sprintf("enabled=%t version=%s code=%d size=%d", stored.Enabled, stored.Version, stored.VersionCode, stored.ByteSize)
	if _, err := tx.Exec(ctx, `
		INSERT INTO audit_logs (id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, created_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), 'space.mobile_release_update', 'space', $2, 'success', $5, $6)
	`, randomID("aud"), r.spaceID, actorID, githubLogin, reason, nowUTC); err != nil {
		return MobileClientRelease{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return MobileClientRelease{}, err
	}
	return stored, nil
}
