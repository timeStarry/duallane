package auth

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type MobilePGStore struct{ pool *pgxpool.Pool }

func NewMobilePGStore(pool *pgxpool.Pool) *MobilePGStore { return &MobilePGStore{pool: pool} }
func (s *MobilePGStore) Allow(ctx context.Context, subject string, now time.Time) (bool, error) {
	var n int
	err := s.pool.QueryRow(ctx, `INSERT INTO mobile_auth_rate_limits(subject_hash,window_start,attempts) VALUES($1,$2,1) ON CONFLICT(subject_hash,window_start) DO UPDATE SET attempts=mobile_auth_rate_limits.attempts+1 RETURNING attempts`, subject, now.Truncate(time.Minute)).Scan(&n)
	return n <= 60, err
}
func (s *MobilePGStore) SaveFlow(ctx context.Context, f MobileFlow) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO mobile_oauth_flows(id,challenge,redirect_uri,client_state,expires_at) VALUES($1,$2,$3,$4,$5)`, f.ID, f.Challenge, f.RedirectURI, f.ClientState, f.ExpiresAt)
	return err
}
func (s *MobilePGStore) GetFlow(ctx context.Context, id string, now time.Time) (MobileFlow, error) {
	var f MobileFlow
	err := s.pool.QueryRow(ctx, `SELECT id,challenge,redirect_uri,client_state,expires_at FROM mobile_oauth_flows WHERE id=$1 AND expires_at>$2 AND consumed_at IS NULL AND user_id IS NULL`, id, now).Scan(&f.ID, &f.Challenge, &f.RedirectURI, &f.ClientState, &f.ExpiresAt)
	return f, err
}
func (s *MobilePGStore) AuthorizeFlow(ctx context.Context, id, userID, hash string, now time.Time) (MobileFlow, error) {
	var f MobileFlow
	err := s.pool.QueryRow(ctx, `UPDATE mobile_oauth_flows SET user_id=$2,code_hash=$3,expires_at=$4 WHERE id=$1 AND expires_at>$5 AND consumed_at IS NULL AND user_id IS NULL RETURNING id,challenge,redirect_uri,client_state,expires_at`, id, userID, hash, now.Add(time.Minute), now).Scan(&f.ID, &f.Challenge, &f.RedirectURI, &f.ClientState, &f.ExpiresAt)
	return f, err
}
func (s *MobilePGStore) Exchange(ctx context.Context, hash, verifier, redirect string, tokens MobileTokens, now time.Time) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var userID, challenge, uri string
	err = tx.QueryRow(ctx, `SELECT user_id,challenge,redirect_uri FROM mobile_oauth_flows WHERE code_hash=$1 AND expires_at>$2 AND consumed_at IS NULL FOR UPDATE`, hash, now).Scan(&userID, &challenge, &uri)
	if err != nil || uri != redirect || !verifyPKCE(verifier, challenge) {
		return errMobileInvalid
	}
	family, err := newUUID()
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `INSERT INTO mobile_session_families(id,user_id,expires_at) SELECT $1,u.id,$2 FROM users u JOIN space_members sm ON sm.user_id=u.id AND sm.space_id=$3 AND sm.removed_at IS NULL WHERE u.id=$4 AND u.kind='human'`, family, tokens.RefreshTokenExpiresAt, DefaultSpaceID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errMobileInvalid
	}
	if _, err = tx.Exec(ctx, `UPDATE mobile_oauth_flows SET consumed_at=$2 WHERE code_hash=$1`, hash, now); err != nil {
		return err
	}
	if err = insertMobileTokens(ctx, tx, family, tokens); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func insertMobileTokens(ctx context.Context, tx pgx.Tx, family string, tokens MobileTokens) error {
	if _, err := tx.Exec(ctx, `INSERT INTO mobile_refresh_tokens(token_hash,family_id) VALUES($1,$2)`, HashSecret(tokens.RefreshToken), family); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO mobile_access_tokens(token_hash,family_id,expires_at) VALUES($1,$2,$3)`, HashSecret(tokens.AccessToken), family, tokens.AccessTokenExpiresAt)
	return err
}
func (s *MobilePGStore) Rotate(ctx context.Context, hash string, tokens *MobileTokens, now time.Time) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var family, user string
	var expires time.Time
	var revoked, used *time.Time
	err = tx.QueryRow(ctx, `SELECT f.id,f.user_id,f.expires_at,f.revoked_at FROM mobile_session_families f JOIN mobile_refresh_tokens t ON t.family_id=f.id WHERE t.token_hash=$1 FOR UPDATE OF f`, hash).Scan(&family, &user, &expires, &revoked)
	if err != nil || revoked != nil || !expires.After(now) {
		return errMobileInvalid
	}
	if err = tx.QueryRow(ctx, `SELECT consumed_at FROM mobile_refresh_tokens WHERE token_hash=$1`, hash).Scan(&used); err != nil {
		return err
	}
	if used != nil {
		if _, err = tx.Exec(ctx, `UPDATE mobile_session_families SET revoked_at=$2 WHERE id=$1`, family, now); err != nil {
			return err
		}
		if err = tx.Commit(ctx); err != nil {
			return err
		}
		return errMobileInvalid
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users u JOIN space_members sm ON sm.user_id=u.id AND sm.space_id=$2 AND sm.removed_at IS NULL WHERE u.id=$1 AND u.kind='human')`, user, DefaultSpaceID).Scan(&active); err != nil {
		return err
	}
	if !active {
		return errMobileInvalid
	}
	if _, err = tx.Exec(ctx, `UPDATE mobile_refresh_tokens SET consumed_at=$2 WHERE token_hash=$1`, hash, now); err != nil {
		return err
	}
	// The family absolute deadline remains fixed even as each refresh rotates.
	tokens.RefreshTokenExpiresAt = externalTime(expires)
	if err = insertMobileTokens(ctx, tx, family, *tokens); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *MobilePGStore) Revoke(ctx context.Context, hash string, now time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE mobile_session_families SET revoked_at=$2 WHERE id=(SELECT family_id FROM mobile_refresh_tokens WHERE token_hash=$1) AND revoked_at IS NULL`, hash, now)
	return err
}
func (s *MobilePGStore) Resolve(ctx context.Context, hash string, now time.Time) (*Actor, error) {
	actor, err := scanActor(s.pool.QueryRow(ctx, `SELECT u.id,u.github_id,u.github_login,u.email,u.display_name,u.nickname,u.avatar_url,u.search_discoverable,u.kind,sm.role,sm.joined_at FROM mobile_access_tokens t JOIN mobile_session_families f ON f.id=t.family_id JOIN users u ON u.id=f.user_id AND u.kind='human' JOIN space_members sm ON sm.user_id=u.id AND sm.space_id=$3 AND sm.removed_at IS NULL WHERE t.token_hash=$1 AND t.expires_at>$2 AND f.expires_at>$2 AND f.revoked_at IS NULL`, hash, now, DefaultSpaceID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, requiredError()
	}
	if err != nil {
		return nil, wrapInternal("mobile actor", err)
	}
	return actor, nil
}
