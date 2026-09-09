package overview

import (
	"context"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type Repository interface {
	WithTx(context.Context, func(Tx) error) error
}

type Tx interface {
	LookupActor(context.Context, string, string) (*auth.Actor, error)
	ReadStatistics(context.Context, string, time.Time) (StatisticsRecord, error)
	WriteAudit(context.Context, AuditInput) error
}
