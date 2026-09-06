package requirements

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type nodeRequirementFixture struct {
	Name           string
	Input          SubmitInput
	RelatedLink    *string
	Hash           string
	Transition     TransitionInput
	TransitionHash string
	Error          string
}

func loadNodeRequirementFixtures(t *testing.T) []nodeRequirementFixture {
	t.Helper()
	encoded, err := os.ReadFile("testdata/node-idempotency.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []nodeRequirementFixture
	if err := json.Unmarshal(encoded, &fixtures); err != nil {
		t.Fatal(err)
	}
	if len(fixtures) != 15 {
		t.Fatalf("fixture count = %d", len(fixtures))
	}
	var presence []struct {
		Transition struct{ DuplicateOfPublicID *string }
	}
	if err := json.Unmarshal(encoded, &presence); err != nil {
		t.Fatal(err)
	}
	for index := range fixtures {
		fixtures[index].Transition.DuplicateOfPublicIDSet = presence[index].Transition.DuplicateOfPublicID != nil
	}
	return fixtures
}

func TestPersistedHashesMatchNodeFixtures(t *testing.T) {
	fixtures := loadNodeRequirementFixtures(t)
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			normalized, err := normalizeSubmission(fixture.Input)
			// Node's historical hostname regex misses bracketed IPv6. Do not
			// reproduce that private-link bypass in the new implementation.
			if fixture.Name == "private-ipv6" {
				if err == nil || err.Code != CodeRelatedLinkInvalid {
					t.Fatalf("private IPv6 accepted: %v", err)
				}
				return
			}
			if fixture.Error != "" {
				if err == nil || err.Code != fixture.Error {
					t.Fatalf("error = %v, want %s", err, fixture.Error)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(normalized.RelatedLink, fixture.RelatedLink) {
				t.Errorf("normalized link = %q, want %q", stringValue(normalized.RelatedLink), stringValue(fixture.RelatedLink))
			}
			if hash := submitRequestHash(fixture.Input.SpaceID, fixture.Input.ActorID, normalized); hash != fixture.Hash {
				t.Errorf("submit hash = %s, want %s", hash, fixture.Hash)
			}
			target, targetErr := normalizeTargetInput(fixture.Transition)
			if targetErr != nil {
				t.Fatal(targetErr)
			}
			input := fixture.Transition
			duplicateID := nullableString(input.DuplicateOfPublicID)
			if input.DuplicateOfPublicIDSet {
				duplicateID = &input.DuplicateOfPublicID
			}
			if hash := transitionRequestHash(input.SpaceID, input.PublicID, target, input.ExpectedRevision, &input.Response, duplicateID); hash != fixture.TransitionHash {
				t.Errorf("transition hash = %s, want %s", hash, fixture.TransitionHash)
			}
		})
	}
}
