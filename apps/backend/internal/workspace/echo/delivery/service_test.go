package delivery

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/requirements"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/solicitations"
)

func TestDeliveryWriterFailureRollsBackDomainWritesBeforeFailureAudit(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	repo := newDeliveryFakeRepository(now)
	writer := &fakeEchoWriter{err: errors.New("card domain rejected")}
	service := NewService(ServiceOptions{
		Repository:            repo,
		SpaceID:               "spc_echo_test",
		Now:                   func() time.Time { return now },
		Writer:                writer,
		SolicitationProjector: fakeSolicitationProjector{},
		RetryDelays:           []time.Duration{time.Minute},
		MaxAttempts:           2,
	})

	result, err := service.SyncSolicitation(context.Background(), SyncInput{PublicID: "SOL-2026-0001"})
	if err != nil {
		t.Fatalf("sync solicitation: %v", err)
	}
	if result.Failed != 1 || result.Results[0].ErrorCode != "echo.delivery_failed" {
		t.Fatalf("unexpected failure result: %+v", result)
	}
	if repo.domainWrites != 0 {
		t.Fatalf("domain writes survived rejected writer: %d", repo.domainWrites)
	}
	if repo.card != nil {
		t.Fatal("card survived rejected writer")
	}
	if repo.solicitation.Status != DeliveryFailed || repo.solicitation.AttemptCount != 1 {
		t.Fatalf("failure state = %+v", repo.solicitation)
	}
	if len(repo.audits) != 1 || repo.audits[0].Result != "failure" {
		t.Fatalf("failure audit = %+v", repo.audits)
	}
	if repo.rollbacks != 1 || repo.commits != 1 {
		t.Fatalf("transaction counts = commits:%d rollbacks:%d", repo.commits, repo.rollbacks)
	}
}

func TestConcurrentSolicitationSyncUsesOneAtomicWriter(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	repo := newDeliveryFakeRepository(now)
	writer := &fakeEchoWriter{}
	service := NewService(ServiceOptions{
		Repository:            repo,
		SpaceID:               "spc_echo_test",
		Now:                   func() time.Time { return now },
		Writer:                writer,
		SolicitationProjector: fakeSolicitationProjector{},
	})

	start := make(chan struct{})
	results := make(chan DeliverySummary, 2)
	errorsCh := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			value, err := service.SyncSolicitation(context.Background(), SyncInput{PublicID: "SOL-2026-0001"})
			results <- value
			errorsCh <- err
		}()
	}
	close(start)
	for i := 0; i < 2; i++ {
		if err := <-errorsCh; err != nil {
			t.Fatalf("concurrent sync: %v", err)
		}
	}
	var sent, replayed int
	for i := 0; i < 2; i++ {
		value := <-results
		if value.Sent != 1 || len(value.Results) != 1 {
			t.Fatalf("unexpected concurrent result: %+v", value)
		}
		if value.Results[0].Replayed {
			replayed++
		} else {
			sent++
		}
	}
	if sent != 1 || replayed != 1 {
		t.Fatalf("sent/replayed = %d/%d", sent, replayed)
	}
	if got := writer.calls.Load(); got != 1 {
		t.Fatalf("writer calls = %d, want 1", got)
	}
	if repo.solicitation.Status != DeliverySent || repo.solicitation.AttemptCount != 1 {
		t.Fatalf("delivery row = %+v", repo.solicitation)
	}
}

func TestFailedDeliveryWaitsForBoundedRetryDelay(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	repo := newDeliveryFakeRepository(now)
	repo.solicitation.Status = DeliveryFailed
	repo.solicitation.AttemptCount = 1
	repo.solicitation.LastErrorCode = stringPointer("echo.identity_unavailable")
	repo.solicitation.UpdatedAt = now
	writer := &fakeEchoWriter{}
	service := NewService(ServiceOptions{
		Repository:            repo,
		SpaceID:               "spc_echo_test",
		Now:                   func() time.Time { return now },
		Writer:                writer,
		SolicitationProjector: fakeSolicitationProjector{},
		RetryDelays:           []time.Duration{time.Minute},
		MaxAttempts:           2,
	})

	value, err := service.SyncSolicitation(context.Background(), SyncInput{PublicID: "SOL-2026-0001"})
	if err != nil {
		t.Fatalf("pending retry sync: %v", err)
	}
	if value.Failed != 1 || value.Results[0].ErrorCode != "echo.identity_unavailable" {
		t.Fatalf("pending retry result: %+v", value)
	}
	if got := writer.calls.Load(); got != 0 {
		t.Fatalf("writer called before retry due: %d", got)
	}

	repo.solicitation.UpdatedAt = now.Add(-time.Minute - time.Millisecond)
	value, err = service.SyncSolicitation(context.Background(), SyncInput{PublicID: "SOL-2026-0001"})
	if err != nil {
		t.Fatalf("due retry sync: %v", err)
	}
	if value.Sent != 1 || writer.calls.Load() != 1 {
		t.Fatalf("due retry result: %+v calls=%d", value, writer.calls.Load())
	}
}

func TestRequirementWriterFailureDoesNotCommitPrivateCard(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	repo := newDeliveryFakeRepository(now)
	repo.requirement = &RequirementRecord{ID: "req-internal", PublicID: "REQ-2026-0001", SpaceID: "spc_echo_test", SubmitterUserID: "usr_member", Revision: 1, UpdatedAt: now}
	writer := &fakeEchoWriter{err: errors.New("message rejected")}
	service := NewService(ServiceOptions{
		Repository:           repo,
		SpaceID:              "spc_echo_test",
		Now:                  func() time.Time { return now },
		Writer:               writer,
		RequirementProjector: fakeRequirementProjector{},
	})

	value, err := service.SyncRequirement(context.Background(), SyncInput{PublicID: "REQ-2026-0001"})
	if err != nil {
		t.Fatalf("sync requirement: %v", err)
	}
	if value.Failed != 1 || repo.domainWrites != 0 || len(repo.audits) != 1 {
		t.Fatalf("requirement rollback result=%+v writes=%d audits=%d", value, repo.domainWrites, len(repo.audits))
	}
}

func TestIdentityUnavailableStillCommitsContentFreeFailureAudit(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	repo := newDeliveryFakeRepository(now)
	repo.echoActive = false
	service := NewService(ServiceOptions{
		Repository:            repo,
		SpaceID:               "spc_echo_test",
		Now:                   func() time.Time { return now },
		Writer:                &fakeEchoWriter{},
		SolicitationProjector: fakeSolicitationProjector{},
	})

	value, err := service.SyncSolicitation(context.Background(), SyncInput{PublicID: "SOL-2026-0001"})
	if err != nil {
		t.Fatalf("sync with unavailable identity: %v", err)
	}
	if value.Failed != 1 || value.Results[0].ErrorCode != "echo.identity_unavailable" {
		t.Fatalf("unexpected result: %+v", value)
	}
	if len(repo.audits) != 1 || repo.audits[0].ActorUserID != "" || repo.audits[0].Reason != "echo.identity_unavailable" {
		t.Fatalf("identity-unavailable audit = %+v", repo.audits)
	}
	if len(repo.events) != 1 || repo.events[0].ActorID != "" {
		t.Fatalf("identity-unavailable event = %+v", repo.events)
	}
}

func TestNormalizeProjectionRejectsCrossDomainCardType(t *testing.T) {
	_, err := normalizeProjection(Projection{Block: CardBlock{
		Type: "card", CardID: "card-echo-cross-domain", CardType: CardTypeStatus,
		SchemaVersion: CardSchemaVersion, FallbackText: "回声征集 SOL-2026-0001",
	}}, "SOL-2026-0001", DeliveryTypeSolicitation)
	var deliveryErr *Error
	if !errors.As(err, &deliveryErr) || deliveryErr.Code != "echo.card_projection_invalid" {
		t.Fatalf("cross-domain projection error = %v", err)
	}
}

func TestReleaseUsesImmutablePublicationIDAndRecipientScopedCardID(t *testing.T) {
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	repo := newDeliveryFakeRepository(now)
	repo.release = &ReleaseDelivery{
		ID: "echo-release-delivery-1", SpaceID: "spc_echo_test", PublicationID: "echo-publication-1",
		Version: "1.2.3", RecipientUserID: "usr_member", Status: DeliveryPending,
		CreatedAt: now, UpdatedAt: now, PublishedAt: now,
	}
	projector := &fakeReleaseProjector{}
	service := NewService(ServiceOptions{
		Repository:       repo,
		SpaceID:          "spc_echo_test",
		Now:              func() time.Time { return now },
		Writer:           &fakeEchoWriter{},
		ReleaseProjector: projector,
	})

	value, err := service.SyncRelease(context.Background(), SyncInput{Version: "V1.2.3"})
	if err != nil {
		t.Fatalf("sync release: %v", err)
	}
	if value.Sent != 1 || projector.input.PublicationID != "echo-publication-1" || projector.input.Version != "1.2.3" {
		t.Fatalf("release projection = %+v summary=%+v", projector.input, value)
	}
	wantCardID := "card_echo_" + stableToken("release:echo-publication-1:usr_member")
	if repo.card == nil || repo.card.ID != wantCardID {
		t.Fatalf("release card = %+v, want ID %s", repo.card, wantCardID)
	}
}

type fakeEchoWriter struct {
	err   error
	calls atomic.Int32
}

func (w *fakeEchoWriter) WriteEchoCardAndMessageInTx(_ context.Context, tx Tx, input CardMessageWriteInput) (CardMessageWriteResult, error) {
	w.calls.Add(1)
	fake := tx.(*fakeDeliveryTx)
	fake.repo.domainWrites++
	if w.err != nil {
		return CardMessageWriteResult{}, w.err
	}
	payload, _ := json.Marshal(input.Payload)
	fake.repo.card = &ExistingCard{ID: input.CardID, CardType: input.CardType, Revision: input.DomainRevision, Status: "active", PayloadJSON: payload}
	return CardMessageWriteResult{CardID: input.CardID, MessageID: "msg-echo-test", CardRevision: input.DomainRevision}, nil
}

type fakeSolicitationProjector struct{}

func (fakeSolicitationProjector) ProjectCard(context.Context, solicitations.GetInput) (*solicitations.CardProjection, error) {
	return &solicitations.CardProjection{
		Block:   solicitations.CardBlock{Type: "card", CardID: "card-echo-sol", CardType: solicitations.CardType, SchemaVersion: 1, FallbackText: "回声征集 SOL-2026-0001"},
		Payload: map[string]any{"publicId": "SOL-2026-0001", "revision": int64(1), "title": "synthetic"},
	}, nil
}

type fakeRequirementProjector struct{}

func (fakeRequirementProjector) ProjectCard(context.Context, requirements.GetInput) (*requirements.CardProjection, error) {
	return &requirements.CardProjection{
		Block:   requirements.CardBlock{Type: "card", CardID: "card-echo-req", CardType: requirements.CardTypeRequirementStatus, SchemaVersion: 1, FallbackText: "private body must not be fallback"},
		Payload: map[string]any{"publicId": "REQ-2026-0001", "revision": int64(1), "detail": "synthetic private detail"},
	}, nil
}

type fakeDeliveryState struct {
	solicitation *SolicitationDelivery
	source       *SolicitationDelivery
	requirement  *RequirementRecord
	release      *ReleaseDelivery
	active       map[string]bool
	owners       []string
	echoActive   bool
	card         *ExistingCard
	audits       []AuditInput
	events       []EventInput
	domainWrites int
	commits      int
	rollbacks    int
	mu           sync.Mutex
}

type fakeDeliverySnapshot struct {
	solicitation *SolicitationDelivery
	source       *SolicitationDelivery
	requirement  *RequirementRecord
	release      *ReleaseDelivery
	active       map[string]bool
	card         *ExistingCard
	audits       []AuditInput
	events       []EventInput
	domainWrites int
}

func newDeliveryFakeRepository(now time.Time) *fakeDeliveryState {
	row := &SolicitationDelivery{
		ID: "echo-sol-delivery-1", SpaceID: "spc_echo_test", SolicitationID: "sol-internal",
		PublicID: "SOL-2026-0001", RecipientUserID: "usr_member", Status: DeliveryPending,
		AttemptCount: 0, CreatedAt: now, UpdatedAt: now, SolicitationStatus: solicitations.StatusOpen,
		DeliveryPolicy: solicitations.DeliveryPolicyAllActiveMembers, Revision: 1, SolicitationUpdatedAt: now,
	}
	source := *row
	return &fakeDeliveryState{solicitation: row, source: &source, active: map[string]bool{"usr_member": true}, echoActive: true}
}

func (r *fakeDeliveryState) WithTx(_ context.Context, fn func(Tx) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	snapshot := r.snapshot()
	err := fn(&fakeDeliveryTx{repo: r})
	if err != nil {
		r.restore(snapshot)
		r.rollbacks++
		return err
	}
	r.commits++
	return nil
}

func (r *fakeDeliveryState) snapshot() fakeDeliverySnapshot {
	copyState := fakeDeliverySnapshot{domainWrites: r.domainWrites}
	if r.solicitation != nil {
		row := *r.solicitation
		copyState.solicitation = &row
	}
	if r.source != nil {
		row := *r.source
		copyState.source = &row
	}
	if r.requirement != nil {
		row := *r.requirement
		copyState.requirement = &row
	}
	if r.release != nil {
		row := *r.release
		copyState.release = &row
	}
	if r.card != nil {
		card := *r.card
		card.PayloadJSON = append([]byte(nil), r.card.PayloadJSON...)
		copyState.card = &card
	}
	copyState.active = map[string]bool{}
	for key, value := range r.active {
		copyState.active[key] = value
	}
	copyState.audits = append([]AuditInput(nil), r.audits...)
	copyState.events = append([]EventInput(nil), r.events...)
	return copyState
}

func (r *fakeDeliveryState) restore(snapshot fakeDeliverySnapshot) {
	r.solicitation, r.source, r.requirement, r.release, r.card = snapshot.solicitation, snapshot.source, snapshot.requirement, snapshot.release, snapshot.card
	r.active, r.audits, r.events = snapshot.active, snapshot.audits, snapshot.events
	r.domainWrites = snapshot.domainWrites
}

func (r *fakeDeliveryState) GetSolicitation(context.Context, string, string) (*SolicitationDelivery, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return cloneSolicitation(r.source), nil
}
func (r *fakeDeliveryState) GetSolicitationByID(context.Context, string, string) (*SolicitationDelivery, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return cloneSolicitation(r.source), nil
}
func (r *fakeDeliveryState) ListSolicitationDeliveries(context.Context, string, string, string, int) ([]SolicitationDelivery, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.solicitation == nil {
		return nil, nil
	}
	return []SolicitationDelivery{*cloneSolicitation(r.solicitation)}, nil
}
func (r *fakeDeliveryState) ListSolicitationWork(context.Context, string, string, int) ([]SolicitationDelivery, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.solicitation == nil {
		return nil, nil
	}
	return []SolicitationDelivery{*cloneSolicitation(r.solicitation)}, nil
}
func (r *fakeDeliveryState) EnsureSolicitationDeliveryRows(context.Context, string, string, time.Time) error {
	return nil
}
func (r *fakeDeliveryState) EnsureSolicitationDeliveryRowsForMember(context.Context, string, string, time.Time) error {
	return nil
}
func (r *fakeDeliveryState) GetRequirement(context.Context, string, string) (*RequirementRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.requirement == nil {
		return nil, nil
	}
	value := *r.requirement
	return &value, nil
}
func (r *fakeDeliveryState) ListRequirementsForRecovery(context.Context, string, string, int) ([]RequirementRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.requirement == nil {
		return nil, nil
	}
	return []RequirementRecord{*r.requirement}, nil
}
func (r *fakeDeliveryState) ListRequirementsForMember(context.Context, string, string, bool, int) ([]RequirementRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.requirement == nil {
		return nil, nil
	}
	return []RequirementRecord{*r.requirement}, nil
}
func (r *fakeDeliveryState) GetReleaseDelivery(context.Context, string, string) (*ReleaseDelivery, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return cloneRelease(r.release), nil
}
func (r *fakeDeliveryState) ListReleaseDeliveries(_ context.Context, spaceID, version, recipientID string, _ int) ([]ReleaseDelivery, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.release == nil || r.release.SpaceID != spaceID || (version != "" && r.release.Version != version) || (recipientID != "" && r.release.RecipientUserID != recipientID) {
		return nil, nil
	}
	return []ReleaseDelivery{*cloneRelease(r.release)}, nil
}
func (r *fakeDeliveryState) ListReleaseWork(_ context.Context, spaceID, _ string, _ int) ([]ReleaseDelivery, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.release == nil || r.release.SpaceID != spaceID {
		return nil, nil
	}
	return []ReleaseDelivery{*cloneRelease(r.release)}, nil
}
func (r *fakeDeliveryState) IsActiveHumanMember(_ context.Context, _, userID string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.active[userID], nil
}
func (r *fakeDeliveryState) ListActiveHumanMembers(context.Context, string) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return []string{"usr_member"}, nil
}
func (r *fakeDeliveryState) ListActiveOwners(context.Context, string) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.owners...), nil
}
func (r *fakeDeliveryState) FindCard(context.Context, string, string, string) (*ExistingCard, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.card == nil {
		return nil, nil
	}
	value := *r.card
	value.PayloadJSON = append([]byte(nil), r.card.PayloadJSON...)
	return &value, nil
}

type fakeDeliveryTx struct{ repo *fakeDeliveryState }

func (tx *fakeDeliveryTx) ClaimSolicitationDelivery(context.Context, string, string) (*SolicitationDelivery, bool, error) {
	return cloneSolicitation(tx.repo.solicitation), tx.repo.solicitation != nil, nil
}
func (tx *fakeDeliveryTx) ClaimReleaseDelivery(context.Context, string, string) (*ReleaseDelivery, bool, error) {
	return cloneRelease(tx.repo.release), tx.repo.release != nil, nil
}
func (tx *fakeDeliveryTx) GetSolicitation(context.Context, string, string) (*SolicitationDelivery, error) {
	return cloneSolicitation(tx.repo.source), nil
}
func (tx *fakeDeliveryTx) GetRequirement(context.Context, string, string) (*RequirementRecord, error) {
	if tx.repo.requirement == nil {
		return nil, nil
	}
	value := *tx.repo.requirement
	return &value, nil
}
func (tx *fakeDeliveryTx) FindCard(context.Context, string, string, string) (*ExistingCard, error) {
	if tx.repo.card == nil {
		return nil, nil
	}
	value := *tx.repo.card
	value.PayloadJSON = append([]byte(nil), tx.repo.card.PayloadJSON...)
	return &value, nil
}
func (tx *fakeDeliveryTx) IsActiveHumanMember(_ context.Context, _, userID string) (bool, error) {
	return tx.repo.active[userID], nil
}
func (tx *fakeDeliveryTx) RequirementRecipientAuthorized(_ context.Context, _, userID, submitterID, cardType string) (bool, error) {
	return tx.repo.active[userID] && (cardType == CardTypeRequest || cardType == CardTypeStatus) && (userID == "usr_owner" || userID == submitterID), nil
}
func (tx *fakeDeliveryTx) ListActiveHumanMembers(context.Context, string) ([]string, error) {
	return []string{"usr_member"}, nil
}
func (tx *fakeDeliveryTx) EchoIdentityActive(context.Context, string) (bool, error) {
	return tx.repo.echoActive, nil
}
func (tx *fakeDeliveryTx) EnsureEchoDirectConversation(_ context.Context, spaceID, recipientID, _ string, _ time.Time) (*DirectConversation, error) {
	return &DirectConversation{ID: "conv_echo_member", SpaceID: spaceID, Type: "direct"}, nil
}
func (tx *fakeDeliveryTx) MarkSolicitationDelivery(_ context.Context, _, deliveryID, status, errorCode string, at time.Time) error {
	if tx.repo.solicitation == nil || tx.repo.solicitation.ID != deliveryID {
		return errors.New("delivery missing")
	}
	tx.repo.solicitation.Status, tx.repo.solicitation.LastErrorCode, tx.repo.solicitation.UpdatedAt = status, stringPointer(errorCode), at
	tx.repo.solicitation.AttemptCount++
	if status == DeliverySent && tx.repo.solicitation.DeliveredAt == nil {
		tx.repo.solicitation.DeliveredAt = timePointer(at)
	}
	return nil
}
func (tx *fakeDeliveryTx) MarkReleaseDelivery(_ context.Context, _, deliveryID, status, errorCode string, at time.Time) error {
	if tx.repo.release == nil || tx.repo.release.ID != deliveryID {
		return errors.New("release delivery missing")
	}
	tx.repo.release.Status, tx.repo.release.LastErrorCode, tx.repo.release.UpdatedAt = status, stringPointer(errorCode), at
	tx.repo.release.AttemptCount++
	if status == DeliverySent && tx.repo.release.DeliveredAt == nil {
		tx.repo.release.DeliveredAt = timePointer(at)
	}
	return nil
}
func (tx *fakeDeliveryTx) Lock(context.Context, string) error { return nil }
func (tx *fakeDeliveryTx) WriteAudit(_ context.Context, input AuditInput) error {
	tx.repo.audits = append(tx.repo.audits, input)
	return nil
}
func (tx *fakeDeliveryTx) WriteEvent(_ context.Context, input EventInput) error {
	tx.repo.events = append(tx.repo.events, input)
	return nil
}

func cloneSolicitation(value *SolicitationDelivery) *SolicitationDelivery {
	if value == nil {
		return nil
	}
	copy := *value
	if value.LastErrorCode != nil {
		copy.LastErrorCode = stringPointer(*value.LastErrorCode)
	}
	if value.DeliveredAt != nil {
		copy.DeliveredAt = timePointer(*value.DeliveredAt)
	}
	return &copy
}
func cloneRelease(value *ReleaseDelivery) *ReleaseDelivery {
	if value == nil {
		return nil
	}
	copy := *value
	if value.LastErrorCode != nil {
		copy.LastErrorCode = stringPointer(*value.LastErrorCode)
	}
	if value.DeliveredAt != nil {
		copy.DeliveredAt = timePointer(*value.DeliveredAt)
	}
	return &copy
}
func stringPointer(value string) *string     { return &value }
func timePointer(value time.Time) *time.Time { return &value }

var _ Repository = (*fakeDeliveryState)(nil)
var _ Tx = (*fakeDeliveryTx)(nil)
var _ EchoWriter = (*fakeEchoWriter)(nil)
var _ SolicitationProjector = fakeSolicitationProjector{}
var _ RequirementProjector = fakeRequirementProjector{}
var _ ReleaseProjector = (*fakeReleaseProjector)(nil)
var _ = auth.RequestMeta{}

type fakeReleaseProjector struct{ input ReleaseProjectInput }

func (p *fakeReleaseProjector) ProjectCard(_ context.Context, input ReleaseProjectInput) (*ReleaseProjection, error) {
	p.input = input
	return &ReleaseProjection{Block: CardBlock{Type: "card", CardID: "domain-release", CardType: CardTypeRelease, SchemaVersion: CardSchemaVersion, FallbackText: "DualLane v1.2.3 版本更新"}, Payload: map[string]any{"version": input.Version}}, nil
}
