package topics

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestParseTopicSyntaxAndNormalizeContent(t *testing.T) {
	intent, ok := parseTopicSyntax("  #[资料页](先讨论 (通知)，再讨论链接。)  ")
	if !ok {
		t.Fatal("expected balanced topic syntax")
	}
	if intent.Title != "资料页" || intent.Description != "先讨论 (通知)，再讨论链接。" {
		t.Fatalf("intent = %#v", intent)
	}
	if _, ok := parseTopicSyntax("#[未闭合](正文"); ok {
		t.Fatal("unclosed syntax was accepted")
	}
	if _, ok := parseTopicSyntax("前缀 #[标题](正文)"); ok {
		t.Fatal("non-leading syntax was accepted")
	}

	content, validationErr := normalizeContent(Content{
		Format: MessageContentFormat,
		Blocks: []Block{
			{Type: "text", Text: "  hello\x00 "},
			{Type: "mention", UserID: "usr_member", Label: "成员"},
			{Type: "link", URL: "https://example.test/docs", Label: "文档"},
			{Type: "emoji", Shortcode: "wave"},
		},
	})
	if validationErr != nil {
		t.Fatalf("normalizeContent: %v", validationErr)
	}
	if content.PlainText != "hello @成员文档:wave:" {
		t.Fatalf("plain text = %q", content.PlainText)
	}
	if strings.Contains(content.Blocks[0].Text, "\x00") {
		t.Fatal("control character survived content normalization")
	}
	if _, validationErr := normalizeContent(Content{Format: MessageContentFormat, Blocks: []Block{{Type: "mention"}}}); validationErr == nil || validationErr.Code != CodeTopicInvalidMention {
		t.Fatalf("mention-only content error = %#v", validationErr)
	}
	if _, validationErr := normalizeContent(Content{Format: MessageContentFormat, Blocks: []Block{{Type: "link", URL: "javascript:alert(1)"}}}); validationErr == nil || validationErr.Code != CodeTopicInvalidLink {
		t.Fatalf("unsafe link error = %#v", validationErr)
	}
}

func TestTopicProjectionUsesSafeFieldsAndMillisecondUTC(t *testing.T) {
	created := time.Date(2026, 9, 4, 10, 0, 0, 123456789, time.FixedZone("CST", 8*60*60))
	nickname := "首选名"
	remark := "备注名"
	avatar := "https://avatars.githubusercontent.com/u/42"
	service := NewService(ServiceOptions{SpaceID: "space-test"})
	record := TopicRecord{
		ID:                 "top-1",
		SpaceID:            "space-test",
		ConversationID:     "conv-1",
		Title:              "安全话题",
		Description:        "完整正文不应出现在摘要",
		CreatedBy:          "usr-1",
		Status:             StatusOpen,
		AllowSyncToGroup:   true,
		Revision:           2,
		CreatedAt:          created,
		UpdatedAt:          created.Add(time.Second),
		CreatorDisplayName: "公开名",
		CreatorNickname:    &nickname,
		CreatorRemark:      &remark,
		CreatorGitHubLogin: "github-login",
		CreatorAvatarURL:   &avatar,
		ParticipantCount:   2,
		Joined:             false,
	}
	summary := service.projectTopic(record, "usr-viewer", false)
	if summary.Description != nil || summary.DescriptionPreview == nil || *summary.DescriptionPreview != "完整正文不应出现在摘要" {
		t.Fatalf("summary projection = %#v", summary)
	}
	if summary.CreatedAt != "2026-09-04T02:00:00.123Z" || summary.UpdatedAt != "2026-09-04T02:00:01.123Z" {
		t.Fatalf("timestamps = %q %q", summary.CreatedAt, summary.UpdatedAt)
	}
	if summary.Creator.DisplayName != "备注名" || summary.Creator.Nickname == nil || summary.Creator.AvatarURL == nil {
		t.Fatalf("creator projection = %#v", summary.Creator)
	}
	full := service.projectTopic(record, "usr-viewer", true)
	encoded, err := json.Marshal(full)
	if err != nil {
		t.Fatal(err)
	}
	serialized := string(encoded)
	if !strings.Contains(serialized, `"description":"完整正文不应出现在摘要"`) {
		t.Fatalf("full projection omitted description: %s", serialized)
	}
	if strings.Contains(serialized, "email") || strings.Contains(serialized, "github_id") {
		t.Fatalf("private identity leaked: %s", serialized)
	}
}

func TestIDFactoryFailureFailsClosed(t *testing.T) {
	failure := errors.New("entropy unavailable")
	service := NewService(ServiceOptions{IDFactory: func() (string, error) { return "", failure }})
	if _, err := service.newID("topic"); !errors.Is(err, failure) {
		t.Fatalf("newID error = %v", err)
	}
	service = NewService(ServiceOptions{IDFactory: func() (string, error) { return "", nil }})
	if _, err := service.newID("topic"); err == nil {
		t.Fatal("empty generated ID was accepted")
	}
}

func TestIdempotencyKeyAllowsNodeCompatiblePunctuation(t *testing.T) {
	for _, value := range []string{".retry-key", ":retry", "-retry", "_retry", "client:1"} {
		if normalized, validationErr := normalizeIdempotencyKey(value); validationErr != nil || normalized != value {
			t.Fatalf("key %q normalized=%q error=%#v", value, normalized, validationErr)
		}
	}
	if _, validationErr := normalizeIdempotencyKey("bad key"); validationErr == nil || validationErr.Code != CodeTopicInvalidIdempotency {
		t.Fatalf("invalid key error = %#v", validationErr)
	}
}
