package cards

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

func (t *pgTx) UpdateEchoCardRevision(ctx context.Context, cardID string, expectedRevision, nextRevision int64, payload any, fallback string, at time.Time) (*CardRecord, bool, error) {
	if nextRevision <= expectedRevision || nextRevision > 9007199254740991 {
		return nil, false, errors.New("invalid Echo card revision")
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, false, err
	}
	updated, err := scanCard(t.tx.QueryRow(ctx, `
UPDATE workspace_cards
SET payload_json=$1, fallback_text=$2, revision=$3, status='active', updated_at=$4
WHERE id=$5 AND revision=$6 AND source_kind='echo' AND created_by_user_id='usr_system_echo'
RETURNING id, space_id, conversation_id, card_type, schema_version, payload_json,
 fallback_text, source_kind, source_id, resource_type, resource_id, visibility_scope,
 created_by_user_id, status, revision, expires_at, created_at, updated_at`, string(encoded), fallback, nextRevision, at.UTC(), cardID, expectedRevision))
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && updated == nil) {
		return nil, false, nil
	}
	return updated, updated != nil && err == nil, err
}

var _ EchoCardRevisionTx = (*pgTx)(nil)
