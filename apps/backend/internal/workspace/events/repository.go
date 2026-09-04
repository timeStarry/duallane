package events

import (
	"context"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

// Repository is the intentionally narrow durable-read boundary for realtime.
// Visibility is evaluated against the current actor and current rows for each
// candidate event; a previously visible event is never treated as a grant.
type Repository interface {
	LookupActor(ctx context.Context, spaceID, userID string) (*auth.Actor, error)
	CurrentSeq(ctx context.Context, spaceID string) (int64, error)
	EarliestSeq(ctx context.Context, spaceID string) (int64, error)
	ListEventsAfter(ctx context.Context, spaceID string, afterSeq int64, limit int) ([]EventRecord, error)
	EventVisible(ctx context.Context, actor *auth.Actor, event EventRecord, payload map[string]any) (bool, error)
}

// EventLookup is optional so a replay-only adapter can stay minimal. The PG
// adapter implements it for push/wakeup paths that receive only an event ID.
type EventLookup interface {
	GetEvent(ctx context.Context, spaceID, eventID string) (*EventRecord, error)
}

// PayloadProjector is optional for small adapters. The PostgreSQL adapter
// refreshes member/conversation/message/attachment references from current
// rows before the service applies its allowlist; replay-only fakes can rely on
// the payload already persisted by the accepting transaction.
type PayloadProjector interface {
	ProjectEventPayload(ctx context.Context, actor *auth.Actor, event EventRecord, payload map[string]any) (map[string]any, error)
}
