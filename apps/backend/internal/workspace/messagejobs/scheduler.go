package messagejobs

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/email"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/ntfy"
)

// Input is transient scheduling context. ContentJSON is inspected only to
// enforce mention preferences and is never copied into a delivery job row.
type Input struct {
	AuthorID       string
	SpaceID        string
	ConversationID string
	TopicID        string
	MessageID      string
	EventSeq       int64
	ContentJSON    []byte
	CreatedAt      time.Time
}

// PGScheduler joins delivery projections to a caller-owned PostgreSQL
// transaction. Implementations must not perform provider I/O.
type PGScheduler interface {
	ScheduleMessageInTx(context.Context, pgx.Tx, Input) error
}

type Scheduler struct {
	emailService    *email.Service
	emailRepository *email.PGRepository
	ntfyService     *ntfy.Service
	ntfyRepository  *ntfy.PGRepository
}

func NewScheduler(emailService *email.Service, emailRepository *email.PGRepository, ntfyService *ntfy.Service, ntfyRepository *ntfy.PGRepository) *Scheduler {
	return &Scheduler{
		emailService: emailService, emailRepository: emailRepository,
		ntfyService: ntfyService, ntfyRepository: ntfyRepository,
	}
}

func (s *Scheduler) ScheduleMessageInTx(ctx context.Context, tx pgx.Tx, input Input) error {
	if s == nil || s.emailService == nil || s.emailRepository == nil || s.ntfyService == nil || s.ntfyRepository == nil {
		return errors.New("workspace message job scheduler is not configured")
	}
	if tx == nil {
		return errors.New("workspace message job postgres transaction is required")
	}
	if strings.TrimSpace(input.AuthorID) == "" || strings.TrimSpace(input.ConversationID) == "" || strings.TrimSpace(input.MessageID) == "" || input.EventSeq <= 0 || input.CreatedAt.IsZero() {
		return errors.New("workspace message job input is incomplete")
	}
	emailTx := s.emailRepository.BindTx(tx)
	if emailTx == nil {
		return errors.New("bind workspace email transaction")
	}
	if _, err := s.emailService.ScheduleMessageInTx(ctx, emailTx, email.ScheduleInput{
		AuthorID: input.AuthorID, SpaceID: input.SpaceID, ConversationID: input.ConversationID,
		TopicID: input.TopicID, MessageID: input.MessageID, EventSeq: input.EventSeq,
		ContentJSON: append([]byte(nil), input.ContentJSON...), CreatedAt: input.CreatedAt,
	}); err != nil {
		return err
	}
	ntfyTx, err := s.ntfyRepository.BindTx(tx)
	if err != nil {
		return err
	}
	_, err = s.ntfyService.ScheduleMessageInTx(ctx, ntfyTx, ntfy.ScheduleInput{
		AuthorID: input.AuthorID, SpaceID: input.SpaceID, ConversationID: input.ConversationID,
		TopicID: input.TopicID, MessageID: input.MessageID, EventSeq: input.EventSeq,
		ContentJSON: append([]byte(nil), input.ContentJSON...), CreatedAt: input.CreatedAt,
	})
	return err
}
