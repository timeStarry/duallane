package solicitations

import (
	"context"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/auth"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
)

type cardTransactionView struct {
	cards.Tx
	solicitation Tx
}

func (v cardTransactionView) SolicitationTransaction() Tx { return v.solicitation }

type unusedSolicitationTx struct{ Tx }

type transactionOnlyCardAdapter struct {
	t                  *testing.T
	want               Tx
	votes, projections int
}

func (a *transactionOnlyCardAdapter) Vote(context.Context, VoteInput) (*Solicitation, error) {
	a.t.Fatal("card action opened an ordinary vote transaction")
	return nil, nil
}

func (a *transactionOnlyCardAdapter) ProjectCard(context.Context, GetInput) (*CardProjection, error) {
	a.t.Fatal("card action projected outside its transaction")
	return nil, nil
}

func (a *transactionOnlyCardAdapter) VoteInTx(_ context.Context, tx Tx, input VoteInput) (*Solicitation, error) {
	if tx != a.want || input.ExpectedRevision != 7 || !input.ExpectedRevisionPresent {
		a.t.Fatalf("vote transaction or Node card revision changed: %+v", input)
	}
	a.votes++
	return &Solicitation{PublicID: input.PublicID}, nil
}

func (a *transactionOnlyCardAdapter) ProjectCardInTx(_ context.Context, tx Tx, _ GetInput) (*CardProjection, error) {
	if tx != a.want {
		a.t.Fatal("projection used a different transaction")
	}
	a.projections++
	return &CardProjection{Payload: map[string]any{"revision": 8}}, nil
}

func TestSolicitationCardActionRequiresOneTypedTransactionView(t *testing.T) {
	tx := &unusedSolicitationTx{}
	adapter := &transactionOnlyCardAdapter{t: t, want: tx}
	execute := NewCardDefinition(adapter).Actions["vote"].Execute
	action := cards.CardActionContext{
		Actor:   &auth.Actor{ID: "usr-member", Kind: "human", Role: "member"},
		Card:    cards.Card{SpaceID: DefaultSpaceID, Revision: 7},
		Payload: map[string]any{"publicId": "SOL-2026-0001", "revision": 99},
		Input:   map[string]any{"optionIds": []string{"opt-1"}, "idempotencyKey": "vote-1"},
	}
	for _, missing := range []cards.Tx{nil, cardTransactionView{}} {
		action.Tx = missing
		if _, err := execute(context.Background(), action); pgCodeForCard(err) != CodeInternal {
			t.Fatalf("missing typed transaction accepted: %v", err)
		}
	}
	if adapter.votes != 0 || adapter.projections != 0 {
		t.Fatal("missing bridge caused a domain operation")
	}
	action.Tx = cardTransactionView{solicitation: tx}
	if _, err := execute(context.Background(), action); err != nil {
		t.Fatal(err)
	}
	if adapter.votes != 1 || adapter.projections != 1 {
		t.Fatal("action did not share one vote/projection transaction")
	}
}

func pgCodeForCard(err error) string {
	if domain := asDomainError(err); domain != nil {
		return domain.Code
	}
	return ""
}
