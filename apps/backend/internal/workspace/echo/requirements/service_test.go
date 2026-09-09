package requirements

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

type fakeState struct {
	actors       map[string]*auth.Actor
	requirements map[string]RequirementRecord
	history      []RequirementHistoryRecord
	idempotency  map[string]IdempotencyRecord
	sequences    map[string]int
	audits       []AuditInput
	events       []EventInput
	eventSeq     int64
}

type fakeRepository struct {
	mu    sync.Mutex
	state fakeState
}

func newFakeRepository() *fakeRepository {
	now := time.Date(2026, 8, 14, 0, 0, 0, 789000000, time.UTC)
	actors := map[string]*auth.Actor{}
	for _, actor := range []*auth.Actor{
		{ID: "usr_owner", GitHubLogin: "owner", DisplayName: "Owner", Kind: "human", Role: "owner", JoinedAt: now},
		{ID: "usr_member", GitHubLogin: "member", DisplayName: "Member", Kind: "human", Role: "member", JoinedAt: now},
		{ID: "usr_other", GitHubLogin: "other", DisplayName: "Other", Kind: "human", Role: "member", JoinedAt: now},
		{ID: "usr_admin", GitHubLogin: "admin", DisplayName: "Admin", Kind: "human", Role: "admin", JoinedAt: now},
		{ID: "usr_auditor", GitHubLogin: "auditor", DisplayName: "Auditor", Kind: "human", Role: "auditor", JoinedAt: now},
	} {
		actors[actorKey(DefaultSpaceID, actor.ID)] = actor
	}
	return &fakeRepository{state: fakeState{actors: actors, requirements: map[string]RequirementRecord{}, idempotency: map[string]IdempotencyRecord{}, sequences: map[string]int{}}}
}

func actorKey(spaceID, actorID string) string  { return spaceID + "\x00" + actorID }
func requirementKey(spaceID, id string) string { return spaceID + "\x00" + id }
func idempotencyKey(spaceID, actorID, operation, key string) string {
	return spaceID + "\x00" + actorID + "\x00" + operation + "\x00" + key
}
func sequenceKey(spaceID string, year int) string { return fmt.Sprintf("%s\x00%d", spaceID, year) }

func cloneFakeState(source fakeState) fakeState {
	result := fakeState{actors: map[string]*auth.Actor{}, requirements: map[string]RequirementRecord{}, history: append([]RequirementHistoryRecord(nil), source.history...), idempotency: map[string]IdempotencyRecord{}, sequences: map[string]int{}, audits: append([]AuditInput(nil), source.audits...), events: append([]EventInput(nil), source.events...), eventSeq: source.eventSeq}
	for key, actor := range source.actors {
		copy := *actor
		result.actors[key] = &copy
	}
	for key, record := range source.requirements {
		result.requirements[key] = cloneRequirementRecord(record)
	}
	for key, record := range source.idempotency {
		result.idempotency[key] = cloneIdempotency(record)
	}
	for key, number := range source.sequences {
		result.sequences[key] = number
	}
	return result
}

func cloneRequirementRecord(record RequirementRecord) RequirementRecord {
	record.RelatedLink = cloneStringPtr(record.RelatedLink)
	record.ArchiveOutcome = cloneStringPtr(record.ArchiveOutcome)
	record.DuplicateOfPublicID = cloneStringPtr(record.DuplicateOfPublicID)
	record.Response = cloneStringPtr(record.Response)
	return record
}

func cloneIdempotency(record IdempotencyRecord) IdempotencyRecord {
	record.ResultJSON = append([]byte(nil), record.ResultJSON...)
	return record
}

func (r *fakeRepository) LookupActor(_ context.Context, spaceID, userID string) (*auth.Actor, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	actor := r.state.actors[actorKey(spaceID, userID)]
	if actor == nil {
		return nil, nil
	}
	copy := *actor
	return &copy, nil
}

func (r *fakeRepository) GetRequirementByPublicID(_ context.Context, spaceID, publicID string) (*RequirementRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, record := range r.state.requirements {
		if record.SpaceID == spaceID && record.PublicID == publicID {
			copy := cloneRequirementRecord(record)
			return &copy, nil
		}
	}
	return nil, nil
}

func (r *fakeRepository) GetRequirementByID(_ context.Context, spaceID, id string) (*RequirementRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	record, ok := r.state.requirements[requirementKey(spaceID, id)]
	if !ok {
		return nil, nil
	}
	copy := cloneRequirementRecord(record)
	return &copy, nil
}

func (r *fakeRepository) ListRequirements(_ context.Context, query RequirementListQuery) (RequirementPageRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := RequirementPageRecord{Items: []RequirementRecord{}}
	for _, record := range r.state.requirements {
		if !matchesQuery(record, query) {
			continue
		}
		result.Items = append(result.Items, cloneRequirementRecord(record))
	}
	// The fake stores only a handful of rows; deterministic order mirrors the
	// production created_at/id descending query.
	for i := 0; i < len(result.Items); i++ {
		for j := i + 1; j < len(result.Items); j++ {
			left, right := result.Items[i], result.Items[j]
			if right.CreatedAt.After(left.CreatedAt) || right.CreatedAt.Equal(left.CreatedAt) && right.ID > left.ID {
				result.Items[i], result.Items[j] = result.Items[j], result.Items[i]
			}
		}
	}
	result.Total = int64(len(result.Items))
	start := query.Offset
	if start > len(result.Items) {
		start = len(result.Items)
	}
	end := start + query.Limit
	if end > len(result.Items) {
		end = len(result.Items)
	}
	result.Items = result.Items[start:end]
	return result, nil
}

func matchesQuery(record RequirementRecord, query RequirementListQuery) bool {
	if record.SpaceID != query.SpaceID || !query.Owner && record.SubmitterUserID != query.ActorID {
		return false
	}
	if query.State != nil && record.State != *query.State {
		return false
	}
	if query.Phase != nil && record.Phase != *query.Phase {
		return false
	}
	if query.Status != nil && record.Status != *query.Status {
		return false
	}
	if query.ArchiveOutcome != nil && (record.ArchiveOutcome == nil || *record.ArchiveOutcome != *query.ArchiveOutcome) {
		return false
	}
	if query.Type != nil && record.Type != *query.Type {
		return false
	}
	if query.SubmitterUserID != nil && record.SubmitterUserID != *query.SubmitterUserID {
		return false
	}
	if query.CreatedFrom != nil && record.CreatedAt.Before(*query.CreatedFrom) {
		return false
	}
	if query.CreatedTo != nil && record.CreatedAt.After(*query.CreatedTo) {
		return false
	}
	return true
}

func (r *fakeRepository) RequirementStats(_ context.Context, spaceID, actorID string, owner bool) ([]RequirementStatsRow, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	counts := map[string]RequirementStatsRow{}
	for _, record := range r.state.requirements {
		if record.SpaceID != spaceID || !owner && record.SubmitterUserID != actorID {
			continue
		}
		key := record.Phase + "\x00" + record.Status
		row := counts[key]
		row.Phase, row.Status, row.Count = record.Phase, record.Status, row.Count+1
		counts[key] = row
	}
	result := make([]RequirementStatsRow, 0, len(counts))
	for _, row := range counts {
		result = append(result, row)
	}
	return result, nil
}

func (r *fakeRepository) ListRequirementHistory(_ context.Context, spaceID, requirementID string) ([]RequirementHistoryRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]RequirementHistoryRecord, 0)
	for _, row := range r.state.history {
		if row.RequirementID == requirementID {
			result = append(result, row)
		}
	}
	return result, nil
}

func (r *fakeRepository) GetIdempotency(_ context.Context, spaceID, actorID, operation, key string) (*IdempotencyRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	record, ok := r.state.idempotency[idempotencyKey(spaceID, actorID, operation, key)]
	if !ok {
		return nil, nil
	}
	copy := cloneIdempotency(record)
	return &copy, nil
}

func (r *fakeRepository) WithTx(_ context.Context, callback func(Tx) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	working := cloneFakeState(r.state)
	tx := &fakeTx{state: &working}
	if err := callback(tx); err != nil {
		return err
	}
	r.state = working
	return nil
}

type fakeTx struct{ state *fakeState }

func (t *fakeTx) LookupActor(_ context.Context, spaceID, userID string) (*auth.Actor, error) {
	actor := t.state.actors[actorKey(spaceID, userID)]
	if actor == nil {
		return nil, nil
	}
	copy := *actor
	return &copy, nil
}
func (t *fakeTx) GetRequirementByPublicID(_ context.Context, spaceID, publicID string) (*RequirementRecord, error) {
	for _, record := range t.state.requirements {
		if record.SpaceID == spaceID && record.PublicID == publicID {
			copy := cloneRequirementRecord(record)
			return &copy, nil
		}
	}
	return nil, nil
}
func (t *fakeTx) GetRequirementByID(_ context.Context, spaceID, id string) (*RequirementRecord, error) {
	record, ok := t.state.requirements[requirementKey(spaceID, id)]
	if !ok {
		return nil, nil
	}
	copy := cloneRequirementRecord(record)
	return &copy, nil
}
func (t *fakeTx) ListRequirements(ctx context.Context, query RequirementListQuery) (RequirementPageRecord, error) {
	return listFromState(ctx, t.state, query)
}
func (t *fakeTx) RequirementStats(_ context.Context, spaceID, actorID string, owner bool) ([]RequirementStatsRow, error) {
	counts := map[string]RequirementStatsRow{}
	for _, record := range t.state.requirements {
		if record.SpaceID != spaceID || !owner && record.SubmitterUserID != actorID {
			continue
		}
		key := record.Phase + "\x00" + record.Status
		row := counts[key]
		row.Phase, row.Status, row.Count = record.Phase, record.Status, row.Count+1
		counts[key] = row
	}
	result := make([]RequirementStatsRow, 0, len(counts))
	for _, row := range counts {
		result = append(result, row)
	}
	return result, nil
}
func (t *fakeTx) ListRequirementHistory(_ context.Context, _ string, requirementID string) ([]RequirementHistoryRecord, error) {
	result := make([]RequirementHistoryRecord, 0)
	for _, row := range t.state.history {
		if row.RequirementID == requirementID {
			result = append(result, row)
		}
	}
	return result, nil
}
func (t *fakeTx) GetIdempotency(_ context.Context, spaceID, actorID, operation, key string) (*IdempotencyRecord, error) {
	record, ok := t.state.idempotency[idempotencyKey(spaceID, actorID, operation, key)]
	if !ok {
		return nil, nil
	}
	copy := cloneIdempotency(record)
	return &copy, nil
}
func (t *fakeTx) Lock(context.Context, string) error { return nil }
func (t *fakeTx) AllocateSequence(_ context.Context, spaceID string, year int) (int, error) {
	key := sequenceKey(spaceID, year)
	number := t.state.sequences[key]
	if number == 0 {
		number = 1
	}
	if number > MaxSequenceNumber {
		return 0, conflictError(CodeSequenceExhausted, MessageSequenceExhausted)
	}
	t.state.sequences[key] = number + 1
	return number, nil
}
func (t *fakeTx) InsertRequirement(_ context.Context, record RequirementRecord) error {
	if _, ok := t.state.requirements[requirementKey(record.SpaceID, record.ID)]; ok {
		return errors.New("duplicate requirement id")
	}
	t.state.requirements[requirementKey(record.SpaceID, record.ID)] = cloneRequirementRecord(record)
	return nil
}
func (t *fakeTx) InsertHistory(_ context.Context, record RequirementHistoryRecord) error {
	t.state.history = append(t.state.history, record)
	return nil
}
func (t *fakeTx) InsertIdempotency(_ context.Context, record IdempotencyRecord) (bool, error) {
	key := idempotencyKey(record.SpaceID, record.ActorUserID, record.Operation, record.Key)
	if _, ok := t.state.idempotency[key]; ok {
		return false, nil
	}
	t.state.idempotency[key] = cloneIdempotency(record)
	return true, nil
}
func (t *fakeTx) UpdateIdempotencyResult(_ context.Context, spaceID, actorID, operation, key string, resultJSON []byte) error {
	record, ok := t.state.idempotency[idempotencyKey(spaceID, actorID, operation, key)]
	if !ok {
		return errors.New("idempotency row missing")
	}
	record.ResultJSON = append([]byte(nil), resultJSON...)
	t.state.idempotency[idempotencyKey(spaceID, actorID, operation, key)] = record
	return nil
}
func (t *fakeTx) UpdateRequirementCAS(_ context.Context, id string, expectedRevision int64, record RequirementRecord) (bool, error) {
	key := requirementKey(record.SpaceID, id)
	current, ok := t.state.requirements[key]
	if !ok || current.Revision != expectedRevision {
		return false, nil
	}
	t.state.requirements[key] = cloneRequirementRecord(record)
	return true, nil
}
func (t *fakeTx) WriteAudit(_ context.Context, input AuditInput) error {
	t.state.audits = append(t.state.audits, input)
	return nil
}
func (t *fakeTx) WriteEvent(_ context.Context, input EventInput) (EventRecord, error) {
	t.state.eventSeq++
	t.state.events = append(t.state.events, input)
	return EventRecord{ID: input.ID, SpaceID: input.SpaceID, Seq: t.state.eventSeq}, nil
}

func listFromState(_ context.Context, state *fakeState, query RequirementListQuery) (RequirementPageRecord, error) {
	result := RequirementPageRecord{Items: []RequirementRecord{}}
	for _, record := range state.requirements {
		if matchesQuery(record, query) {
			result.Items = append(result.Items, cloneRequirementRecord(record))
		}
	}
	result.Total = int64(len(result.Items))
	start := query.Offset
	if start > len(result.Items) {
		start = len(result.Items)
	}
	end := start + query.Limit
	if end > len(result.Items) {
		end = len(result.Items)
	}
	result.Items = result.Items[start:end]
	return result, nil
}

func testService(repo *fakeRepository, now time.Time, factory IDFactory) *Service {
	return NewService(ServiceOptions{Repository: repo, Now: func() time.Time { return now }, IDFactory: factory})
}

func testSubmitInput(actorID, key string) SubmitInput {
	return SubmitInput{ActorID: actorID, Type: TypeRequirement, Title: "支持导出需求", Detail: "希望可以把需求导出成文件。", Scenario: "整理反馈时需要归档。", ExpectedResult: "可以下载结构化文件。", RelatedLink: "https://example.com/docs", IdempotencyKey: key}
}

func sequenceFactory() IDFactory {
	var count atomic.Int64
	return func() (string, error) { return fmt.Sprintf("id-%d", count.Add(1)), nil }
}

func TestSubmitReplayConflictAndProjection(t *testing.T) {
	repo := newFakeRepository()
	now := time.Date(2026, 8, 14, 0, 0, 0, 789654321, time.UTC)
	service := testService(repo, now, sequenceFactory())
	first, err := service.Submit(context.Background(), testSubmitInput("usr_member", "submit-1"))
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if first.PublicID != "REQ-2026-0001" || first.Revision != 1 || first.CreatedAt != "2026-08-14T00:00:00.789Z" {
		t.Fatalf("unexpected projection: %+v", first)
	}
	replay, err := service.Submit(context.Background(), testSubmitInput("usr_member", "submit-1"))
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !reflect.DeepEqual(replay, first) {
		t.Fatalf("replay changed result: got %+v want %+v", replay, first)
	}
	changed := testSubmitInput("usr_member", "submit-1")
	changed.Title = "不同标题"
	if _, err := service.Submit(context.Background(), changed); !hasCode(err, CodeIdempotencyConflict) {
		t.Fatalf("idempotency conflict: %v", err)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.state.requirements) != 1 || len(repo.state.history) != 1 || len(repo.state.events) != 1 || len(repo.state.audits) != 2 {
		t.Fatalf("atomic rows: requirements=%d history=%d events=%d audits=%d", len(repo.state.requirements), len(repo.state.history), len(repo.state.events), len(repo.state.audits))
	}
	encoded, _ := json.Marshal(repo.state.audits[0])
	if strings.Contains(string(encoded), "希望可以") {
		t.Fatal("audit contains private body")
	}
}

func TestPrivacyListHistoryStatsAndReadAudit(t *testing.T) {
	repo := newFakeRepository()
	service := testService(repo, time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC), sequenceFactory())
	created, err := service.Submit(context.Background(), testSubmitInput("usr_member", "private-1"))
	if err != nil {
		t.Fatal(err)
	}
	_, otherErr := service.Get(context.Background(), GetInput{ActorID: "usr_other", PublicID: created.PublicID})
	if !hasCode(otherErr, CodeRequirementNotFound) {
		t.Fatalf("other get (%T): %#v", otherErr, otherErr)
	}
	items, err := service.List(context.Background(), ListInput{ActorID: "usr_other"})
	if err != nil || len(items) != 0 {
		t.Fatalf("other list: items=%d err=%v", len(items), err)
	}
	history, err := service.History(context.Background(), HistoryInput{ActorID: "usr_member", PublicID: created.PublicID})
	if err != nil || len(history) != 1 || history[0].FromState != nil || history[0].ToState != StateSubmitted {
		t.Fatalf("history: %+v err=%v", history, err)
	}
	stats, err := service.Stats(context.Background(), StatsInput{ActorID: "usr_owner"})
	if err != nil || stats.Total != 1 || stats.ByPhase[PhaseProposal] != 1 || stats.ByStatus[StatusPendingReview] != 1 {
		t.Fatalf("stats: %+v err=%v", stats, err)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.state.audits) < 2 || repo.state.audits[len(repo.state.audits)-1].Reason != CodePermissionDenied {
		t.Fatalf("read audit: %+v", repo.state.audits)
	}
	for _, audit := range repo.state.audits {
		if audit.Reason == CodePermissionDenied && stringsContainsAny(audit.TargetID, "127.0.0.1", "javascript") {
			t.Fatal("unsafe target leaked")
		}
	}
}

func TestTransitionsCASIdempotencyAndTerminalStates(t *testing.T) {
	repo := newFakeRepository()
	service := testService(repo, time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC), sequenceFactory())
	created, err := service.Submit(context.Background(), testSubmitInput("usr_member", "transition-submit"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Transition(context.Background(), TransitionInput{ActorID: "usr_member", PublicID: created.PublicID, ToState: StateCollected, ExpectedRevision: 1, IdempotencyKey: "member-transition"}); !hasCode(err, CodeRequirementNotFound) {
		t.Fatalf("member transition: %v", err)
	}
	collected, err := service.Transition(context.Background(), TransitionInput{ActorID: "usr_owner", PublicID: created.PublicID, ToState: StateCollected, ExpectedRevision: 1, IdempotencyKey: "collect-1"})
	if err != nil || collected.State != StateCollected || collected.Revision != 2 {
		t.Fatalf("collect: %+v err=%v", collected, err)
	}
	replay, err := service.Transition(context.Background(), TransitionInput{ActorID: "usr_owner", PublicID: created.PublicID, ToState: StateCollected, ExpectedRevision: 1, IdempotencyKey: "collect-1"})
	if err != nil || replay.Revision != 2 {
		t.Fatalf("transition replay: %+v err=%v", replay, err)
	}
	if _, err := service.Transition(context.Background(), TransitionInput{ActorID: "usr_owner", PublicID: created.PublicID, ToState: StateImplemented, ExpectedRevision: 1, IdempotencyKey: "stale-1"}); !hasCode(err, CodeRevisionConflict) {
		t.Fatalf("stale transition: %v", err)
	}
	if _, err := service.Transition(context.Background(), TransitionInput{ActorID: "usr_owner", PublicID: created.PublicID, ToState: StateRejected, ExpectedRevision: 2, IdempotencyKey: "reject-missing"}); !hasCode(err, CodeRejectionResponseRequired) {
		t.Fatalf("missing rejection response: %v", err)
	}
	rejected, err := service.Transition(context.Background(), TransitionInput{ActorID: "usr_owner", PublicID: created.PublicID, ToState: StateRejected, Response: "当前阶段不纳入计划。", ExpectedRevision: 2, IdempotencyKey: "reject-1"})
	if err != nil || rejected.State != StateRejected || rejected.ArchiveOutcome == nil || *rejected.ArchiveOutcome != ArchiveRejected || rejected.Revision != 3 {
		t.Fatalf("reject: %+v err=%v", rejected, err)
	}
	if _, err := service.Transition(context.Background(), TransitionInput{ActorID: "usr_owner", PublicID: created.PublicID, ToState: StateCollected, ExpectedRevision: 3, IdempotencyKey: "terminal-1"}); !hasCode(err, CodeInvalidTransition) {
		t.Fatalf("terminal transition: %v", err)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	for _, audit := range repo.state.audits {
		if stringsContainsAny(audit.Reason, "当前阶段", "希望可以") {
			t.Fatalf("private content in audit: %+v", audit)
		}
	}
}

func TestTransitionValidationAuditAndCardContracts(t *testing.T) {
	repo := newFakeRepository()
	service := testService(repo, time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC), sequenceFactory())
	created, err := service.Submit(context.Background(), testSubmitInput("usr_member", "contract-submit"))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := service.Transition(context.Background(), TransitionInput{
		ActorID: "usr_owner", PublicID: created.PublicID, ToState: StateRejected,
		ResponseSet: true, ExpectedRevision: 1, IdempotencyKey: "empty-response",
	}); !hasCode(err, CodeResponseInvalid) {
		t.Fatalf("explicit empty response: %v", err)
	}
	repo.mu.Lock()
	if len(repo.state.audits) == 0 || repo.state.audits[len(repo.state.audits)-1].Reason != CodeResponseInvalid {
		t.Fatalf("validation audit: %+v", repo.state.audits)
	}
	repo.mu.Unlock()

	event, err := service.ProjectEvent(context.Background(), GetInput{ActorID: "usr_owner", PublicID: created.PublicID})
	if err != nil || event == nil || event.Payload.Card.CardType != CardTypeRequirementStatus {
		t.Fatalf("event contract: %+v err=%v", event, err)
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), `"detail"`) || strings.Contains(string(encoded), `"type":"card"`) {
		t.Fatalf("event leaked private/card-block fields: %s", encoded)
	}

	card, err := service.ProjectCard(context.Background(), GetInput{ActorID: "usr_member", PublicID: created.PublicID, CardType: CardTypeRequirementStatus})
	if err != nil || card.Block.CardType != CardTypeRequirementStatus {
		t.Fatalf("status card: %+v err=%v", card, err)
	}
	listCard, err := service.ProjectListCard(context.Background(), ListInput{ActorID: "usr_member"})
	if err != nil || listCard.Block.CardType != CardTypeRequirementList {
		t.Fatalf("list card: %+v err=%v", listCard, err)
	}
	if _, err := ValidateRequirementCardPayload(CardTypeRequirement, map[string]any{
		"publicId": created.PublicID, "type": TypeRequirement, "title": "safe", "detail": "<script>alert(1)</script>",
		"scenario": "safe", "expectedResult": "safe", "state": StateSubmitted, "revision": int64(1),
	}); !hasCode(err, "card.unsafe_content") {
		t.Fatalf("unsafe card payload: %v", err)
	}
	if _, err := ValidateRequirementCardActionInput("reject", map[string]any{"idempotencyKey": "card-reject", "response": ""}); !hasCode(err, "card.action_input_invalid") {
		t.Fatalf("invalid card action input: %v", err)
	}
}

func TestValidationAndIDFactoryFailureRollBack(t *testing.T) {
	repo := newFakeRepository()
	service := testService(repo, time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC), func() (string, error) { return "", errors.New("entropy unavailable") })
	if _, err := service.Submit(context.Background(), testSubmitInput("usr_member", "failed-id")); !hasCode(err, CodeInternal) {
		t.Fatalf("id factory failure: %v", err)
	}
	repo.mu.Lock()
	if len(repo.state.requirements) != 0 || len(repo.state.history) != 0 || len(repo.state.events) != 0 || len(repo.state.audits) != 0 {
		t.Fatalf("id failure persisted state: %+v", repo.state)
	}
	repo.mu.Unlock()
	service = testService(repo, time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC), sequenceFactory())
	bad := testSubmitInput("usr_member", "bad-link")
	bad.RelatedLink = "http://127.0.0.1/admin"
	if _, err := service.Submit(context.Background(), bad); !hasCode(err, CodeRelatedLinkInvalid) {
		t.Fatalf("bad link: %v", err)
	}
	bad = testSubmitInput("usr_member", "bad-control")
	bad.Title = "bad\x00title"
	if _, err := service.Submit(context.Background(), bad); !hasCode(err, CodeTitleInvalid) {
		t.Fatalf("bad title: %v", err)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.state.requirements) != 0 || len(repo.state.audits) != 2 {
		t.Fatalf("validation rows: requirements=%d audits=%d", len(repo.state.requirements), len(repo.state.audits))
	}
	for _, audit := range repo.state.audits {
		if stringsContainsAny(audit.Reason, "127.0.0.1", "bad") {
			t.Fatalf("validation audit leaked input: %+v", audit)
		}
	}
}

func TestConcurrentSubmissionsHaveDistinctSequenceNumbers(t *testing.T) {
	repo := newFakeRepository()
	service := testService(repo, time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC), sequenceFactory())
	const count = 20
	errs := make(chan error, count)
	var wait sync.WaitGroup
	for i := 0; i < count; i++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			input := testSubmitInput("usr_member", fmt.Sprintf("parallel-%d", index))
			_, err := service.Submit(context.Background(), input)
			errs <- err
		}(i)
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	seen := map[string]bool{}
	for _, record := range repo.state.requirements {
		if seen[record.PublicID] {
			t.Fatalf("duplicate public id %s", record.PublicID)
		}
		seen[record.PublicID] = true
	}
	if len(seen) != count {
		t.Fatalf("got %d requirements want %d", len(seen), count)
	}
}

func hasCode(err error, code string) bool {
	var domainErr *Error
	return errors.As(err, &domainErr) && domainErr != nil && domainErr.Code == code
}

func stringsContainsAny(value string, candidates ...string) bool {
	for _, candidate := range candidates {
		if candidate != "" && strings.Contains(value, candidate) {
			return true
		}
	}
	return false
}
