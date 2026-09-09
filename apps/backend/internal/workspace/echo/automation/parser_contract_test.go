package automation

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/interactions"
)

type nodeParserFixture struct {
	Cases []nodeParserCase `json:"cases"`
}

type nodeParserCase struct {
	Name   string                `json:"name"`
	Kind   string                `json:"kind"`
	Prefix string                `json:"prefix"`
	Value  string                `json:"value"`
	Suffix string                `json:"suffix"`
	Count  int                   `json:"count"`
	Expect nodeParserExpectation `json:"expect"`
}

type nodeParserExpectation struct {
	OK   bool   `json:"ok"`
	Type string `json:"type,omitempty"`
	Code string `json:"code,omitempty"`
}

func TestNodeParserBoundaryFixture(t *testing.T) {
	fixture := loadNodeParserFixture(t)
	for _, testCase := range fixture.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			got := nodeParserExpectation{}
			parsed, err := parseRequirementWorkflowArguments(nodeParserInput(testCase))
			if err != nil {
				var interactionErr *interactions.Error
				if !errors.As(err, &interactionErr) || interactionErr == nil {
					t.Fatalf("parser error = %v (%T)", err, err)
				}
				got.Code = interactionErr.Code
			} else {
				got.OK = true
				arguments, ok := parsed.(map[string]any)
				if !ok {
					t.Fatalf("parser result = %T, want map[string]any", parsed)
				}
				got.Type, _ = arguments["type"].(string)
			}
			if got != testCase.Expect {
				t.Fatalf("Go parser result = %#v, want Node fixture %#v", got, testCase.Expect)
			}
		})
	}
}

func loadNodeParserFixture(t *testing.T) nodeParserFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "node-parser-boundaries.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture nodeParserFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func nodeParserInput(testCase nodeParserCase) string {
	switch testCase.Kind {
	case "wrapped":
		return testCase.Prefix + testCase.Value + testCase.Suffix
	case "quoted-repeat":
		return `"` + strings.Repeat(testCase.Value, testCase.Count) + `"`
	case "repeat":
		return strings.Repeat(testCase.Value, testCase.Count)
	default:
		panic("unknown parser fixture kind: " + testCase.Kind)
	}
}
