package members

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type PGRepository struct {
	pool      *pgxpool.Pool
	idFactory IDFactory
}

func NewPGRepository(pool *pgxpool.Pool, idFactories ...IDFactory) *PGRepository {
	idFactory := IDFactory(func() (string, error) {
		id, err := uuid.NewRandom()
		if err != nil {
			return "", err
		}
		return id.String(), nil
	})
	if len(idFactories) > 0 && idFactories[0] != nil {
		idFactory = idFactories[0]
	}
	return &PGRepository{pool: pool, idFactory: idFactory}
}

func (r *PGRepository) WithTx(ctx context.Context, callback func(Tx) error) error {
	if r == nil || r.pool == nil {
		return internalError("begin member transaction", errors.New("workspace postgres pool is required"))
	}
	if callback == nil {
		return internalError("begin member transaction", errors.New("transaction callback is required"))
	}
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return internalError("begin member transaction", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()
	if err := callback(&pgTx{tx: tx, idFactory: r.idFactory}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return internalError("commit member transaction", err)
	}
	committed = true
	return nil
}

func (r *PGRepository) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("lookup member actor", errors.New("workspace postgres pool is required"))
	}
	return lookupActor(ctx, r.pool, spaceID, userID)
}

func (r *PGRepository) ListMemberRecords(ctx context.Context, spaceID, viewerID string) ([]MemberRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("list workspace members", errors.New("workspace postgres pool is required"))
	}
	rows, err := r.pool.Query(ctx, memberSelect+`WHERE sm.space_id = $1 AND sm.removed_at IS NULL
		ORDER BY CASE sm.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'auditor' THEN 3 ELSE 4 END,
		u.display_name ASC, u.id ASC`, spaceID, viewerID, []string{BeaconUserID, EchoUserID})
	if err != nil {
		return nil, internalError("list workspace members", err)
	}
	defer rows.Close()
	return scanMemberRecords(rows)
}

func (r *PGRepository) FindMemberRecord(ctx context.Context, spaceID, viewerID, userID string) (*MemberRecord, error) {
	if r == nil || r.pool == nil {
		return nil, internalError("find workspace member", errors.New("workspace postgres pool is required"))
	}
	row := r.pool.QueryRow(ctx, memberSelect+`WHERE sm.space_id = $1 AND sm.removed_at IS NULL AND u.id = $4`, spaceID, viewerID, []string{BeaconUserID, EchoUserID}, userID)
	record, err := scanMemberRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find workspace member", err)
	}
	return &record, nil
}

func (r *PGRepository) GetVisibilityRule(ctx context.Context, spaceID, viewerID string) (VisibilityRule, error) {
	if r == nil || r.pool == nil {
		return VisibilityRule{}, internalError("get member visibility", errors.New("workspace postgres pool is required"))
	}
	return getVisibilityRule(ctx, r.pool, spaceID, viewerID)
}

func (r *PGRepository) CountActiveOwners(ctx context.Context, spaceID string) (int, error) {
	if r == nil || r.pool == nil {
		return 0, internalError("count workspace owners", errors.New("workspace postgres pool is required"))
	}
	var count int
	if err := r.pool.QueryRow(ctx, `SELECT COUNT(*) FROM space_members WHERE space_id = $1 AND role = 'owner' AND removed_at IS NULL`, spaceID).Scan(&count); err != nil {
		return 0, internalError("count workspace owners", err)
	}
	return count, nil
}

type pgTx struct {
	tx        pgx.Tx
	idFactory IDFactory
}

func (t *pgTx) LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error) {
	return lookupActor(ctx, t.tx, spaceID, userID)
}

func (t *pgTx) ListMemberRecords(ctx context.Context, spaceID, viewerID string) ([]MemberRecord, error) {
	rows, err := t.tx.Query(ctx, memberSelect+`WHERE sm.space_id = $1 AND sm.removed_at IS NULL
		ORDER BY CASE sm.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'auditor' THEN 3 ELSE 4 END,
		u.display_name ASC, u.id ASC`, spaceID, viewerID, []string{BeaconUserID, EchoUserID})
	if err != nil {
		return nil, internalError("list workspace members", err)
	}
	defer rows.Close()
	return scanMemberRecords(rows)
}

func (t *pgTx) FindMemberRecord(ctx context.Context, spaceID, viewerID, userID string) (*MemberRecord, error) {
	row := t.tx.QueryRow(ctx, memberSelect+`WHERE sm.space_id = $1 AND sm.removed_at IS NULL AND u.id = $4`, spaceID, viewerID, []string{BeaconUserID, EchoUserID}, userID)
	record, err := scanMemberRecord(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("find workspace member", err)
	}
	return &record, nil
}

func (t *pgTx) GetVisibilityRule(ctx context.Context, spaceID, viewerID string) (VisibilityRule, error) {
	return getVisibilityRule(ctx, t.tx, spaceID, viewerID)
}

func (t *pgTx) CountActiveOwners(ctx context.Context, spaceID string) (int, error) {
	var count int
	if err := t.tx.QueryRow(ctx, `SELECT COUNT(*) FROM space_members WHERE space_id = $1 AND role = 'owner' AND removed_at IS NULL`, spaceID).Scan(&count); err != nil {
		return 0, internalError("count workspace owners", err)
	}
	return count, nil
}

func (t *pgTx) Lock(ctx context.Context, key string) error {
	key = strings.TrimSpace(key)
	if key == "" {
		return internalError("lock workspace member resource", errors.New("lock key is required"))
	}
	if _, err := t.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, key); err != nil {
		return internalError("lock workspace member resource", err)
	}
	return nil
}

func (t *pgTx) UpdateOwnProfile(ctx context.Context, spaceID, userID string, nicknameSet bool, nickname *string, discoverableSet bool, discoverable *bool, recallReasonSet bool, recallReason *string) error {
	var nicknameValue any
	if nickname != nil {
		nicknameValue = *nickname
	}
	var discoverableValue any
	if discoverable != nil {
		discoverableValue = *discoverable
	}
	var recallReasonValue any
	if recallReason != nil {
		recallReasonValue = *recallReason
	}
	result, err := t.tx.Exec(ctx, `UPDATE users AS u
		SET nickname = CASE WHEN $3 THEN $4::text ELSE u.nickname END,
			search_discoverable = CASE WHEN $5 THEN $6::boolean ELSE u.search_discoverable END,
			recall_reason = CASE WHEN $7 THEN $8::text ELSE u.recall_reason END
		FROM space_members sm
		WHERE u.id = $1 AND u.kind = 'human' AND sm.space_id = $2 AND sm.user_id = u.id AND sm.removed_at IS NULL`, userID, spaceID, nicknameSet, nicknameValue, discoverableSet, discoverableValue, recallReasonSet, recallReasonValue)
	if err != nil {
		return internalError("update member profile", err)
	}
	if result.RowsAffected() != 1 {
		return authRequiredError()
	}
	return nil
}

func (t *pgTx) UpsertRemark(ctx context.Context, ownerUserID, targetUserID, remark string, updatedAt time.Time) error {
	_, err := t.tx.Exec(ctx, `INSERT INTO user_remarks (owner_user_id, target_user_id, remark, updated_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (owner_user_id, target_user_id) DO UPDATE SET remark = EXCLUDED.remark, updated_at = EXCLUDED.updated_at`, ownerUserID, targetUserID, remark, normalizeTime(updatedAt))
	if err != nil {
		return internalError("upsert member remark", err)
	}
	return nil
}

func (t *pgTx) DeleteRemark(ctx context.Context, ownerUserID, targetUserID string) error {
	if _, err := t.tx.Exec(ctx, `DELETE FROM user_remarks WHERE owner_user_id = $1 AND target_user_id = $2`, ownerUserID, targetUserID); err != nil {
		return internalError("delete member remark", err)
	}
	return nil
}

func (t *pgTx) ReplaceVisibilityGrants(ctx context.Context, spaceID, viewerUserID, createdBy string, visibleUserIDs []string, createdAt time.Time) error {
	if _, err := t.tx.Exec(ctx, `DELETE FROM member_visibility_grants WHERE space_id = $1 AND viewer_user_id = $2`, spaceID, viewerUserID); err != nil {
		return internalError("clear member visibility grants", err)
	}
	for _, visibleUserID := range filterVisibleIDs(uniqueStrings(visibleUserIDs), viewerUserID) {
		if _, err := t.tx.Exec(ctx, `INSERT INTO member_visibility_grants (space_id, viewer_user_id, visible_user_id, created_by, created_at)
			VALUES ($1, $2, $3, $4, $5)`, spaceID, viewerUserID, visibleUserID, createdBy, normalizeTime(createdAt)); err != nil {
			return internalError("write member visibility grant", err)
		}
	}
	return nil
}

func (t *pgTx) UpdateMemberRole(ctx context.Context, spaceID, userID, role string) error {
	result, err := t.tx.Exec(ctx, `UPDATE space_members SET role = $1 WHERE space_id = $2 AND user_id = $3 AND removed_at IS NULL`, role, spaceID, userID)
	if err != nil {
		return internalError("update member role", err)
	}
	if result.RowsAffected() != 1 {
		return memberNotFoundError()
	}
	return nil
}

func (t *pgTx) RemoveMember(ctx context.Context, spaceID, userID string, removedAt time.Time) (bool, error) {
	result, err := t.tx.Exec(ctx, `UPDATE space_members SET removed_at = $1 WHERE space_id = $2 AND user_id = $3 AND removed_at IS NULL`, normalizeTime(removedAt), spaceID, userID)
	if err != nil {
		return false, internalError("remove workspace member", err)
	}
	return result.RowsAffected() == 1, nil
}

func (t *pgTx) RevokeUserConversationMemberships(ctx context.Context, userID string, removedAt time.Time) error {
	if _, err := t.tx.Exec(ctx, `UPDATE conversation_members SET removed_at = $1 WHERE user_id = $2 AND removed_at IS NULL`, normalizeTime(removedAt), userID); err != nil {
		return internalError("revoke member conversations", err)
	}
	return nil
}

func (t *pgTx) RevokeUserSessions(ctx context.Context, userID string, revokedAt time.Time) error {
	if _, err := t.tx.Exec(ctx, `UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL`, normalizeTime(revokedAt), userID); err != nil {
		return internalError("revoke member sessions", err)
	}
	return nil
}

func (t *pgTx) WriteEvent(ctx context.Context, input EventInput) error {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID()
		if err != nil {
			return internalError("generate workspace member event id", err)
		}
		input.ID = id
	}
	if strings.TrimSpace(input.SpaceID) == "" || strings.TrimSpace(input.Type) == "" || input.CreatedAt.IsZero() {
		return internalError("write workspace member event", errors.New("event fields are required"))
	}
	if len(input.PayloadJSON) == 0 {
		input.PayloadJSON = []byte(`{}`)
	}
	var sequence int64
	err := t.tx.QueryRow(ctx, `INSERT INTO workspace_event_cursors (space_id, next_seq)
		VALUES ($1, COALESCE((SELECT MAX(seq) + 1 FROM workspace_events WHERE space_id = $1), 1))
		ON CONFLICT (space_id) DO NOTHING
		RETURNING next_seq`, input.SpaceID).Scan(&sequence)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := t.tx.QueryRow(ctx, `SELECT next_seq FROM workspace_event_cursors WHERE space_id = $1 FOR UPDATE`, input.SpaceID).Scan(&sequence); err != nil {
			return internalError("lock workspace event cursor", err)
		}
		if _, err := t.tx.Exec(ctx, `UPDATE workspace_event_cursors SET next_seq = next_seq + 1 WHERE space_id = $1`, input.SpaceID); err != nil {
			return internalError("advance workspace event cursor", err)
		}
	} else if err != nil {
		return internalError("reserve workspace event sequence", err)
	} else if _, err := t.tx.Exec(ctx, `UPDATE workspace_event_cursors SET next_seq = next_seq + 1 WHERE space_id = $1`, input.SpaceID); err != nil {
		return internalError("advance workspace event cursor", err)
	}
	_, err = t.tx.Exec(ctx, `INSERT INTO workspace_events (
		id, space_id, seq, type, actor_user_id, conversation_id, target_type, target_id, payload_json, created_at
	) VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9, $10)`, input.ID, input.SpaceID, sequence, input.Type, input.ActorID, "", input.TargetType, input.TargetID, string(input.PayloadJSON), normalizeTime(input.CreatedAt))
	if err != nil {
		return internalError("write workspace member event", err)
	}
	return nil
}

func (t *pgTx) WriteAudit(ctx context.Context, input AuditInput) error {
	if strings.TrimSpace(input.ID) == "" {
		id, err := t.newID()
		if err != nil {
			return internalError("generate workspace member audit id", err)
		}
		input.ID = id
	}
	if strings.TrimSpace(input.SpaceID) == "" || strings.TrimSpace(input.Action) == "" || strings.TrimSpace(input.TargetType) == "" || input.CreatedAt.IsZero() {
		return internalError("write workspace member audit", errors.New("audit fields are required"))
	}
	result := input.Result
	if result == "" {
		result = "success"
	}
	_, err := t.tx.Exec(ctx, `INSERT INTO audit_logs (
		id, space_id, actor_user_id, actor_github_login, action, target_type, target_id, result, reason, ip_address, user_agent, request_id, created_at
	) VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)`, input.ID, input.SpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action, input.TargetType, input.TargetID, result, input.Reason, input.IPAddress, input.UserAgent, input.RequestID, normalizeTime(input.CreatedAt))
	if err != nil {
		return internalError("write workspace member audit", err)
	}
	return nil
}

func (t *pgTx) newID() (string, error) {
	if t == nil || t.idFactory == nil {
		return "", errors.New("workspace member id factory is required")
	}
	id, err := t.idFactory()
	if err != nil {
		return "", err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New("id factory returned an empty id")
	}
	return id, nil
}

type memberQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func lookupActor(ctx context.Context, querier memberQuerier, spaceID, userID string) (*auth.Actor, error) {
	var actor auth.Actor
	var githubID, email, nickname, avatarURL *string
	var discoverable bool
	err := querier.QueryRow(ctx, `SELECT u.id, u.github_id, u.github_login, u.email, u.display_name, u.nickname, u.avatar_url, u.search_discoverable, u.kind, sm.role, sm.joined_at
		FROM users u INNER JOIN space_members sm ON sm.user_id = u.id AND sm.space_id = $2 AND sm.removed_at IS NULL
		WHERE u.id = $1`, userID, spaceID).Scan(&actor.ID, &githubID, &actor.GitHubLogin, &email, &actor.DisplayName, &nickname, &avatarURL, &discoverable, &actor.Kind, &actor.Role, &actor.JoinedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, internalError("lookup member actor", err)
	}
	if githubID != nil {
		actor.GitHubID = *githubID
	}
	if email != nil {
		actor.Email = *email
	}
	if nickname != nil {
		actor.Nickname = *nickname
	}
	if avatarURL != nil {
		actor.AvatarURL = *avatarURL
	}
	actor.SearchDiscoverable = discoverable
	return &actor, nil
}

func getVisibilityRule(ctx context.Context, querier memberQuerier, spaceID, viewerID string) (VisibilityRule, error) {
	rule := VisibilityRule{Basis: MemberVisibilityBasis, ViewerUserID: viewerID, AutomaticUserIDs: []string{}, GrantedUserIDs: []string{}, VisibleUserIDs: []string{viewerID}}
	automaticRows, err := querier.Query(ctx, `SELECT DISTINCT visible_cm.user_id
		FROM conversations c
		INNER JOIN conversation_members viewer_cm ON viewer_cm.conversation_id = c.id AND viewer_cm.user_id = $1 AND viewer_cm.removed_at IS NULL
		INNER JOIN conversation_members visible_cm ON visible_cm.conversation_id = c.id AND visible_cm.user_id <> $1 AND visible_cm.removed_at IS NULL
		INNER JOIN space_members visible_sm ON visible_sm.space_id = c.space_id AND visible_sm.user_id = visible_cm.user_id AND visible_sm.removed_at IS NULL
		WHERE c.space_id = $2 AND c.type = 'direct'
		ORDER BY visible_cm.user_id`, viewerID, spaceID)
	if err != nil {
		return VisibilityRule{}, internalError("list automatic member visibility", err)
	}
	defer automaticRows.Close()
	seenAutomatic := make(map[string]struct{})
	for automaticRows.Next() {
		var userID string
		if err := automaticRows.Scan(&userID); err != nil {
			return VisibilityRule{}, internalError("scan automatic member visibility", err)
		}
		if _, seen := seenAutomatic[userID]; !seen {
			seenAutomatic[userID] = struct{}{}
			rule.AutomaticUserIDs = append(rule.AutomaticUserIDs, userID)
		}
	}
	if err := automaticRows.Err(); err != nil {
		return VisibilityRule{}, internalError("list automatic member visibility", err)
	}
	alwaysRows, err := querier.Query(ctx, `SELECT user_id FROM space_members
		WHERE space_id = $1 AND removed_at IS NULL AND user_id = ANY($2::text[]) ORDER BY user_id`, spaceID, []string{BeaconUserID, EchoUserID})
	if err != nil {
		return VisibilityRule{}, internalError("list always-visible members", err)
	}
	defer alwaysRows.Close()
	for alwaysRows.Next() {
		var userID string
		if err := alwaysRows.Scan(&userID); err != nil {
			return VisibilityRule{}, internalError("scan always-visible members", err)
		}
		if _, seen := seenAutomatic[userID]; !seen {
			seenAutomatic[userID] = struct{}{}
			rule.AutomaticUserIDs = append(rule.AutomaticUserIDs, userID)
		}
	}
	if err := alwaysRows.Err(); err != nil {
		return VisibilityRule{}, internalError("list always-visible members", err)
	}
	grantedRows, err := querier.Query(ctx, `SELECT visible_user_id FROM member_visibility_grants WHERE space_id = $1 AND viewer_user_id = $2 ORDER BY visible_user_id`, spaceID, viewerID)
	if err != nil {
		return VisibilityRule{}, internalError("list member visibility grants", err)
	}
	defer grantedRows.Close()
	for grantedRows.Next() {
		var userID string
		if err := grantedRows.Scan(&userID); err != nil {
			return VisibilityRule{}, internalError("scan member visibility grants", err)
		}
		if userID != BeaconUserID && userID != EchoUserID {
			rule.GrantedUserIDs = append(rule.GrantedUserIDs, userID)
		}
	}
	if err := grantedRows.Err(); err != nil {
		return VisibilityRule{}, internalError("list member visibility grants", err)
	}
	for _, userID := range append(append([]string{}, rule.AutomaticUserIDs...), rule.GrantedUserIDs...) {
		if !containsString(rule.VisibleUserIDs, userID) {
			rule.VisibleUserIDs = append(rule.VisibleUserIDs, userID)
		}
	}
	return rule, nil
}

const memberSelect = `SELECT
	u.id, u.github_login, u.display_name, u.nickname, ur.remark, u.avatar_url,
	u.search_discoverable, u.recall_reason, u.kind, sm.role, sm.joined_at,
	(
		EXISTS (SELECT 1 FROM space_members viewer_sm WHERE viewer_sm.space_id = $1 AND viewer_sm.user_id = $2 AND viewer_sm.role = 'owner' AND viewer_sm.removed_at IS NULL)
		OR u.id = $2
		OR EXISTS (
			SELECT 1 FROM conversations c
			INNER JOIN conversation_members viewer_cm ON viewer_cm.conversation_id = c.id AND viewer_cm.user_id = $2 AND viewer_cm.removed_at IS NULL
			INNER JOIN conversation_members visible_cm ON visible_cm.conversation_id = c.id AND visible_cm.user_id = u.id AND visible_cm.removed_at IS NULL
			WHERE c.space_id = $1 AND c.type = 'direct'
		)
		OR EXISTS (SELECT 1 FROM member_visibility_grants g WHERE g.space_id = $1 AND g.viewer_user_id = $2 AND g.visible_user_id = u.id)
		OR u.id = ANY($3::text[])
	) AS normally_visible
FROM users u
INNER JOIN space_members sm ON sm.user_id = u.id
LEFT JOIN user_remarks ur ON ur.owner_user_id = $2 AND ur.target_user_id = u.id
`

func scanMemberRecord(row interface{ Scan(...any) error }) (MemberRecord, error) {
	var record MemberRecord
	var nickname, remark, avatarURL, recallReason *string
	if err := row.Scan(&record.ID, &record.GitHubLogin, &record.DisplayName, &nickname, &remark, &avatarURL, &record.SearchDiscoverable, &recallReason, &record.Kind, &record.Role, &record.JoinedAt, &record.NormallyVisible); err != nil {
		return MemberRecord{}, err
	}
	record.Nickname = nickname
	record.Remark = remark
	record.AvatarURL = stringValue(avatarURL)
	record.RecallReason = recallReason
	return record, nil
}

func scanMemberRecords(rows pgx.Rows) ([]MemberRecord, error) {
	items := make([]MemberRecord, 0)
	for rows.Next() {
		item, err := scanMemberRecord(rows)
		if err != nil {
			return nil, internalError("scan workspace members", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("scan workspace members", err)
	}
	return items, nil
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
