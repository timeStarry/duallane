package messagejobs

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/email"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/ntfy"
)

func TestSchedulerFailsClosedWhenNotConfigured(t *testing.T) {
	err := (*Scheduler)(nil).ScheduleMessageInTx(context.Background(), nil, Input{})
	if err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("missing scheduler error = %v", err)
	}
}

func TestSchedulerRejectsMissingPostgresTransaction(t *testing.T) {
	scheduler := &Scheduler{
		emailService: &email.Service{}, emailRepository: &email.PGRepository{},
		ntfyService: &ntfy.Service{}, ntfyRepository: &ntfy.PGRepository{},
	}
	err := scheduler.ScheduleMessageInTx(context.Background(), nil, Input{
		AuthorID: "author", ConversationID: "conversation", MessageID: "message",
		EventSeq: 1, CreatedAt: time.Now(),
	})
	if err == nil || !strings.Contains(err.Error(), "postgres transaction is required") {
		t.Fatalf("missing transaction error = %v", err)
	}
}
