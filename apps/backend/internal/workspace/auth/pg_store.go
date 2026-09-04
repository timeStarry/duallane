package auth

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PGStore is the Workspace auth/session adapter for the authoritative
// PostgreSQL database. It intentionally exposes no generic query method to
// domain callers.
type PGStore struct {
	pool      *pgxpool.Pool
	idFactory IDFactory
}

func NewPGStore(pool *pgxpool.Pool, idFactories ...IDFactory) *PGStore {
	idFactory := IDFactory(newUUID)
	if len(idFactories) > 0 && idFactories[0] != nil {
		idFactory = idFactories[0]
	}
	return &PGStore{pool: pool, idFactory: idFactory}
}

func (s *PGStore) newID() (string, error) {
	if s == nil {
		return "", errors.New("workspace postgres store is required")
	}
	factory := s.idFactory
	if factory == nil {
		factory = newUUID
	}
	id, err := factory()
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(id) == "" {
		return "", errors.New("id factory returned an empty id")
	}
	return id, nil
}

func (s *PGStore) Ping(ctx context.Context) error {
	if s == nil || s.pool == nil {
		return errors.New("workspace postgres pool is required")
	}
	return s.pool.Ping(ctx)
}

func (s *PGStore) CreateSession(ctx context.Context, record SessionRecord) error {
	if s == nil || s.pool == nil {
		return wrapInternal("create session", errors.New("workspace postgres pool is required"))
	}
	if record.ID == "" || record.TokenHash == "" || record.UserID == "" || record.ExpiresAt.IsZero() || record.CreatedAt.IsZero() {
		return requiredError()
	}
	var insertedID string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, revoked_at)
		SELECT $1, $2, u.id, $4, $5, NULL
		FROM users u
		INNER JOIN space_members sm
		  ON sm.user_id = u.id
		 AND sm.space_id = $3
		 AND sm.removed_at IS NULL
		WHERE u.id = $6 AND u.kind = 'human'
		RETURNING id
	`, record.ID, record.TokenHash, DefaultSpaceID, record.CreatedAt.UTC(), record.ExpiresAt.UTC(), record.UserID).Scan(&insertedID)
	if errors.Is(err, pgx.ErrNoRows) {
		return requiredError()
	}
	if err != nil {
		return wrapInternal("insert session", err)
	}
	if insertedID == "" {
		return wrapInternal("insert session", errors.New("session insert returned no id"))
	}
	return nil
}

func (s *PGStore) LookupSessionActor(ctx context.Context, tokenHash string, now time.Time) (*Actor, error) {
	if s == nil || s.pool == nil {
		return nil, wrapInternal("lookup session", errors.New("workspace postgres pool is required"))
	}
	if strings.TrimSpace(tokenHash) == "" {
		return nil, nil
	}
	actor, err := scanActor(s.pool.QueryRow(ctx, `
		SELECT
			u.id,
			u.github_id,
			u.github_login,
			u.email,
			u.display_name,
			u.nickname,
			u.avatar_url,
			u.search_discoverable,
			u.kind,
			sm.role,
			sm.joined_at
		FROM sessions s
		INNER JOIN users u ON u.id = s.user_id AND u.kind = 'human'
		INNER JOIN space_members sm
		  ON sm.user_id = s.user_id
		 AND sm.space_id = $3
		 AND sm.removed_at IS NULL
		WHERE s.token_hash = $1
		  AND s.revoked_at IS NULL
		  AND s.expires_at > $2
	`, tokenHash, now.UTC(), DefaultSpaceID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, wrapInternal("lookup session", err)
	}
	return actor, nil
}

func (s *PGStore) LookupActiveActorByID(ctx context.Context, userID string) (*Actor, error) {
	if s == nil || s.pool == nil {
		return nil, wrapInternal("lookup actor", errors.New("workspace postgres pool is required"))
	}
	if strings.TrimSpace(userID) == "" {
		return nil, nil
	}
	actor, err := scanActor(s.pool.QueryRow(ctx, `
		SELECT
			u.id,
			u.github_id,
			u.github_login,
			u.email,
			u.display_name,
			u.nickname,
			u.avatar_url,
			u.search_discoverable,
			u.kind,
			sm.role,
			sm.joined_at
		FROM users u
		INNER JOIN space_members sm
		  ON sm.user_id = u.id
		 AND sm.space_id = $2
		 AND sm.removed_at IS NULL
		WHERE u.id = $1 AND u.kind = 'human'
	`, userID, DefaultSpaceID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, wrapInternal("lookup actor", err)
	}
	return actor, nil
}

func (s *PGStore) RevokeSession(ctx context.Context, tokenHash string, now time.Time) (bool, error) {
	if s == nil || s.pool == nil {
		return false, wrapInternal("revoke session", errors.New("workspace postgres pool is required"))
	}
	if strings.TrimSpace(tokenHash) == "" {
		return false, nil
	}
	result, err := s.pool.Exec(ctx, `
		UPDATE sessions
		SET revoked_at = $1
		WHERE token_hash = $2 AND revoked_at IS NULL
	`, normalizeTimestamp(now), tokenHash)
	if err != nil {
		return false, wrapInternal("revoke session", err)
	}
	return result.RowsAffected() == 1, nil
}

func (s *PGStore) RecordGitHubLoginRejection(ctx context.Context, phase string, now time.Time, meta RequestMeta) error {
	if s == nil || s.pool == nil {
		return wrapInternal("record github rejection", errors.New("workspace postgres pool is required"))
	}
	phase = normalizeOAuthFailurePhase(phase)
	meta = meta.Safe()
	auditID, err := s.newID()
	if err != nil {
		return wrapInternal("generate github rejection audit id", err)
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO audit_logs (
			id, space_id, actor_user_id, actor_github_login, action, target_type,
			target_id, result, reason, ip_address, user_agent, request_id, created_at
		)
		VALUES ($1, $2, NULL, NULL, 'login.rejected', 'github_oauth', $3, 'rejected', $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), $8)
	`, auditID, DefaultSpaceID, phase, CodeGitHubFailed, meta.IPAddress, meta.UserAgent, meta.RequestID, normalizeTimestamp(now))
	if err != nil {
		return wrapInternal("record github rejection", err)
	}
	return nil
}

func (s *PGStore) RecordInviteAcceptRejection(ctx context.Context, reason string, now time.Time, meta RequestMeta) error {
	if s == nil || s.pool == nil {
		return wrapInternal("record invite acceptance rejection", errors.New("workspace postgres pool is required"))
	}
	reason = normalizeInviteRejectionReason(reason)
	meta = meta.Safe()
	auditID, err := s.newID()
	if err != nil {
		return wrapInternal("generate invite acceptance rejection audit id", err)
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO audit_logs (
			id, space_id, actor_user_id, actor_github_login, action, target_type,
			target_id, result, reason, ip_address, user_agent, request_id, created_at
		)
		VALUES ($1, $2, NULL, NULL, 'invite.accept', 'invite', NULL, 'rejected', $3,
			NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7)
	`, auditID, DefaultSpaceID, reason, meta.IPAddress, meta.UserAgent, meta.RequestID, normalizeTimestamp(now))
	if err != nil {
		return wrapInternal("record invite acceptance rejection", err)
	}
	return nil
}

func (s *PGStore) AuthenticateGitHub(ctx context.Context, profile GitHubProfile, inviteCodeHash string, now time.Time, meta RequestMeta) (*Actor, error) {
	if s == nil || s.pool == nil {
		return nil, wrapInternal("authenticate github", errors.New("workspace postgres pool is required"))
	}
	normalized, err := NormalizeGitHubProfile(profile)
	if err != nil {
		return nil, err
	}
	now = normalizeTimestamp(now)
	meta = meta.Safe()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, wrapInternal("begin github authentication", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()

	candidate, err := findIdentity(ctx, tx, normalized)
	if err != nil {
		var identityErr *Error
		if errors.As(err, &identityErr) && identityErr.Code == CodeIdentityConflict {
			return s.rejectAuth(ctx, tx, normalized, CodeIdentityConflict, "user", identityTarget(nil, normalized), identityErr, meta, now, &committed)
		}
		return nil, wrapInternal("resolve github identity", err)
	}
	if candidate != nil && candidate.Kind != "human" {
		return s.rejectAuth(ctx, tx, normalized, CodeIdentityForbidden, "user", candidate.ID, NewError(CodeIdentityForbidden, MessageIdentityForbidden, 401), meta, now, &committed)
	}
	if candidate != nil && candidate.GitHubID != "" && normalized.ID != "" && candidate.GitHubID != normalized.ID {
		return s.rejectAuth(ctx, tx, normalized, CodeIdentityConflict, "user", candidate.ID, NewError(CodeIdentityConflict, MessageIdentityConflict, 401), meta, now, &committed)
	}

	if candidate == nil && isSeededOwnerProfile(normalized) {
		candidate, err = findSeededOwner(ctx, tx)
		if err != nil {
			return nil, wrapInternal("resolve seeded owner", err)
		}
		if candidate != nil && candidate.GitHubID != "" && normalized.ID != "" && candidate.GitHubID != normalized.ID {
			return s.rejectAuth(ctx, tx, normalized, CodeIdentityConflict, "user", candidate.ID, NewError(CodeIdentityConflict, MessageIdentityConflict, 401), meta, now, &committed)
		}
	}

	if candidate != nil && candidate.Role != "" {
		if err := updateUser(ctx, tx, candidate.ID, normalized, now); err != nil {
			return nil, wrapInternal("bind github identity", err)
		}
		if err := s.writeAudit(ctx, tx, auditInput{
			ActorUserID:      candidate.ID,
			ActorGitHubLogin: normalized.Login,
			Action:           "login.success",
			TargetType:       "user",
			TargetID:         candidate.ID,
			Result:           "success",
			Meta:             meta,
			CreatedAt:        now,
		}); err != nil {
			return nil, wrapInternal("audit github login", err)
		}
		actor, err := findActorByID(ctx, tx, candidate.ID)
		if err != nil {
			return nil, wrapInternal("project github actor", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, wrapInternal("commit github login", err)
		}
		committed = true
		return actor, nil
	}

	needsInvitation := candidate == nil || candidate.Role == ""
	if needsInvitation {
		if err := s.writeAudit(ctx, tx, auditInput{
			ActorGitHubLogin: normalized.Login,
			Action:           "login.rejected",
			TargetType:       "user",
			TargetID:         identityTarget(candidate, normalized),
			Result:           "rejected",
			Reason:           "not invited",
			Meta:             meta,
			CreatedAt:        now,
		}); err != nil {
			return nil, wrapInternal("audit not invited login", err)
		}
	}
	if inviteCodeHash == "" {
		if err := tx.Commit(ctx); err != nil {
			return nil, wrapInternal("commit rejected login", err)
		}
		committed = true
		return nil, NewError(CodeNotInvited, MessageNotInvited, 401)
	}

	invite, err := findInvite(ctx, tx, inviteCodeHash)
	if err != nil {
		return nil, wrapInternal("resolve invite", err)
	}
	if invite == nil {
		return s.rejectInvite(ctx, tx, normalized, nil, CodeInviteInvalid, MessageInviteInvalid, meta, now, &committed)
	}
	if invite.RevokedAt != nil {
		return s.rejectInvite(ctx, tx, normalized, invite, CodeInviteInvalid, MessageInviteInvalid, meta, now, &committed)
	}
	if invite.ExpiresAt != nil && !invite.ExpiresAt.After(now) {
		return s.rejectInvite(ctx, tx, normalized, invite, CodeInviteExpired, MessageInviteExpired, meta, now, &committed)
	}
	if invite.Uses >= invite.MaxUses {
		return s.rejectInvite(ctx, tx, normalized, invite, CodeInviteExhausted, MessageInviteExhausted, meta, now, &committed)
	}

	reservedInvite, err := reserveInvite(ctx, tx, invite.ID, now)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			latest, latestErr := findInviteByID(ctx, tx, invite.ID)
			if latestErr != nil {
				return nil, wrapInternal("recheck invite", latestErr)
			}
			code, message := inviteFailure(latest, now)
			return s.rejectInvite(ctx, tx, normalized, latest, code, message, meta, now, &committed)
		}
		return nil, wrapInternal("reserve invite", err)
	}

	userID := ""
	if candidate == nil {
		userID, err = s.newID()
		if err != nil || strings.TrimSpace(userID) == "" {
			if err == nil {
				err = errors.New("id factory returned an empty id")
			}
			return nil, wrapInternal("create github user", err)
		}
		if err := insertUser(ctx, tx, userID, normalized, now); err != nil {
			return nil, wrapInternal("create github user", err)
		}
	} else {
		userID = candidate.ID
		if err := updateUser(ctx, tx, userID, normalized, now); err != nil {
			return nil, wrapInternal("bind invited github user", err)
		}
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO space_members (space_id, user_id, role, joined_at, removed_at)
		VALUES ($1, $2, $3, $4, NULL)
		ON CONFLICT (space_id, user_id) DO UPDATE SET
			role = EXCLUDED.role,
			removed_at = NULL
	`, DefaultSpaceID, userID, reservedInvite.DefaultRole, now); err != nil {
		return nil, wrapInternal("accept invite membership", err)
	}
	actor, err := findActorByID(ctx, tx, userID)
	if err != nil {
		return nil, wrapInternal("project invited actor", err)
	}
	if err := s.writeMemberJoinedEvent(ctx, tx, actor, reservedInvite.ID, now); err != nil {
		return nil, wrapInternal("write member joined event", err)
	}
	if err := s.writeAudit(ctx, tx, auditInput{
		ActorUserID:      userID,
		ActorGitHubLogin: normalized.Login,
		Action:           "invite.accept",
		TargetType:       "invite",
		TargetID:         reservedInvite.ID,
		Result:           "success",
		Meta:             meta,
		CreatedAt:        now,
	}); err != nil {
		return nil, wrapInternal("audit invite acceptance", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, wrapInternal("commit invite acceptance", err)
	}
	committed = true
	return actor, nil
}

func (s *PGStore) rejectAuth(ctx context.Context, tx pgx.Tx, profile GitHubProfile, code, targetType, targetID string, result *Error, meta RequestMeta, now time.Time, committed *bool) (*Actor, error) {
	if err := s.writeAudit(ctx, tx, auditInput{
		ActorGitHubLogin: profile.Login,
		Action:           "login.rejected",
		TargetType:       targetType,
		TargetID:         targetID,
		Result:           "rejected",
		Reason:           code,
		Meta:             meta,
		CreatedAt:        now,
	}); err != nil {
		return nil, wrapInternal("audit rejected login", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, wrapInternal("commit rejected login", err)
	}
	*committed = true
	return nil, result
}

func (s *PGStore) rejectInvite(ctx context.Context, tx pgx.Tx, profile GitHubProfile, invite *inviteRecord, code, message string, meta RequestMeta, now time.Time, committed *bool) (*Actor, error) {
	targetID := ""
	if invite != nil {
		targetID = invite.ID
	}
	if err := s.writeAudit(ctx, tx, auditInput{
		ActorGitHubLogin: profile.Login,
		Action:           "invite.accept",
		TargetType:       "invite",
		TargetID:         targetID,
		Result:           "rejected",
		Reason:           inviteAuditReason(code),
		Meta:             meta,
		CreatedAt:        now,
	}); err != nil {
		return nil, wrapInternal("audit rejected invite", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, wrapInternal("commit rejected invite", err)
	}
	*committed = true
	status := 400
	return nil, NewError(code, message, status)
}

type identityRecord struct {
	ID                 string
	GitHubID           string
	GitHubLogin        string
	Email              string
	DisplayName        string
	Nickname           string
	AvatarURL          string
	SearchDiscoverable bool
	Kind               string
	Role               string
	JoinedAt           time.Time
}

func findIdentity(ctx context.Context, tx pgx.Tx, profile GitHubProfile) (*identityRecord, error) {
	rows, err := tx.Query(ctx, `
		SELECT
			u.id,
			u.github_id,
			u.github_login,
			u.email,
			u.display_name,
			u.nickname,
			u.avatar_url,
			u.search_discoverable,
			u.kind,
			sm.role,
			sm.joined_at
		FROM users u
		LEFT JOIN space_members sm
		  ON sm.user_id = u.id
		 AND sm.space_id = $1
		 AND sm.removed_at IS NULL
		WHERE ($2 <> '' AND u.github_id = $2)
		   OR ($3 <> '' AND u.github_login = $3)
		   OR ($4 <> '' AND u.email = $4)
	`, DefaultSpaceID, profile.ID, profile.Login, profile.Email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var byID *identityRecord
	aliases := make(map[string]*identityRecord)
	for rows.Next() {
		candidate, err := scanIdentity(rows)
		if err != nil {
			return nil, err
		}
		if profile.ID != "" && candidate.GitHubID == profile.ID {
			byID = candidate
		}
		if (profile.Login != "" && candidate.GitHubLogin == profile.Login) || (profile.Email != "" && candidate.Email == profile.Email) {
			aliases[candidate.ID] = candidate
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if byID != nil {
		for id := range aliases {
			if id != byID.ID {
				return nil, identityConflictError()
			}
		}
		return byID, nil
	}
	if len(aliases) > 1 {
		return nil, identityConflictError()
	}
	for _, candidate := range aliases {
		return candidate, nil
	}
	return nil, nil
}

func findSeededOwner(ctx context.Context, tx pgx.Tx) (*identityRecord, error) {
	row := tx.QueryRow(ctx, `
		SELECT
			u.id,
			u.github_id,
			u.github_login,
			u.email,
			u.display_name,
			u.nickname,
			u.avatar_url,
			u.search_discoverable,
			u.kind,
			sm.role,
			sm.joined_at
		FROM users u
		LEFT JOIN space_members sm
		  ON sm.user_id = u.id
		 AND sm.space_id = $2
		 AND sm.removed_at IS NULL
		WHERE u.id = $1
	`, SeededOwnerID, DefaultSpaceID)
	candidate, err := scanIdentity(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return candidate, err
}

func findActorByID(ctx context.Context, tx pgx.Tx, userID string) (*Actor, error) {
	return scanActor(tx.QueryRow(ctx, `
		SELECT
			u.id,
			u.github_id,
			u.github_login,
			u.email,
			u.display_name,
			u.nickname,
			u.avatar_url,
			u.search_discoverable,
			u.kind,
			sm.role,
			sm.joined_at
		FROM users u
		INNER JOIN space_members sm
		  ON sm.user_id = u.id
		 AND sm.space_id = $2
		 AND sm.removed_at IS NULL
		WHERE u.id = $1
	`, userID, DefaultSpaceID))
}

func scanIdentity(row rowScanner) (*identityRecord, error) {
	var candidate identityRecord
	var githubID, email, nickname, avatarURL, role *string
	var searchDiscoverable bool
	var joinedAt *time.Time
	if err := row.Scan(&candidate.ID, &githubID, &candidate.GitHubLogin, &email, &candidate.DisplayName, &nickname, &avatarURL, &searchDiscoverable, &candidate.Kind, &role, &joinedAt); err != nil {
		return nil, err
	}
	candidate.GitHubID = stringValue(githubID)
	candidate.Email = stringValue(email)
	candidate.Nickname = stringValue(nickname)
	candidate.AvatarURL = stringValue(avatarURL)
	candidate.SearchDiscoverable = searchDiscoverable
	candidate.Role = stringValue(role)
	if joinedAt != nil {
		candidate.JoinedAt = joinedAt.UTC()
	}
	return &candidate, nil
}

func scanActor(row rowScanner) (*Actor, error) {
	candidate, err := scanIdentity(row)
	if err != nil {
		return nil, err
	}
	return &Actor{
		ID:                 candidate.ID,
		GitHubID:           candidate.GitHubID,
		GitHubLogin:        candidate.GitHubLogin,
		Email:              candidate.Email,
		DisplayName:        candidate.DisplayName,
		Nickname:           candidate.Nickname,
		AvatarURL:          candidate.AvatarURL,
		SearchDiscoverable: candidate.SearchDiscoverable,
		Kind:               candidate.Kind,
		Role:               candidate.Role,
		JoinedAt:           candidate.JoinedAt,
	}, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

type inviteRecord struct {
	ID          string
	DefaultRole string
	MaxUses     int32
	Uses        int32
	ExpiresAt   *time.Time
	RevokedAt   *time.Time
}

func findInvite(ctx context.Context, tx pgx.Tx, codeHash string) (*inviteRecord, error) {
	row := tx.QueryRow(ctx, `
		SELECT id, default_role, max_uses, uses, expires_at, revoked_at
		FROM invites
		WHERE code_hash = $1 AND space_id = $2
	`, codeHash, DefaultSpaceID)
	return scanInvite(row)
}

func findInviteByID(ctx context.Context, tx pgx.Tx, inviteID string) (*inviteRecord, error) {
	row := tx.QueryRow(ctx, `
		SELECT id, default_role, max_uses, uses, expires_at, revoked_at
		FROM invites
		WHERE id = $1 AND space_id = $2
	`, inviteID, DefaultSpaceID)
	return scanInvite(row)
}

func scanInvite(row rowScanner) (*inviteRecord, error) {
	var invite inviteRecord
	if err := row.Scan(&invite.ID, &invite.DefaultRole, &invite.MaxUses, &invite.Uses, &invite.ExpiresAt, &invite.RevokedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &invite, nil
}

func reserveInvite(ctx context.Context, tx pgx.Tx, inviteID string, now time.Time) (*inviteRecord, error) {
	row := tx.QueryRow(ctx, `
		UPDATE invites
		SET uses = uses + 1
		WHERE id = $1
		  AND space_id = $2
		  AND revoked_at IS NULL
		  AND uses < max_uses
		  AND (expires_at IS NULL OR expires_at > $3)
		RETURNING id, default_role, max_uses, uses, expires_at, revoked_at
	`, inviteID, DefaultSpaceID, now.UTC())
	var invite inviteRecord
	if err := row.Scan(&invite.ID, &invite.DefaultRole, &invite.MaxUses, &invite.Uses, &invite.ExpiresAt, &invite.RevokedAt); err != nil {
		return nil, err
	}
	return &invite, nil
}

func inviteFailure(invite *inviteRecord, now time.Time) (string, string) {
	if invite == nil || invite.RevokedAt != nil {
		return CodeInviteInvalid, MessageInviteInvalid
	}
	if invite.ExpiresAt != nil && !invite.ExpiresAt.After(now) {
		return CodeInviteExpired, MessageInviteExpired
	}
	return CodeInviteExhausted, MessageInviteExhausted
}

func inviteAuditReason(code string) string {
	switch code {
	case CodeInviteExpired:
		return "expired invite"
	case CodeInviteExhausted:
		return "invite exhausted"
	default:
		return "invalid invite"
	}
}

func insertUser(ctx context.Context, tx pgx.Tx, userID string, profile GitHubProfile, now time.Time) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO users (
			id, github_id, github_login, email, display_name, nickname,
			avatar_url, github_avatar_url, kind, created_at, last_login_at
		)
		VALUES ($1, NULLIF($2, ''), $3, NULLIF($4, ''), $5, $5, NULLIF($6, ''), NULLIF($6, ''), 'human', $7, $7)
	`, userID, profile.ID, profile.Login, profile.Email, profile.Name, profile.AvatarURL, now.UTC())
	return err
}

func updateUser(ctx context.Context, tx pgx.Tx, userID string, profile GitHubProfile, now time.Time) error {
	_, err := tx.Exec(ctx, `
		UPDATE users
		SET
			github_id = COALESCE(github_id, NULLIF($2, '')),
			github_login = COALESCE(NULLIF($3, ''), github_login),
			email = COALESCE(NULLIF($4, ''), email),
			display_name = COALESCE(NULLIF($5, ''), display_name),
			github_avatar_url = COALESCE(NULLIF($6, ''), github_avatar_url),
			avatar_url = CASE WHEN avatar_storage_key IS NULL THEN COALESCE(NULLIF($6, ''), avatar_url) ELSE avatar_url END,
			last_login_at = $7
		WHERE id = $1
	`, userID, profile.ID, profile.Login, profile.Email, profile.Name, profile.AvatarURL, now.UTC())
	return err
}

type auditInput struct {
	ActorUserID      string
	ActorGitHubLogin string
	Action           string
	TargetType       string
	TargetID         string
	Result           string
	Reason           string
	Meta             RequestMeta
	CreatedAt        time.Time
}

func (s *PGStore) writeAudit(ctx context.Context, tx pgx.Tx, input auditInput) error {
	meta := input.Meta.Safe()
	createdAt := input.CreatedAt
	if createdAt.IsZero() {
		return errors.New("audit timestamp is required")
	}
	createdAt = normalizeTimestamp(createdAt)
	auditID, err := s.newID()
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO audit_logs (
			id, space_id, actor_user_id, actor_github_login, action, target_type,
			target_id, result, reason, ip_address, user_agent, request_id, created_at
		)
		VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''), $13)
	`, auditID, DefaultSpaceID, input.ActorUserID, input.ActorGitHubLogin, input.Action, input.TargetType, input.TargetID, input.Result, input.Reason, meta.IPAddress, meta.UserAgent, meta.RequestID, createdAt)
	return err
}

func (s *PGStore) writeMemberJoinedEvent(ctx context.Context, tx pgx.Tx, actor *Actor, inviteID string, now time.Time) error {
	if actor == nil || strings.TrimSpace(actor.ID) == "" {
		return errors.New("member actor is required")
	}
	var nextSeq int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO workspace_event_cursors (space_id, next_seq)
		VALUES ($1, 2)
		ON CONFLICT (space_id) DO UPDATE
		SET next_seq = workspace_event_cursors.next_seq + 1
		RETURNING next_seq - 1
	`, DefaultSpaceID).Scan(&nextSeq); err != nil {
		return err
	}
	payload, err := memberJoinedEventPayload(actor, inviteID)
	if err != nil {
		return err
	}
	eventID, err := s.newID()
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO workspace_events (
			id, space_id, seq, type, actor_user_id, conversation_id,
			target_type, target_id, payload_json, created_at
		)
		VALUES ($1, $2, $3, 'workspace.member_joined', $4, NULL, 'user', $5, $6, $7)
	`, eventID, DefaultSpaceID, nextSeq, actor.ID, actor.ID, string(payload), normalizeTimestamp(now))
	return err
}

func memberJoinedEventPayload(actor *Actor, inviteID string) ([]byte, error) {
	if actor == nil || strings.TrimSpace(actor.ID) == "" {
		return nil, errors.New("member actor is required")
	}
	return json.Marshal(map[string]any{
		"userId":   actor.ID,
		"role":     actor.Role,
		"inviteId": inviteID,
		"member":   PublicMemberProjection(actor),
	})
}

func identityTarget(candidate *identityRecord, profile GitHubProfile) string {
	if candidate != nil {
		return candidate.ID
	}
	if profile.Login != "" {
		return profile.Login
	}
	if profile.Email != "" {
		return profile.Email
	}
	return profile.ID
}

func identityConflictError() error {
	return NewError(CodeIdentityConflict, MessageIdentityConflict, 401)
}

func isSeededOwnerProfile(profile GitHubProfile) bool {
	return strings.EqualFold(profile.Login, SeededOwnerGitHubLogin) || strings.EqualFold(profile.Email, SeededOwnerEmail)
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

var _ Store = (*PGStore)(nil)
var _ ActiveActorLookup = (*PGStore)(nil)
