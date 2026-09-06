package cards

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type ConversationRecord struct {
	ID      string
	SpaceID string
	Type    string
}

type ReadRepository interface {
	LookupActor(context.Context, string, string) (*auth.Actor, error)
	SpaceExists(context.Context, string) (bool, error)
	GetConversation(context.Context, string, string) (*ConversationRecord, error)
	ConversationMemberActive(context.Context, string, string, string) (bool, error)
	GetCard(context.Context, string, string) (*CardRecord, error)
	GetCardBySource(context.Context, string, SourceKind, string, string) (*CardRecord, error)
	GetActionRun(context.Context, string, string, string) (*ActionRunRecord, error)
}

type Repository interface {
	ReadRepository
	WithTx(context.Context, func(Tx) error) error
}

type CustomBotAuthorizer interface {
	CustomBotActive(context.Context, string, string, string) (bool, error)
}

// ActionSavepoint is the typed subtransaction boundary for card actions.
// Implementations must run the callback on the caller's existing transaction;
// they must never acquire a second pool connection or commit independently.
// The callback error is returned after its writes are rolled back to the
// savepoint, while SAVEPOINT/ROLLBACK/RELEASE failures remain infrastructure
// errors for the outer transaction.
type ActionSavepoint interface {
	WithActionSavepoint(context.Context, string, func(context.Context) error) error
}

// actionSavepointFailure marks a SAVEPOINT/ROLLBACK/RELEASE failure. It is
// intentionally distinct from the callback's controlled rejection: callers
// must never commit a failed action when the database could not establish or
// unwind the subtransaction boundary.
type actionSavepointFailure struct{ err error }

func (e *actionSavepointFailure) Error() string {
	if e == nil || e.err == nil {
		return ""
	}
	return e.err.Error()
}

func (e *actionSavepointFailure) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.err
}

type Tx interface {
	ReadRepository
	ActionSavepoint
	Lock(context.Context, string) error
	InsertCard(context.Context, CardInsert) (*CardRecord, bool, error)
	UpdateCard(context.Context, string, int64, any, CardStatus, string, time.Time) (*CardRecord, bool, error)
	InsertActionRun(context.Context, ActionRunRecord) (*ActionRunRecord, bool, error)
	CompleteActionRun(context.Context, string, string, []byte, *int64, time.Time) error
	FailActionRun(context.Context, string, string, time.Time) error
	WriteEvent(context.Context, EventInput) (EventRecord, error)
	WriteAudit(context.Context, AuditInput) error
}

var _ Repository = (*PGRepository)(nil)
