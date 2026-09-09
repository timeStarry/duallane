package overview

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type fakeRepository struct {
	actor     *auth.Actor
	record    StatisticsRecord
	audits    []AuditInput
	readCalls int
	committed bool
}

func (repository *fakeRepository) WithTx(_ context.Context, callback func(Tx) error) error {
	err := callback((*fakeTx)(repository))
	if err == nil {
		repository.committed = true
	}
	return err
}

type fakeTx fakeRepository

func (tx *fakeTx) LookupActor(context.Context, string, string) (*auth.Actor, error) {
	if tx.actor == nil {
		return nil, nil
	}
	copy := *tx.actor
	return &copy, nil
}

func (tx *fakeTx) ReadStatistics(context.Context, string, time.Time) (StatisticsRecord, error) {
	tx.readCalls++
	return tx.record, nil
}

func (tx *fakeTx) WriteAudit(_ context.Context, input AuditInput) error {
	tx.audits = append(tx.audits, input)
	return nil
}

func TestStatisticsUsesConfiguredLocalDayBoundary(t *testing.T) {
	location := time.FixedZone("Asia/Shanghai", 8*60*60)
	now := time.Date(2026, 9, 4, 1, 2, 3, 456000000, location)
	repository := &fakeRepository{
		actor:  &auth.Actor{ID: "owner", GitHubLogin: "owner", Kind: "human", Role: "owner"},
		record: StatisticsRecord{Totals: Counts{Members: 4, UploadedBytes: 20}, Today: Counts{Members: 1, UploadedBytes: 5}},
	}
	service := NewService(ServiceOptions{Repository: repository, Now: func() time.Time { return now }, Location: location})
	result, err := service.GetStatistics(context.Background(), "owner", auth.RequestMeta{})
	if err != nil {
		t.Fatal(err)
	}
	if result.AsOf != "2026-09-03T17:02:03.456Z" || result.DayStartedAt != "2026-09-03T16:00:00.000Z" {
		t.Fatalf("timestamps = %#v", result)
	}
	if result.Totals.Members != 4 || result.Today.UploadedBytes != 5 || repository.readCalls != 1 || !repository.committed {
		t.Fatalf("statistics = %#v repository=%#v", result, repository)
	}
}

func TestStatisticsPermissionDenialCommitsContentFreeAudit(t *testing.T) {
	now := time.Date(2026, 9, 4, 1, 0, 0, 0, time.UTC)
	repository := &fakeRepository{actor: &auth.Actor{ID: "member", GitHubLogin: "member", Email: "private@example.com", Kind: "human", Role: "member"}}
	service := NewService(ServiceOptions{
		Repository: repository,
		Now:        func() time.Time { return now },
		Location:   time.UTC,
		IDFactory:  func() (string, error) { return "audit-1", nil },
	})
	_, err := service.GetStatistics(context.Background(), "member", auth.RequestMeta{RequestID: "request-1", IPAddress: "203.0.113.5:443", UserAgent: "test"})
	var domainErr *Error
	if !errors.As(err, &domainErr) || domainErr.Code != CodePermissionDenied || domainErr.StatusCode != 403 {
		t.Fatalf("error = %#v", err)
	}
	if !repository.committed || repository.readCalls != 0 || len(repository.audits) != 1 {
		t.Fatalf("rejection state = %#v", repository)
	}
	audit := repository.audits[0]
	if audit.Action != statisticsCapability || audit.Result != "rejected" || audit.Reason != "insufficient permission" || audit.RequestID != "request-1" || audit.IPAddress != "203.0.113.5" {
		t.Fatalf("audit = %#v", audit)
	}
	if audit.TargetID != DefaultSpaceID || audit.ActorUserID != "member" {
		t.Fatalf("audit identity = %#v", audit)
	}
}

func TestStatisticsAuditIDFailureRollsBackRejection(t *testing.T) {
	repository := &fakeRepository{actor: &auth.Actor{ID: "member", Kind: "human", Role: "member"}}
	service := NewService(ServiceOptions{Repository: repository, IDFactory: func() (string, error) { return "", errors.New("entropy unavailable") }})
	_, err := service.GetStatistics(context.Background(), "member", auth.RequestMeta{})
	var domainErr *Error
	if !errors.As(err, &domainErr) || domainErr.Code != CodeInternal || repository.committed {
		t.Fatalf("error=%#v committed=%t", err, repository.committed)
	}
}

var _ Repository = (*fakeRepository)(nil)
var _ Tx = (*fakeTx)(nil)
