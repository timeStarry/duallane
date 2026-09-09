package delivery

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestDeliveryPublicJSONMatchesNodeStatusShapes(t *testing.T) {
	for _, item := range []struct {
		value any
		want  string
	}{
		{DeliveryResult{Status: DeliverySent, DeliveryID: "d", RecipientUserID: "u"}, `{"status":"sent","deliveryId":"d","recipientUserId":"u","cardId":null,"messageId":null,"replayed":false}`},
		{DeliveryResult{Status: DeliveryFailed, DeliveryID: "d", ErrorCode: "echo.fail"}, `{"status":"failed","deliveryId":"d","errorCode":"echo.fail"}`},
		{DeliverySummary{Type: DeliveryTypeSolicitation, Key: "SOL-2026-0001"}, `{"type":"solicitation","publicId":"SOL-2026-0001","results":[],"sent":0,"failed":0,"skipped":0}`},
		{DeliverySummary{Type: DeliveryTypeRelease, Key: "1.2.3"}, `{"type":"release","version":"1.2.3","results":[],"sent":0,"failed":0,"skipped":0}`},
	} {
		encoded, err := json.Marshal(item.value)
		if err != nil {
			t.Fatal(err)
		}
		var got, want any
		if err := json.Unmarshal(encoded, &got); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(item.want), &want); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("operational DTO = %s, want %s", encoded, item.want)
		}
	}
}

func TestDeliveryLeaseContextBoundsCallbackIO(t *testing.T) {
	repo := newDeliveryFakeRepository(time.Now())
	service := NewService(ServiceOptions{Repository: repo, LeaseTimeout: 10 * time.Millisecond})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	err := service.withLease(ctx, func(leaseCtx context.Context, _ Tx) error {
		deadline, ok := leaseCtx.Deadline()
		if !ok || time.Until(deadline) > 100*time.Millisecond {
			t.Fatal("callback did not receive lease deadline")
		}
		<-leaseCtx.Done()
		return leaseCtx.Err()
	})
	if !errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
		t.Fatalf("lease did not expire independently: %v", err)
	}
}

type pagedWorkFake struct {
	*fakeDeliveryState
	stop    context.CancelFunc
	lookups int
}

func (repo *pagedWorkFake) ListSolicitationWork(_ context.Context, _, after string, limit int) ([]SolicitationDelivery, error) {
	var rows []SolicitationDelivery
	for _, id := range []string{"a", "b"} {
		if id <= after {
			continue
		}
		row := *repo.solicitation
		row.ID, row.Status, row.AttemptCount = id, DeliveryFailed, 99
		rows = append(rows, row)
		if len(rows) == limit {
			break
		}
	}
	return rows, nil
}

func (repo *pagedWorkFake) IsActiveHumanMember(ctx context.Context, _, _ string) (bool, error) {
	repo.lookups++
	if repo.lookups == 2 && repo.stop != nil {
		repo.stop()
	}
	return true, ctx.Err()
}

func (*pagedWorkFake) ListRequirementsForRecovery(context.Context, string, string, int) ([]RequirementRecord, error) {
	return nil, errors.New("solicitation processor crossed into requirement budget")
}

func TestDeliveryCursorRetainsPartialProgressAndWrapsAtEnd(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	repo := &pagedWorkFake{fakeDeliveryState: newDeliveryFakeRepository(time.Now()), stop: cancel}
	service := NewService(ServiceOptions{Repository: repo, SpaceID: "spc_echo_test"})
	first, err := service.ProcessJobsWithOptions(ctx, ProcessOptions{Limit: 2, Family: DeliveryTypeSolicitation})
	if !errors.Is(err, context.Canceled) || first.Next.Solicitation != "a" || len(first.Solicitations) != 1 {
		t.Fatalf("partial cursor skipped unfinished row: %+v, %v", first, err)
	}
	repo.stop, repo.lookups = nil, 0
	second, err := service.ProcessJobsWithOptions(context.Background(), ProcessOptions{Limit: 1, Family: DeliveryTypeSolicitation, Cursor: first.Next})
	if err != nil || second.Next.Solicitation != "b" || len(second.Solicitations) != 1 {
		t.Fatalf("resume did not reach later exhausted row: %+v, %v", second, err)
	}
	last, err := service.ProcessJobsWithOptions(context.Background(), ProcessOptions{Limit: 1, Family: DeliveryTypeSolicitation, Cursor: second.Next})
	if err != nil || last.Next.Solicitation != "" || len(last.Solicitations) != 0 {
		t.Fatalf("cursor failed to wrap: %+v, %v", last, err)
	}
}
