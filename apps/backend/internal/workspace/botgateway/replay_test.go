package botgateway

import (
	"context"
	"strconv"
	"testing"
)

func TestReplayRetriesDiscoveryAfterBacklogClears(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	repo.limits.EventBacklogLimit = 1
	first := addReplayTestTrigger(repo, 1)
	second := addReplayTestTrigger(repo, 2)
	ctx := context.Background()

	page, err := service.Replay(ctx, authValue, ReplayInput{})
	if err != nil || len(page.Events) != 1 || page.Events[0].EventID != first.ID ||
		page.ResumeSequence != 1 || page.CurrentSequence != 2 || !page.HasMore {
		t.Fatalf("full backlog page = %#v, %v", page, err)
	}
	waiting, err := service.Replay(ctx, authValue, ReplayInput{LastSequence: page.ResumeSequence})
	if err != nil || len(waiting.Events) != 0 || waiting.ResumeSequence != 1 || !waiting.HasMore || waiting.SyncRequired {
		t.Fatalf("waiting page = %#v, %v", waiting, err)
	}
	ack, err := service.Acknowledge(ctx, authValue, AcknowledgeInput{EventID: first.ID, Sequence: first.Sequence})
	if err != nil || !ack.Acknowledged {
		t.Fatalf("first ACK = %#v, %v", ack, err)
	}
	ack, err = service.Acknowledge(ctx, authValue, AcknowledgeInput{EventID: first.ID, Sequence: first.Sequence})
	if err != nil || !ack.Acknowledged || repo.processed != 1 {
		t.Fatalf("repeat ACK = %#v, %v, processed=%d", ack, err, repo.processed)
	}
	next, err := service.Replay(ctx, authValue, ReplayInput{LastSequence: page.ResumeSequence})
	if err != nil || len(next.Events) != 1 || next.Events[0].EventID != second.ID || next.HasMore {
		t.Fatalf("released backlog page = %#v, %v", next, err)
	}
}

func TestReplayDrainsPreviouslyQueuedDeliveryWhenDiscoveryIsSaturated(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	repo.limits.EventBacklogLimit = 1
	addReplayTestTrigger(repo, 1)
	second := addReplayTestTrigger(repo, 2)
	repo.deliveries = []DeliveryRecord{{
		ID: "existing_delivery", BotID: authValue.BotID, SpaceID: authValue.SpaceID, EventID: second.ID,
		Sequence: second.Sequence, EventType: second.EventType, ConversationID: second.ConversationID,
		Status: "queued", CreatedAt: repo.now(), ExpiresAt: repo.now().Add(ReplayWindow),
	}}

	page, err := service.Replay(context.Background(), authValue, ReplayInput{})
	if err != nil || len(page.Events) != 1 || page.Events[0].EventID != second.ID ||
		page.Events[0].ID != "existing_delivery" || page.SyncRequired {
		t.Fatalf("persisted queue blocked by discovery quota: %#v, %v", page, err)
	}
}

func TestReplayMemberLimitDoesNotBlockAnotherRequestor(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	repo.limits.MemberDailyRequests = 1
	previous := addReplayTestTrigger(repo, 1)
	repo.deliveries = []DeliveryRecord{{
		ID: "previous_delivery", BotID: authValue.BotID, SpaceID: authValue.SpaceID, EventID: previous.ID,
		Sequence: previous.Sequence, Status: "acked", CreatedAt: repo.now(), ExpiresAt: repo.now().Add(ReplayWindow),
	}}
	addReplayTestTrigger(repo, 2)
	other := addReplayTestTrigger(repo, 3)
	other.ActorUserID = "second_sender"
	repo.events[2] = other
	repo.members["conv_direct:second_sender"] = true
	repo.senders["conv_direct:second_sender"] = &Sender{ID: other.ActorUserID, Kind: "human", Role: "member"}
	repo.triggers[other.ConversationID+":"+other.TargetID].AuthorID = other.ActorUserID

	page, err := service.Replay(context.Background(), authValue, ReplayInput{LastSequence: previous.Sequence})
	if err != nil || len(page.Events) != 1 || page.Events[0].EventID != other.ID || page.HasMore {
		t.Fatalf("member's rate limit stalled another requestor: %#v, %v", page, err)
	}
}

func TestReplayEmptyPageOfRevokedRowsStillContinues(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	for sequence := int64(1); sequence <= 5; sequence++ {
		event := addReplayTestTrigger(repo, sequence)
		repo.deliveries = append(repo.deliveries, DeliveryRecord{
			ID: "delivery_" + strconv.FormatInt(sequence, 10), BotID: authValue.BotID, SpaceID: authValue.SpaceID,
			EventID: event.ID, Sequence: sequence, EventType: event.EventType, ConversationID: event.ConversationID,
			Status: "queued", CreatedAt: repo.now(), ExpiresAt: repo.now().Add(ReplayWindow),
		})
		if sequence < 5 {
			delete(repo.triggers, event.ConversationID+":"+event.TargetID)
		}
	}
	ctx := context.Background()

	page, err := service.Replay(ctx, authValue, ReplayInput{Limit: 1})
	if err != nil || len(page.Events) != 0 || page.ResumeSequence != 4 || !page.HasMore || page.SyncRequired {
		t.Fatalf("revoked page = %#v, %v", page, err)
	}
	next, err := service.Replay(ctx, authValue, ReplayInput{LastSequence: page.ResumeSequence, Limit: 1})
	if err != nil || len(next.Events) != 1 || next.Events[0].Sequence != 5 || next.HasMore || next.SyncRequired {
		t.Fatalf("authorized page = %#v, %v", next, err)
	}
}

func TestReplayResumesBeforeAnEventCommittedDuringDiscovery(t *testing.T) {
	repo, service, authValue, _, _ := gatewayFixture(t)
	repo.events = []EventRecord{{
		ID: "noise", SpaceID: authValue.SpaceID, Sequence: 1, EventType: "conversation.typing", CreatedAt: repo.now(),
	}}
	service.repo = &replayHeadFixture{
		fakeRepository: repo,
		afterHeadRead:  func() { addReplayTestTrigger(repo, 2) },
	}
	ctx := context.Background()

	page, err := service.Replay(ctx, authValue, ReplayInput{})
	if err != nil || len(page.Events) != 0 || page.CurrentSequence != 1 || page.ResumeSequence != 1 {
		t.Fatalf("captured replay page = %#v, %v", page, err)
	}
	next, err := service.Replay(ctx, authValue, ReplayInput{LastSequence: page.ResumeSequence})
	if err != nil || len(next.Events) != 1 || next.Events[0].Sequence != 2 {
		t.Fatalf("late event page = %#v, %v", next, err)
	}
}

type replayHeadFixture struct {
	*fakeRepository
	afterHeadRead func()
}

func (f *replayHeadFixture) CurrentSequence(ctx context.Context, spaceID string) (int64, error) {
	head, err := f.fakeRepository.CurrentSequence(ctx, spaceID)
	if f.afterHeadRead != nil {
		f.afterHeadRead()
		f.afterHeadRead = nil
	}
	return head, err
}

func addReplayTestTrigger(repo *fakeRepository, sequence int64) EventRecord {
	id := strconv.FormatInt(sequence, 10)
	event := EventRecord{
		ID: "event_" + id, SpaceID: repo.auth.SpaceID, Sequence: sequence, EventType: "message.created",
		ActorUserID: "owner_1", ConversationID: "conv_direct", TargetID: "message_" + id,
		PayloadJSON: []byte(`{}`), CreatedAt: repo.now(),
	}
	repo.events = append(repo.events, event)
	repo.triggers[event.ConversationID+":"+event.TargetID] = &MessageTrigger{
		AuthorID: "owner_1", PlainText: "test trigger", ContentJSON: []byte(`{"blocks":[{"type":"text","text":"test trigger"}]}`),
	}
	return event
}
