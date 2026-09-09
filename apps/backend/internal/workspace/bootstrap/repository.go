package bootstrap

import (
	"context"
	"time"
)

type Repository interface {
	Load(context.Context, string, string, time.Time) (RepositorySnapshot, error)
}
