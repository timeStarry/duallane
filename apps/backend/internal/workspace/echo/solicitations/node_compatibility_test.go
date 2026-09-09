package solicitations

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type nodeSolicitationFixture struct {
	Name           string
	Input          CreateInput
	Hash           string
	Transition     TransitionInput
	TransitionHash string
}

func loadNodeSolicitationFixtures(t *testing.T) []nodeSolicitationFixture {
	t.Helper()
	encoded, err := os.ReadFile("testdata/node-idempotency.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []nodeSolicitationFixture
	if err := json.Unmarshal(encoded, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) != 1 {
		t.Fatalf("fixture count = %d, want 1", len(fixtures))
	}
	return fixtures
}

func TestPersistedHashesMatchNodeFixtures(t *testing.T) {
	for _, fixture := range loadNodeSolicitationFixtures(t) {
		t.Run(fixture.Name, func(t *testing.T) {
			intent, err := normalizeCreateInput(fixture.Input)
			if err != nil {
				t.Fatal(err)
			}
			spaceID := fixture.Input.SpaceID
			if spaceID == "" {
				spaceID = DefaultSpaceID
			}
			if hash := createRequestHash(spaceID, fixture.Input.ActorID, intent); hash != fixture.Hash {
				t.Fatalf("create hash = %s, want %s; intent=%#v", hash, fixture.Hash, intent)
			}

			publicID, publicErr := normalizePublicID(fixture.Transition.PublicID)
			if publicErr != nil {
				t.Fatal(publicErr)
			}
			transitionSpaceID := fixture.Transition.SpaceID
			if transitionSpaceID == "" {
				transitionSpaceID = DefaultSpaceID
			}
			if hash := transitionRequestHash(transitionSpaceID, publicID, "publish", StatusOpen); hash != fixture.TransitionHash {
				t.Fatalf("transition hash = %s, want %s", hash, fixture.TransitionHash)
			}
			if !reflect.DeepEqual(intent.Options, []string{"A<&", "B"}) || intent.Deadline != nil {
				t.Fatalf("normalized Node fixture = %#v", intent)
			}
		})
	}
}
