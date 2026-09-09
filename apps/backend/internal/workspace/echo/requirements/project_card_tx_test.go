package requirements

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func TestProjectCardInTxMatchesProjectCardWithoutLeavingCallerTransaction(t *testing.T) {
	repo := newFakeRepository()
	service := testService(repo, fixedTestTime(), sequenceFactory())
	created, err := service.Submit(context.Background(), testSubmitInput("usr_member", "project-card-tx"))
	if err != nil {
		t.Fatal(err)
	}
	input := GetInput{
		ActorID:  "usr_member",
		SpaceID:  DefaultSpaceID,
		PublicID: created.PublicID,
		CardType: CardTypeRequirementStatus,
	}
	want, err := service.ProjectCard(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}

	var got *CardProjection
	err = repo.WithTx(context.Background(), func(tx Tx) error {
		var projectErr error
		got, projectErr = service.ProjectCardInTx(context.Background(), tx, input)
		return projectErr
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("transactional card projection differs:\n got: %#v\nwant: %#v", got, want)
	}
}

func fixedTestTime() (now time.Time) {
	return time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC)
}
