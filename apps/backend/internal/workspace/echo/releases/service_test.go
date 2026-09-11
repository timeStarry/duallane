package releases

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
)

var testReleaseTime = time.Date(2026, 9, 6, 12, 34, 56, 789000000, time.UTC)

func sharedReleaseCatalog(t *testing.T) GuideCatalog {
	t.Helper()
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	path := filepath.Clean(filepath.Join(filepath.Dir(sourceFile), "../../../../../web/shared/echo-release-guides.json"))
	catalog, err := LoadGuideCatalog(path)
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func newTestService(t *testing.T, repository Repository) *Service {
	t.Helper()
	var sequence int
	service, err := NewService(ServiceOptions{
		Repository: repository,
		Catalog:    sharedReleaseCatalog(t),
		SpaceID:    DefaultSpaceID,
		Now:        func() time.Time { return testReleaseTime },
		IDFactory: func() (string, error) {
			sequence++
			return fmt.Sprintf("release-test-%03d", sequence), nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func TestLoadGuideCatalogFromCanonicalSharedAsset(t *testing.T) {
	catalog := sharedReleaseCatalog(t)
	if catalog.Empty() {
		t.Fatal("canonical release catalog is empty")
	}
	guide, ok := catalog.Guide("v0.19.1")
	if !ok {
		t.Fatal("canonical catalog does not contain current release 0.19.1")
	}
	if guide.Version != "0.19.1" || guide.ReleasedAt != "2026-09-12" || guide.Title != "表情回复面板保持可见" || guide.Summary != "修复消息靠近底部或屏幕较窄时表情回复面板显示不全的问题，群聊、私聊和话题保持一致。" || len(guide.Sections) != 1 || guide.Sections[0].Items[0].Location == "" {
		t.Fatalf("incomplete canonical guide: %#v", guide)
	}
	guide.Sections[0].Items[0].Title = "mutated test copy"
	fresh, ok := catalog.Guide("0.19.1")
	if !ok || fresh.Sections[0].Items[0].Title == "mutated test copy" {
		t.Fatal("catalog returned mutable internal state")
	}
}

func TestCatalogRejectsInvalidAndDuplicateGuides(t *testing.T) {
	_, err := NewGuideCatalog(nil)
	if !errors.Is(err, ErrCatalogEmpty) {
		t.Fatalf("empty catalog error = %v", err)
	}
	guide := Guide{
		Version:    "0.1.0",
		ReleasedAt: "2026-09-06",
		Title:      "title",
		Summary:    "summary",
		Sections: []GuideSection{{Title: "section", Items: []GuideItem{{
			Title: "item", Description: "description", Location: "settings",
		}}}},
	}
	if _, err := NewGuideCatalog([]Guide{guide, guide}); !errors.Is(err, ErrCatalogInvalid) {
		t.Fatalf("duplicate guide error = %v", err)
	}
	guide.Sections[0].Items[0].Location = "\x00"
	if _, err := NewGuideCatalog([]Guide{guide}); !errors.Is(err, ErrCatalogInvalid) {
		t.Fatalf("unsafe guide error = %v", err)
	}
}

func TestPublishSnapshotsActiveMembersAndReplaysByVersion(t *testing.T) {
	repository := newFakeRepository()
	service := newTestService(t, repository)
	first, err := service.Publish(context.Background(), PublishInput{
		ActorID: "usr_owner",
		Version: "v0.15.1",
		Meta:    auth.RequestMeta{RequestID: "release-first"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Version != "0.15.1" || first.RecipientCount != 2 || first.PendingCount != 2 || first.Replayed {
		t.Fatalf("first publication = %#v", first)
	}
	second, err := service.Publish(context.Background(), PublishInput{
		ActorID: "usr_owner",
		Version: "0.15.1",
		Meta:    auth.RequestMeta{RequestID: "release-replay"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID || !second.Replayed || second.RecipientCount != 2 {
		t.Fatalf("replayed publication = %#v", second)
	}
	if len(repository.state.publications) != 1 || len(repository.state.deliveries) != 2 {
		t.Fatalf("publication rows = %d, delivery rows = %d", len(repository.state.publications), len(repository.state.deliveries))
	}
	publication := repository.state.publications[publicationKey(DefaultSpaceID, "0.15.1")]
	if publication.GuideHash == "" || len(publication.GuideJSON) == 0 {
		t.Fatal("publication did not persist guide snapshot and hash")
	}
	if string(publication.GuideJSON) == "" {
		t.Fatal("publication guide snapshot is empty")
	}
	if !stringsHasPrefix(publication.ID, "echo_release_") {
		t.Fatalf("publication ID = %q, missing Node prefix", publication.ID)
	}
	for _, delivery := range repository.state.deliveries {
		if !stringsHasPrefix(delivery.ID, "echo_release_delivery_") {
			t.Fatalf("delivery ID = %q, missing Node prefix", delivery.ID)
		}
	}
	if len(repository.state.audits) != 2 || repository.state.audits[0].Reason != "published" || repository.state.audits[1].Reason != "replayed" {
		t.Fatalf("publication audits = %#v", repository.state.audits)
	}
	for _, audit := range repository.state.audits {
		if audit.TargetID != "0.15.1" || audit.Reason == "" {
			t.Fatalf("unsafe or incomplete audit = %#v", audit)
		}
	}
	card, err := service.ProjectCard(context.Background(), ProjectCardInput{ActorID: "usr_member", Version: "0.15.1"})
	if err != nil {
		t.Fatal(err)
	}
	if card.Block.CardType != CardType || card.Block.SchemaVersion != CardSchemaVersion || card.Payload.Version != "0.15.1" || card.Payload.PublishedAt == "" {
		t.Fatalf("release card = %#v", card)
	}
	if _, err := service.ProjectCard(context.Background(), ProjectCardInput{ActorID: "usr_member", Version: "0.15.1", PublicationID: first.ID}); err != nil {
		t.Fatalf("matching publication projection: %v", err)
	}
	if _, err := service.ProjectCard(context.Background(), ProjectCardInput{ActorID: "usr_member", Version: "0.15.1", PublicationID: "different-publication"}); !hasCode(err, CodeNotFound) {
		t.Fatalf("mismatched publication projection: %v", err)
	}
	publicationSummary, err := service.GetPublication(context.Background(), "V0.15.1")
	if err != nil || publicationSummary == nil || publicationSummary.ID != first.ID || publicationSummary.Replayed {
		t.Fatalf("get publication = %#v err=%v", publicationSummary, err)
	}
	missingSummary, err := service.GetPublication(context.Background(), "9.9.9")
	if err != nil || missingSummary != nil {
		t.Fatalf("missing publication = %#v err=%v", missingSummary, err)
	}
}

func TestPublishOwnerAuthorizationAndUnknownGuideAudit(t *testing.T) {
	repository := newFakeRepository()
	service := newTestService(t, repository)
	if _, err := service.Publish(context.Background(), PublishInput{ActorID: "usr_member", Version: "0.15.1"}); !hasCode(err, CodePermissionDenied) {
		t.Fatalf("member publish error = %v", err)
	}
	if _, err := service.Publish(context.Background(), PublishInput{ActorID: "usr_missing", Version: "0.15.1"}); !hasCode(err, CodePermissionDenied) || publicMessage(err) != MessageUnauthorized {
		t.Fatalf("missing actor publish error = %v", err)
	}
	if _, err := service.Publish(context.Background(), PublishInput{ActorID: "usr_owner", Version: "9.9.9"}); !hasCode(err, CodeGuideNotFound) {
		t.Fatalf("unknown guide error = %v", err)
	}
	if len(repository.state.publications) != 0 || len(repository.state.deliveries) != 0 {
		t.Fatalf("rejected publish changed domain rows: publications=%d deliveries=%d", len(repository.state.publications), len(repository.state.deliveries))
	}
	if len(repository.state.audits) != 2 || repository.state.audits[0].Result != "rejected" || repository.state.audits[1].Result != "rejected" {
		t.Fatalf("rejection audits = %#v", repository.state.audits)
	}
}

func publicMessage(err error) string {
	var domainErr *Error
	if !errors.As(err, &domainErr) || domainErr == nil {
		return ""
	}
	return domainErr.Message
}

func TestPublishRollsBackOnDeliveryPersistenceFailure(t *testing.T) {
	repository := newFakeRepository()
	repository.failInsertDeliveries = true
	service := newTestService(t, repository)
	if _, err := service.Publish(context.Background(), PublishInput{ActorID: "usr_owner", Version: "0.15.1"}); err == nil || !hasCode(err, CodeInternal) {
		t.Fatalf("delivery persistence error = %v", err)
	}
	if len(repository.state.publications) != 0 || len(repository.state.deliveries) != 0 || len(repository.state.audits) != 0 {
		t.Fatalf("failed transaction left rows: publications=%d deliveries=%d audits=%d", len(repository.state.publications), len(repository.state.deliveries), len(repository.state.audits))
	}
	repository.failInsertDeliveries = false
	if _, err := service.Publish(context.Background(), PublishInput{ActorID: "usr_owner", Version: "0.15.1"}); err != nil {
		t.Fatal(err)
	}
}

func TestPublishSerializesConcurrentSameVersion(t *testing.T) {
	repository := newFakeRepository()
	service := newTestService(t, repository)
	results := make(chan *PublicationSummary, 2)
	errorsCh := make(chan error, 2)
	var wait sync.WaitGroup
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			result, err := service.Publish(context.Background(), PublishInput{ActorID: "usr_owner", Version: "0.15.1"})
			results <- result
			errorsCh <- err
		}()
	}
	wait.Wait()
	close(results)
	close(errorsCh)
	var published, replayed int
	for result := range results {
		if result == nil {
			t.Fatal("concurrent publication returned nil result")
		}
		if result.Replayed {
			replayed++
		} else {
			published++
		}
	}
	for err := range errorsCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	if published != 1 || replayed != 1 || len(repository.state.publications) != 1 || len(repository.state.deliveries) != 2 {
		t.Fatalf("concurrent publication results published=%d replayed=%d publications=%d deliveries=%d", published, replayed, len(repository.state.publications), len(repository.state.deliveries))
	}
}

func hasCode(err error, code string) bool {
	var domainErr *Error
	return errors.As(err, &domainErr) && domainErr != nil && domainErr.Code == code
}

type fakeMembership struct {
	actor   auth.Actor
	removed bool
}

type fakeState struct {
	memberships  map[string]fakeMembership
	publications map[string]PublicationRecord
	deliveries   map[string]DeliveryRecord
	audits       []AuditInput
	nextDelivery int
}

func (s fakeState) clone() fakeState {
	copyState := fakeState{
		memberships:  make(map[string]fakeMembership, len(s.memberships)),
		publications: make(map[string]PublicationRecord, len(s.publications)),
		deliveries:   make(map[string]DeliveryRecord, len(s.deliveries)),
		audits:       append([]AuditInput(nil), s.audits...),
		nextDelivery: s.nextDelivery,
	}
	for key, member := range s.memberships {
		copyState.memberships[key] = member
	}
	for key, publication := range s.publications {
		publication.GuideJSON = append([]byte(nil), publication.GuideJSON...)
		copyState.publications[key] = publication
	}
	for key, delivery := range s.deliveries {
		copyState.deliveries[key] = delivery
	}
	return copyState
}

type fakeRepository struct {
	mu                   sync.Mutex
	state                fakeState
	failInsertDeliveries bool
	failAudit            bool
}

func newFakeRepository() *fakeRepository {
	repository := &fakeRepository{state: fakeState{
		memberships:  make(map[string]fakeMembership),
		publications: make(map[string]PublicationRecord),
		deliveries:   make(map[string]DeliveryRecord),
	}}
	repository.addMember("usr_owner", "owner", "human", false)
	repository.addMember("usr_member", "member", "human", false)
	repository.addMember("usr_removed", "member", "human", true)
	repository.addMember("usr_bot", "member", "bot", false)
	return repository
}

func (r *fakeRepository) addMember(id, role, kind string, removed bool) {
	r.state.memberships[memberKey(DefaultSpaceID, id)] = fakeMembership{actor: auth.Actor{ID: id, GitHubLogin: id + "-login", Kind: kind, Role: role}, removed: removed}
}

func (r *fakeRepository) WithTx(_ context.Context, callback func(Tx) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	working := r.state.clone()
	tx := &fakeTx{state: &working, failInsertDeliveries: r.failInsertDeliveries, failAudit: r.failAudit}
	if err := callback(tx); err != nil {
		return err
	}
	r.state = working
	return nil
}

func (r *fakeRepository) LookupActor(_ context.Context, spaceID, userID string) (*auth.Actor, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return lookupFakeActor(r.state, spaceID, userID), nil
}

func (r *fakeRepository) GetPublication(_ context.Context, spaceID, version string) (*PublicationRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return getFakePublication(r.state, spaceID, version), nil
}

func (r *fakeRepository) GetPublicationForRecipient(_ context.Context, spaceID, version, recipientID string) (*PublicationRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	publication := getFakePublication(r.state, spaceID, version)
	if publication == nil {
		return nil, nil
	}
	for _, delivery := range r.state.deliveries {
		if delivery.PublicationID == publication.ID && delivery.RecipientUserID == recipientID {
			return publication, nil
		}
	}
	return nil, nil
}

func (r *fakeRepository) DeliverySummary(_ context.Context, publicationID string) (DeliverySummary, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return fakeDeliverySummary(r.state, publicationID), nil
}

func (r *fakeRepository) ListDeliveries(_ context.Context, query DeliveryQuery) ([]DeliveryRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]DeliveryRecord, 0)
	for _, delivery := range r.state.deliveries {
		if delivery.SpaceID == query.SpaceID && (query.Version == "" || delivery.Version == query.Version) {
			result = append(result, delivery)
		}
	}
	return result, nil
}

func (r *fakeRepository) GetDelivery(_ context.Context, spaceID, deliveryID string) (*DeliveryRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delivery, ok := r.state.deliveries[deliveryID]
	if !ok || delivery.SpaceID != spaceID {
		return nil, nil
	}
	return &delivery, nil
}

type fakeTx struct {
	state                *fakeState
	failInsertDeliveries bool
	failAudit            bool
}

func (t *fakeTx) LookupActor(_ context.Context, spaceID, userID string) (*auth.Actor, error) {
	return lookupFakeActor(*t.state, spaceID, userID), nil
}

func (t *fakeTx) GetPublication(_ context.Context, spaceID, version string) (*PublicationRecord, error) {
	return getFakePublication(*t.state, spaceID, version), nil
}

func (t *fakeTx) GetPublicationForRecipient(_ context.Context, spaceID, version, recipientID string) (*PublicationRecord, error) {
	publication := getFakePublication(*t.state, spaceID, version)
	if publication == nil {
		return nil, nil
	}
	for _, delivery := range t.state.deliveries {
		if delivery.PublicationID == publication.ID && delivery.RecipientUserID == recipientID {
			return publication, nil
		}
	}
	return nil, nil
}

func (t *fakeTx) DeliverySummary(_ context.Context, publicationID string) (DeliverySummary, error) {
	return fakeDeliverySummary(*t.state, publicationID), nil
}

func (t *fakeTx) Lock(context.Context, string) error { return nil }

func (t *fakeTx) InsertPublication(_ context.Context, record PublicationRecord) error {
	key := publicationKey(record.SpaceID, record.Version)
	if _, exists := t.state.publications[key]; exists {
		return errors.New("duplicate publication")
	}
	record.GuideJSON = append([]byte(nil), record.GuideJSON...)
	t.state.publications[key] = record
	return nil
}

func (t *fakeTx) InsertDeliveryRows(_ context.Context, spaceID, publicationID string, now time.Time) error {
	if t.failInsertDeliveries {
		return errors.New("synthetic delivery persistence failure")
	}
	for key, member := range t.state.memberships {
		if !stringsHasPrefix(key, spaceID+"\x00") || member.removed || member.actor.Kind != "human" {
			continue
		}
		t.state.nextDelivery++
		id := fmt.Sprintf("echo_release_delivery_%03d", t.state.nextDelivery)
		version := ""
		for _, publication := range t.state.publications {
			if publication.ID == publicationID {
				version = publication.Version
			}
		}
		t.state.deliveries[id] = DeliveryRecord{ID: id, SpaceID: spaceID, PublicationID: publicationID, Version: version, RecipientUserID: member.actor.ID, RecipientKind: member.actor.Kind, RecipientActive: true, Status: DeliveryPending, PublishedAt: now, CreatedAt: now, UpdatedAt: now}
	}
	return nil
}

func (t *fakeTx) WriteAudit(_ context.Context, input AuditInput) error {
	if t.failAudit {
		return errors.New("synthetic audit failure")
	}
	t.state.audits = append(t.state.audits, input)
	return nil
}

func lookupFakeActor(state fakeState, spaceID, userID string) *auth.Actor {
	member, ok := state.memberships[memberKey(spaceID, userID)]
	if !ok || member.removed {
		return nil
	}
	actor := member.actor
	return &actor
}

func getFakePublication(state fakeState, spaceID, version string) *PublicationRecord {
	record, ok := state.publications[publicationKey(spaceID, version)]
	if !ok {
		return nil
	}
	record.GuideJSON = append([]byte(nil), record.GuideJSON...)
	return &record
}

func fakeDeliverySummary(state fakeState, publicationID string) DeliverySummary {
	var result DeliverySummary
	for _, delivery := range state.deliveries {
		if delivery.PublicationID != publicationID {
			continue
		}
		result.RecipientCount++
		switch delivery.Status {
		case DeliveryPending:
			result.PendingCount++
		case DeliverySent:
			result.SentCount++
		case DeliveryFailed:
			result.FailedCount++
		case DeliverySkipped:
			result.SkippedCount++
		}
	}
	return result
}

func memberKey(spaceID, userID string) string       { return spaceID + "\x00" + userID }
func publicationKey(spaceID, version string) string { return spaceID + "\x00" + version }
func stringsHasPrefix(value, prefix string) bool {
	return len(value) >= len(prefix) && value[:len(prefix)] == prefix
}
