package topics

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
)

func TestTopicCardDefinitionsMatchActualNode(t *testing.T) {
	raw, err := os.ReadFile("testdata/cards-node.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name, CardType    string
		Payload, Expected any
		Error             *struct{ Code, Message string }
	}
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	registry, err := cards.NewRegistry(CardDefinitions()...)
	if err != nil {
		t.Fatal(err)
	}
	if len(fixtures) != 27 {
		t.Fatalf("corpus count=%d", len(fixtures))
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			definition := registry.Get(fixture.CardType, 1)
			if definition == nil || definition.AllowPublicURLs || len(definition.Actions) != 0 {
				t.Fatal("unsafe topic registry definition")
			}
			got, err := definition.ValidatePayload(fixture.Payload)
			if fixture.Error != nil {
				var denied *cards.CardValidationError
				if !errors.As(err, &denied) || denied.Code != fixture.Error.Code || denied.Message != fixture.Error.Message {
					t.Fatalf("error=%v expected=%+v", err, fixture.Error)
				}
				return
			}
			if err != nil || !reflect.DeepEqual(got, fixture.Expected) {
				t.Fatalf("got=%+v expected=%+v err=%v", got, fixture.Expected, err)
			}
		})
	}
}
