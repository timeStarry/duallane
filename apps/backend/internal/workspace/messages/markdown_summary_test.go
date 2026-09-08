package messages

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

type nodeMarkdownFixture struct {
	SchemaVersion int `json:"schemaVersion"`
	Cases         []struct {
		Name     string `json:"name"`
		Source   string `json:"source"`
		Expected string `json:"expected"`
	} `json:"cases"`
	Joins []struct {
		Name     string   `json:"name"`
		Sources  []string `json:"sources"`
		Expected string   `json:"expected"`
	} `json:"joins"`
}

func loadNodeMarkdownFixture(t *testing.T) nodeMarkdownFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/markdown-summary.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture nodeMarkdownFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SchemaVersion != 1 || len(fixture.Cases) == 0 || len(fixture.Joins) == 0 {
		t.Fatal("missing Node Markdown contract cases")
	}
	return fixture
}

func TestNodeMarkdownSummaryGolden(t *testing.T) {
	fixture := loadNodeMarkdownFixture(t)
	for _, test := range fixture.Cases {
		t.Run(test.Name, func(t *testing.T) {
			// The production parser is shared by concurrent HTTP/event readers.
			t.Parallel()
			if got := nodeMarkdownSummary(test.Source); got != test.Expected {
				t.Errorf("source=%q\nGo=%q\nNode=%q", test.Source, got, test.Expected)
			}
		})
	}
}

func TestNodeMarkdownSummaryBlockJoins(t *testing.T) {
	fixture := loadNodeMarkdownFixture(t)
	for _, test := range fixture.Joins {
		t.Run(test.Name, func(t *testing.T) {
			blocks := make([]Block, 0, len(test.Sources))
			for _, source := range test.Sources {
				blocks = append(blocks, Block{Type: "text", Text: source})
			}
			if got := ProjectPlainText(blocks); got != test.Expected {
				t.Errorf("blocks=%q\nGo=%q\nNode=%q", test.Sources, got, test.Expected)
			}
		})
	}
}

func FuzzNodeMarkdownSummaryBounded(f *testing.F) {
	for _, source := range []string{
		"", "[label](https://x.test)", "```go\nx := 1\n```", "\x00&notit; &#128;",
		strings.Repeat("&amp;", MaxMessageTextCodePoints/5),
		strings.Repeat("*", MaxMessageTextCodePoints),
		strings.Repeat("> ", 500) + "nested",
		strings.Repeat("😀", MaxMessageTextBytes/4),
	} {
		f.Add(source)
	}
	f.Fuzz(func(t *testing.T, source string) {
		if len(source) > MaxMessageTextBytes || !utf8.ValidString(source) || utf8.RuneCountInString(source) > MaxMessageTextCodePoints {
			t.Skip()
		}
		first := nodeMarkdownSummary(source)
		if !utf8.ValidString(first) || nodeMarkdownSummary(source) != first {
			t.Fatal("bounded Markdown summary is invalid or nondeterministic")
		}
	})
}

func TestPlainTextPreservesProjectedNonTextBlockBoundaries(t *testing.T) {
	for _, item := range []struct {
		block Block
		want  string
	}{
		{Block{Type: "mention", Label: " Ada "}, "left@ Ada right"},
		{Block{Type: "link", Label: " ", URL: "https://x.test"}, "left right"},
		{Block{Type: "link", URL: "https://x.test"}, "lefthttps://x.testright"},
		{Block{Type: "emoji", Shortcode: "custom:fixture"}, "left[表情]right"},
		{Block{Type: "emoji", Shortcode: "Custom:fixture"}, "left:Custom:fixture:right"},
		{Block{Type: "topic_reference", Title: " Topic "}, "left# Topic right"},
		{Block{Type: "card", FallbackText: " fallback "}, "left fallback right"},
	} {
		blocks := []Block{{Type: "text", Text: "left"}, item.block, {Type: "text", Text: "right"}}
		if got := ProjectPlainText(blocks); got != item.want {
			t.Errorf("%s summary = %q, want %q", item.block.Type, got, item.want)
		}
	}
}
