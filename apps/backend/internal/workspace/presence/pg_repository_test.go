package presence

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPGSweepRejectsInvalidBudgetBeforeQuery(t *testing.T) {
	// An uninitialized pool must never be reached for an invalid batch budget.
	repository := NewPGRepository(&pgxpool.Pool{})
	for _, limit := range []int{-1, 0, MaximumSweepBatch + 1, int(^uint(0) >> 1)} {
		count, err := repository.SweepExpired(context.Background(), SweepInput{Now: time.Now(), Limit: limit})
		if count != 0 || !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("limit=%d: count=%d err=%v, want zero/invalid input", limit, count, err)
		}
	}
}

func TestPGTimePreservesInstantAndValidity(t *testing.T) {
	if pgTime(time.Time{}).Valid {
		t.Fatal("zero time must remain invalid")
	}
	input := time.Date(2026, 9, 6, 18, 30, 0, 123000, time.FixedZone("test", 8*60*60))
	got := pgTime(input)
	if !got.Valid || !got.Time.Equal(input) || got.Time.Location() != time.UTC {
		t.Fatalf("converted time=%v, want the same UTC instant", got)
	}
}
