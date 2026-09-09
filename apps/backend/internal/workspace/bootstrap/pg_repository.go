package bootstrap

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PGRepository struct {
	pool *pgxpool.Pool
}

func NewPGRepository(pool *pgxpool.Pool) *PGRepository {
	return &PGRepository{pool: pool}
}

func (repository *PGRepository) Load(ctx context.Context, spaceID, actorRole string, now time.Time) (RepositorySnapshot, error) {
	if repository == nil || repository.pool == nil {
		return RepositorySnapshot{}, errors.New("workspace postgres pool is required")
	}
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return RepositorySnapshot{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	result := RepositorySnapshot{Invites: make([]InviteRecord, 0)}
	err = tx.QueryRow(ctx, `SELECT id, name, slug, created_by, created_at FROM spaces WHERE id = $1`, spaceID).Scan(
		&result.Space.ID, &result.Space.Name, &result.Space.Slug, &result.Space.CreatedBy, &result.Space.CreatedAt,
	)
	if err != nil {
		return RepositorySnapshot{}, err
	}
	result.Space.CreatedAt = result.Space.CreatedAt.UTC()

	canViewInvites := actorRole == "owner" || actorRole == "admin"
	if canViewInvites {
		viewAllRoles := actorRole == "owner"
		rows, queryErr := tx.Query(ctx, `SELECT id, code_preview, default_role, max_uses, uses, expires_at, revoked_at, created_at
			FROM invites
			WHERE space_id = $1 AND ($2 OR default_role = 'member')
			ORDER BY created_at DESC
			LIMIT 100`, spaceID, viewAllRoles)
		if queryErr != nil {
			return RepositorySnapshot{}, queryErr
		}
		for rows.Next() {
			var invite InviteRecord
			if scanErr := rows.Scan(&invite.ID, &invite.CodePreview, &invite.DefaultRole, &invite.MaxUses, &invite.Uses,
				&invite.ExpiresAt, &invite.RevokedAt, &invite.CreatedAt); scanErr != nil {
				rows.Close()
				return RepositorySnapshot{}, scanErr
			}
			normalizeInviteTimes(&invite)
			result.Invites = append(result.Invites, invite)
		}
		if rows.Err() != nil {
			rows.Close()
			return RepositorySnapshot{}, rows.Err()
		}
		rows.Close()

		err = tx.QueryRow(ctx, `SELECT COUNT(*), COALESCE(SUM(uses), 0),
			COALESCE(SUM(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $3) AND uses < max_uses THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $3) AND uses < max_uses THEN max_uses - uses ELSE 0 END), 0)
			FROM invites WHERE space_id = $1 AND ($2 OR default_role = 'member')`, spaceID, viewAllRoles, now.UTC()).Scan(
			&result.InviteSummary.Total, &result.InviteSummary.AcceptedUses,
			&result.InviteSummary.Active, &result.InviteSummary.AvailableUses,
		)
		if err != nil {
			return RepositorySnapshot{}, err
		}
		result.InviteSummary.History = max(0, result.InviteSummary.Total-result.InviteSummary.Active)

		if len(result.Invites) > 0 {
			inviteIDs := make([]string, 0, len(result.Invites))
			byID := make(map[string]*InviteRecord, len(result.Invites))
			for index := range result.Invites {
				inviteIDs = append(inviteIDs, result.Invites[index].ID)
				byID[result.Invites[index].ID] = &result.Invites[index]
			}
			acceptanceRows, acceptanceErr := tx.Query(ctx, `SELECT target_id, actor_user_id, created_at
				FROM audit_logs
				WHERE space_id = $1 AND action = 'invite.accept' AND target_type = 'invite'
					AND result = 'success' AND actor_user_id IS NOT NULL AND target_id = ANY($2::text[])
				ORDER BY created_at DESC`, spaceID, inviteIDs)
			if acceptanceErr != nil {
				return RepositorySnapshot{}, acceptanceErr
			}
			seen := make(map[string]map[string]struct{}, len(inviteIDs))
			for acceptanceRows.Next() {
				var inviteID string
				var acceptance InviteAcceptance
				if scanErr := acceptanceRows.Scan(&inviteID, &acceptance.UserID, &acceptance.AcceptedAt); scanErr != nil {
					acceptanceRows.Close()
					return RepositorySnapshot{}, scanErr
				}
				invite := byID[inviteID]
				if invite == nil || strings.TrimSpace(acceptance.UserID) == "" {
					continue
				}
				if seen[inviteID] == nil {
					seen[inviteID] = make(map[string]struct{})
				}
				if _, duplicate := seen[inviteID][acceptance.UserID]; duplicate {
					continue
				}
				seen[inviteID][acceptance.UserID] = struct{}{}
				acceptance.AcceptedAt = acceptance.AcceptedAt.UTC()
				invite.Acceptances = append(invite.Acceptances, acceptance)
			}
			if acceptanceRows.Err() != nil {
				acceptanceRows.Close()
				return RepositorySnapshot{}, acceptanceRows.Err()
			}
			acceptanceRows.Close()
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return RepositorySnapshot{}, err
	}
	return result, nil
}

func normalizeInviteTimes(invite *InviteRecord) {
	invite.CreatedAt = invite.CreatedAt.UTC()
	if invite.ExpiresAt != nil {
		value := invite.ExpiresAt.UTC()
		invite.ExpiresAt = &value
	}
	if invite.RevokedAt != nil {
		value := invite.RevokedAt.UTC()
		invite.RevokedAt = &value
	}
}

var _ Repository = (*PGRepository)(nil)
