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

type Tx interface {
	ReadRepository
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
