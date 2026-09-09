//go:build postgres_integration

package messages

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestPGMarkdownSummaryReadAndStoredRetryCompatibility(t *testing.T) {
	fixture := newPGMessageIntegrationFixture(t)
	cases := []struct {
		name   string
		blocks []Block
		want   string
	}{
		{"adjacent text", []Block{{Type: "text", Text: "alpha "}, {Type: "text", Text: " beta"}}, "alpha  beta"},
		{"link", []Block{{Type: "text", Text: "[label](https://x.test)"}}, "label"},
		{"code fence", []Block{{Type: "text", Text: "```go\nx := 1\n```"}}, "x := 1"},
		{"literal underscore", []Block{{Type: "text", Text: "a_b"}}, "a_b"},
		{"whitespace block", []Block{{Type: "text", Text: "left"}, {Type: "text", Text: "\n"}, {Type: "text", Text: "right"}}, "left right"},
	}
	for index, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			input := CreateInput{
				ActorID: "usr-alice", ConversationID: "conv-messages",
				ClientMessageID: fmt.Sprintf("markdown-summary-%d", index),
				Content:         Content{Format: MessageContentFormat, PlainText: "ignored client summary", Blocks: item.blocks},
			}
			created, err := fixture.service.CreateMessage(fixture.ctx, input)
			if err != nil {
				t.Fatal(err)
			}
			if created.PlainText != item.want || created.Content.PlainText != item.want {
				t.Fatalf("create summary = %q / %q, want %q", created.PlainText, created.Content.PlainText, item.want)
			}

			// Model an existing Node-shaped JSON record using its characterized
			// summary. Replaying must compare canonical content, not rewrite rows.
			stored, err := json.Marshal(Content{Format: MessageContentFormat, PlainText: item.want, Blocks: item.blocks})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := fixture.pool.Exec(fixture.ctx, `UPDATE messages SET content_json = $2, plain_text = $3 WHERE id = $1`, created.ID, string(stored), item.want); err != nil {
				t.Fatal(err)
			}
			var before string
			if err := fixture.pool.QueryRow(fixture.ctx, `SELECT content_json::text FROM messages WHERE id = $1`, created.ID).Scan(&before); err != nil {
				t.Fatal(err)
			}
			auditsBefore := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `SELECT COUNT(*) FROM audit_logs`)
			eventsBefore := pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `SELECT COUNT(*) FROM workspace_events`)
			for attempt := 0; attempt < 2; attempt++ {
				replayed, err := fixture.service.CreateMessage(fixture.ctx, input)
				if err != nil || replayed.ID != created.ID || replayed.PlainText != item.want {
					t.Fatalf("stored retry = %q / %q, err=%v", replayed.ID, replayed.PlainText, err)
				}
			}
			items, err := fixture.service.List(fixture.ctx, ListOptions{
				ActorID: "usr-bob", ConversationID: "conv-messages", Around: created.ID, Limit: 40,
			})
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, message := range items {
				if message.ID == created.ID {
					found = true
					if message.PlainText != item.want || message.Content.PlainText != item.want {
						t.Fatalf("member read summary = %q / %q", message.PlainText, message.Content.PlainText)
					}
				}
			}
			if !found {
				t.Fatal("member read did not include the target")
			}
			var after string
			if err := fixture.pool.QueryRow(fixture.ctx, `SELECT content_json::text FROM messages WHERE id = $1`, created.ID).Scan(&after); err != nil {
				t.Fatal(err)
			}
			if after != before || pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `SELECT COUNT(*) FROM audit_logs`) != auditsBefore || pgMessageIntegrationCount(t, fixture.ctx, fixture.pool, `SELECT COUNT(*) FROM workspace_events`) != eventsBefore {
				t.Fatal("read or matching retry rewrote content or duplicated audit/events")
			}
		})
	}
}
