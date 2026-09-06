package topics

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
)

// CardDefinitions projects only the Node topic card contract. Generic card
// authorization still requires active Workspace and conversation membership;
// these definitions do not grant access to the private topic message stream.
func CardDefinitions() []cards.CardDefinition {
	limits := cards.Limits{MaxPayloadBytes: 16 * 1024, MaxTextBytes: 8 * 1024}
	return []cards.CardDefinition{
		{CardType: TopicCardType, SchemaVersion: TopicCardSchemaVersion, ValidatePayload: validateCreatedCard, Limits: limits},
		{CardType: TopicSyncCardType, SchemaVersion: TopicCardSchemaVersion, ValidatePayload: validateSyncedCard, Limits: limits},
	}
}

func validateCreatedCard(value any) (any, error) {
	payload, ok := value.(map[string]any)
	if !ok {
		return nil, invalidTopicCard(false)
	}
	title, err := normalizeTitle(cardString(payload["title"]))
	if err != nil {
		return nil, &cards.CardValidationError{Code: err.Code, Message: err.Message}
	}
	topicID := strings.TrimFunc(cardString(payload["topicId"]), isSpace)
	status := strings.TrimFunc(cardString(payload["status"]), isSpace)
	countValue, exists := payload["participantCount"]
	count := topicCardNumber(countValue, false)
	if !exists || !validReferenceID(topicID) || !validStatus(status) || math.IsNaN(count) || count < 0 || count > 1_000_000 || count != math.Trunc(count) {
		return nil, invalidTopicCard(false)
	}
	allowSync, _ := payload["allowSyncToGroup"].(bool)
	return map[string]any{
		"topicId": topicID, "title": title, "descriptionPreview": summarize(cardString(payload["descriptionPreview"])),
		"participantCount": count, "status": status, "allowSyncToGroup": allowSync,
	}, nil
}

func validateSyncedCard(value any) (any, error) {
	payload, ok := value.(map[string]any)
	if !ok {
		return nil, invalidTopicCard(true)
	}
	topicID := strings.TrimFunc(cardString(payload["topicId"]), isSpace)
	messageID := strings.TrimFunc(cardString(payload["topicMessageId"]), isSpace)
	projectionID := strings.TrimFunc(cardString(payload["projectionId"]), isSpace)
	projectionType := cardString(payload["projectionType"])
	title := strings.TrimFunc(strings.Map(func(r rune) rune {
		if r <= 8 || r == 11 || r == 12 || r >= 14 && r <= 31 || r == 127 {
			return -1
		}
		return r
	}, cardString(payload["title"])), isSpace)
	status := strings.TrimFunc(cardString(payload["status"]), isSpace)
	if !validReferenceID(topicID) || !validReferenceID(messageID) || !validReferenceID(projectionID) || projectionType != "group_sync" || title == "" || utf8.RuneCountInString(title) > 128 || strings.ContainsAny(title, "[]\r\n") || !validStatus(status) {
		return nil, invalidTopicCard(true)
	}
	return map[string]any{
		"topicId": topicID, "topicMessageId": messageID, "projectionId": projectionID, "projectionType": projectionType,
		"title": title, "messagePreview": summarize(cardString(payload["messagePreview"])), "status": status,
	}, nil
}

func cardString(value any) string { text, _ := value.(string); return text }

func invalidTopicCard(synced bool) error {
	message := "话题卡片数据无效"
	if synced {
		message = "话题同步卡片数据无效"
	}
	return &cards.CardValidationError{Code: "card.domain_invalid", Message: message}
}

var topicCardDecimal = regexp.MustCompile(`^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

// The Node definition applies Number(value), including JSON null, booleans and
// single-item arrays. Generic card limits bound nesting before this callback.
func topicCardNumber(value any, arrayItem bool) float64 {
	switch value := value.(type) {
	case nil:
		return 0
	case bool:
		if arrayItem {
			return math.NaN()
		}
		if value {
			return 1
		}
		return 0
	case float64:
		return value
	case []any:
		if len(value) == 0 {
			return 0
		}
		if len(value) == 1 {
			return topicCardNumber(value[0], true)
		}
	case string:
		value = strings.TrimFunc(value, isSpace)
		if value == "" {
			return 0
		}
		if len(value) > 2 && value[0] == '0' {
			base := 0
			switch value[1] {
			case 'x', 'X':
				base = 16
			case 'b', 'B':
				base = 2
			case 'o', 'O':
				base = 8
			}
			if base != 0 {
				parsed, err := strconv.ParseUint(value[2:], base, 64)
				if err == nil {
					return float64(parsed)
				}
				return math.NaN()
			}
		}
		if topicCardDecimal.MatchString(value) {
			parsed, err := strconv.ParseFloat(value, 64)
			if err == nil {
				return parsed
			}
		}
	}
	return math.NaN()
}
