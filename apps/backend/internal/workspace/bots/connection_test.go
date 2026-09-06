package bots

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type connectionProviderStub struct {
	mu         sync.Mutex
	record     *ConnectionRecord
	getErr     error
	testErr    error
	testCalls  int
	lastTestAt time.Time
}

func (p *connectionProviderStub) GetConnection(context.Context, string, string) (*ConnectionRecord, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return cloneConnectionRecord(p.record), p.getErr
}

func (p *connectionProviderStub) TestConnectionInTx(ctx context.Context, tx ConnectionTransaction, botID, spaceID string, at time.Time) (*ConnectionRecord, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.testCalls++
	p.lastTestAt = at
	if p.testErr != nil {
		return nil, p.testErr
	}
	if tx == nil {
		return nil, errors.New("connection transaction is required")
	}
	transactional, err := tx.ClearConnectionErrors(ctx, botID, spaceID, at)
	if err != nil {
		return nil, err
	}
	if p.record == nil {
		return transactional, nil
	}
	p.record.LastErrorCode = nil
	p.record.LastErrorAt = nil
	p.record.UpdatedAt = at
	return cloneConnectionRecord(p.record), nil
}

func cloneConnectionRecord(value *ConnectionRecord) *ConnectionRecord {
	if value == nil {
		return nil
	}
	result := *value
	result.AdapterVersion = cloneString(value.AdapterVersion)
	result.ConnectedAt = cloneTime(value.ConnectedAt)
	result.DisconnectedAt = cloneTime(value.DisconnectedAt)
	result.LastHeartbeatAt = cloneTime(value.LastHeartbeatAt)
	result.LastProcessedAt = cloneTime(value.LastProcessedAt)
	result.LastErrorCode = cloneString(value.LastErrorCode)
	result.LastErrorAt = cloneTime(value.LastErrorAt)
	return &result
}

func connectionTime(value time.Time) *time.Time { return &value }

func TestBotConnectionOwnerProjectionAndTestAudit(t *testing.T) {
	repo := newFakeRepository()
	now := time.Date(2026, 9, 6, 9, 10, 11, 123456789, time.UTC)
	service := testService(repo, &now, newSequence())
	provider := &connectionProviderStub{}
	service.connectionProvider = provider

	bot, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "Connection Bot"})
	if err != nil {
		t.Fatal(err)
	}
	adapterVersion := "gateway-v1"
	errorCode := "gateway.timeout"
	errorAt := now.Add(-time.Minute)
	provider.record = &ConnectionRecord{
		ID: "bcon-connection", BotID: bot.ID, SpaceID: testSpaceID,
		Status: ConnectionStatusConnected, AdapterVersion: &adapterVersion,
		ConnectedAt: connectionTime(now.Add(-time.Hour)), LastHeartbeatAt: connectionTime(now.Add(-time.Second)),
		LastErrorCode: &errorCode, LastErrorAt: &errorAt, UpdatedAt: now,
	}

	connection, err := service.GetConnectionStatus(context.Background(), ConnectionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID})
	if err != nil || connection == nil || connection.Status != ConnectionStatusConnected || connection.AdapterVersion == nil || *connection.AdapterVersion != adapterVersion {
		t.Fatalf("connection = %#v, err=%v", connection, err)
	}
	encoded, err := json.Marshal(connection)
	if err != nil {
		t.Fatal(err)
	}
	encodedText := string(encoded)
	for _, forbidden := range []string{"connectionNonce", "nonce", "secret", "token"} {
		if strings.Contains(encodedText, forbidden) {
			t.Fatalf("connection projection leaked %q: %s", forbidden, encodedText)
		}
	}

	tested, err := service.TestConnection(context.Background(), ConnectionTestInput{
		ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID,
		Meta: RequestMeta{RequestID: "connection-test"},
	})
	if err != nil || tested == nil || tested.TestedAt != "2026-09-06T09:10:11.123Z" || tested.LastErrorCode != nil || tested.LastErrorAt != nil {
		t.Fatalf("tested connection = %#v, err=%v", tested, err)
	}
	if provider.testCalls != 1 || !provider.lastTestAt.Equal(now.Truncate(time.Millisecond)) {
		t.Fatalf("provider test = calls:%d at:%s", provider.testCalls, provider.lastTestAt)
	}
	if len(repo.state.audits) == 0 || repo.state.audits[len(repo.state.audits)-1].Action != "bot.connection.test" || repo.state.audits[len(repo.state.audits)-1].Result != "success" {
		t.Fatalf("connection test audit = %#v", repo.state.audits)
	}
}

func TestBotConnectionAllowsPausedAndDeletedBotProjection(t *testing.T) {
	repo := newFakeRepository()
	now := time.Date(2026, 9, 6, 10, 0, 0, 0, time.UTC)
	service := testService(repo, &now, newSequence())
	provider := &connectionProviderStub{}
	service.connectionProvider = provider
	bot, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "Paused Connection Bot"})
	if err != nil {
		t.Fatal(err)
	}
	provider.record = &ConnectionRecord{ID: "bcon-paused", BotID: bot.ID, SpaceID: testSpaceID, Status: ConnectionStatusPaused, UpdatedAt: now}
	if _, err := service.Pause(context.Background(), TransitionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID}); err != nil {
		t.Fatal(err)
	}
	paused, err := service.GetConnectionStatus(context.Background(), ConnectionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID})
	if err != nil || paused == nil || paused.Status != ConnectionStatusPaused {
		t.Fatalf("paused connection = %#v, err=%v", paused, err)
	}
	if _, err := service.BeginDelete(context.Background(), TransitionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.FinalizeDelete(context.Background(), TransitionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID}); err != nil {
		t.Fatal(err)
	}
	provider.record.Status = ConnectionStatusRevoked
	deleted, err := service.GetConnectionStatus(context.Background(), ConnectionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID})
	if err != nil || deleted == nil || deleted.Status != ConnectionStatusRevoked {
		t.Fatalf("deleted connection = %#v, err=%v", deleted, err)
	}
}

func TestBotConnectionRejectsNonOwnerAndDoesNotCallProvider(t *testing.T) {
	repo := newFakeRepository()
	now := time.Date(2026, 9, 6, 11, 0, 0, 0, time.UTC)
	service := testService(repo, &now, newSequence())
	provider := &connectionProviderStub{record: &ConnectionRecord{ID: "bcon-owner", BotID: "bot-owner", SpaceID: testSpaceID, Status: ConnectionStatusConnected, UpdatedAt: now}}
	service.connectionProvider = provider
	bot, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "Owner Only Connection"})
	if err != nil {
		t.Fatal(err)
	}
	provider.record.BotID = bot.ID

	if _, err := service.GetConnectionStatus(context.Background(), ConnectionInput{ActorID: "usr_member", SpaceID: testSpaceID, BotID: bot.ID, Meta: RequestMeta{RequestID: "connection-read-denied"}}); domainCode(err) != CodePermissionDenied {
		t.Fatalf("non-owner read error = %v", err)
	}
	if _, err := service.TestConnection(context.Background(), ConnectionTestInput{ActorID: "usr_member", SpaceID: testSpaceID, BotID: bot.ID, Meta: RequestMeta{RequestID: "connection-test-denied"}}); domainCode(err) != CodePermissionDenied {
		t.Fatalf("non-owner test error = %v", err)
	}
	if provider.testCalls != 0 {
		t.Fatalf("provider was called for non-owner: %d", provider.testCalls)
	}
	var rejectedRead, rejectedTest int
	for _, audit := range repo.state.audits {
		if audit.Result != "rejected" || audit.Reason != CodePermissionDenied {
			continue
		}
		switch audit.Action {
		case "bot.connection.read":
			rejectedRead++
		case "bot.connection.test":
			rejectedTest++
		}
	}
	if rejectedRead != 1 || rejectedTest != 1 {
		t.Fatalf("rejection audits = read:%d test:%d all:%#v", rejectedRead, rejectedTest, repo.state.audits)
	}
}

func TestBotConnectionDoesNotSynthesizeSuccessWithoutProvider(t *testing.T) {
	repo := newFakeRepository()
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	service := testService(repo, &now, newSequence())
	bot, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "Provider Required Bot"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.GetConnectionStatus(context.Background(), ConnectionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID}); domainCode(err) != CodeInternal {
		t.Fatalf("missing provider read error = %v", err)
	}
	if _, err := service.TestConnection(context.Background(), ConnectionTestInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID}); domainCode(err) != CodeInternal {
		t.Fatalf("missing provider test error = %v", err)
	}
}

func TestBotConnectionRejectsProviderScopeMismatch(t *testing.T) {
	repo := newFakeRepository()
	now := time.Date(2026, 9, 6, 13, 0, 0, 0, time.UTC)
	service := testService(repo, &now, newSequence())
	bot, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "Scoped Connection Bot"})
	if err != nil {
		t.Fatal(err)
	}
	service.connectionProvider = &connectionProviderStub{record: &ConnectionRecord{
		ID: "bcon-wrong-scope", BotID: "bot-other", SpaceID: testSpaceID,
		Status: ConnectionStatusConnected, UpdatedAt: now,
	}}
	if _, err := service.GetConnectionStatus(context.Background(), ConnectionInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID}); domainCode(err) != CodeInternal {
		t.Fatalf("scope mismatch error = %v", err)
	}
}

func TestBotConnectionProviderErrorIsNotMasked(t *testing.T) {
	repo := newFakeRepository()
	now := time.Date(2026, 9, 6, 14, 0, 0, 0, time.UTC)
	service := testService(repo, &now, newSequence())
	bot, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "Provider Error Bot"})
	if err != nil {
		t.Fatal(err)
	}
	service.connectionProvider = &connectionProviderStub{testErr: errors.New("provider unavailable")}
	if _, err := service.TestConnection(context.Background(), ConnectionTestInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID}); domainCode(err) != CodeInternal {
		t.Fatalf("provider error = %v", err)
	}
	for _, audit := range repo.state.audits {
		if audit.Action == "bot.connection.test" && audit.Result == "success" {
			t.Fatalf("provider failure wrote success audit: %#v", repo.state.audits)
		}
	}
}

func TestBotConnectionTestRollsBackProjectionWhenAuditFails(t *testing.T) {
	repo := newFakeRepository()
	now := time.Date(2026, 9, 6, 15, 0, 0, 0, time.UTC)
	service := testService(repo, &now, newSequence())
	service.connectionProvider = NewRepositoryConnectionProvider(repo)
	bot, err := service.Create(context.Background(), CreateInput{ActorID: "usr_owner", SpaceID: testSpaceID, Name: "Atomic Connection Bot"})
	if err != nil {
		t.Fatal(err)
	}
	errorCode := "gateway.timeout"
	errorAt := now.Add(-time.Minute)
	repo.state.connections[connectionKey(bot.ID, testSpaceID)] = ConnectionRecord{
		ID: "bcon-atomic", BotID: bot.ID, SpaceID: testSpaceID, Status: ConnectionStatusConnected,
		LastErrorCode: &errorCode, LastErrorAt: &errorAt, UpdatedAt: errorAt,
	}
	repo.state.auditErr = errors.New("synthetic audit failure")
	if _, err := service.TestConnection(context.Background(), ConnectionTestInput{ActorID: "usr_owner", SpaceID: testSpaceID, BotID: bot.ID}); domainCode(err) != CodeInternal {
		t.Fatalf("audit failure = %v", err)
	}
	repo.state.auditErr = nil
	record, err := repo.GetConnection(context.Background(), bot.ID, testSpaceID)
	if err != nil {
		t.Fatal(err)
	}
	if record.LastErrorCode == nil || *record.LastErrorCode != errorCode || record.LastErrorAt == nil || !record.LastErrorAt.Equal(errorAt) {
		t.Fatalf("connection projection was committed without audit: %#v", record)
	}
}

func newSequence() *atomic.Int64 {
	return &atomic.Int64{}
}
