package solicitations

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// nodePair/nodeObject preserve the insertion order used by the Node
// echo-solicitations service. Go's encoding/json ordering and HTML escaping
// are intentionally not used for persisted idempotency hashes.
type nodePair struct {
	key   string
	value any
}

type nodeObject []nodePair

func createRequestHash(spaceID, actorID string, intent createIntent) string {
	var deadline any
	if intent.Deadline != nil {
		deadline = formatTime(*intent.Deadline)
	}
	return hashNodeJSON(nodeObject{
		{key: "spaceId", value: spaceID},
		{key: "actorId", value: actorID},
		{key: "title", value: intent.Title},
		{key: "description", value: intent.Description},
		{key: "question", value: intent.Question},
		{key: "options", value: intent.Options},
		{key: "choiceMode", value: intent.ChoiceMode},
		{key: "minSelections", value: intent.MinSelections},
		{key: "maxSelections", value: intent.MaxSelections},
		{key: "allowVoteChange", value: intent.AllowVoteChange},
		{key: "resultVisibility", value: intent.ResultVisibility},
		{key: "deliveryPolicy", value: intent.DeliveryPolicy},
		{key: "deadline", value: deadline},
	})
}

func transitionRequestHash(spaceID, publicID, operation, targetStatus string) string {
	return hashNodeJSON(nodeObject{
		{key: "spaceId", value: spaceID},
		{key: "publicId", value: publicID},
		{key: "operation", value: operation},
		{key: "targetStatus", value: targetStatus},
	})
}

func voteRequestHash(spaceID, publicID string, optionIDs []string, expectedRevision int64) string {
	return voteRequestHashWithPresence(spaceID, publicID, optionIDs, positiveRevision(expectedRevision))
}

func voteRequestHashWithPresence(spaceID, publicID string, optionIDs []string, expectedRevision *int64) string {
	var expected any
	if expectedRevision != nil {
		expected = *expectedRevision
	}
	return hashNodeJSON(nodeObject{
		{key: "spaceId", value: spaceID},
		{key: "publicId", value: publicID},
		{key: "optionIds", value: optionIDs},
		{key: "expectedRevision", value: expected},
	})
}

func positiveRevision(value int64) *int64 {
	if value <= 0 {
		return nil
	}
	normalized := value
	return &normalized
}

func hashNodeJSON(value any) string {
	encoded := nodeJSONString(value)
	sum := sha256.Sum256([]byte(encoded))
	return hex.EncodeToString(sum[:])
}

func nodeJSONString(value any) string {
	var builder strings.Builder
	writeNodeJSON(&builder, value)
	return builder.String()
}

func writeNodeJSON(builder *strings.Builder, value any) {
	switch typed := value.(type) {
	case nil:
		builder.WriteString("null")
	case string:
		writeNodeJSONString(builder, typed)
	case bool:
		if typed {
			builder.WriteString("true")
		} else {
			builder.WriteString("false")
		}
	case int:
		builder.WriteString(fmt.Sprintf("%d", typed))
	case int64:
		builder.WriteString(fmt.Sprintf("%d", typed))
	case int32:
		builder.WriteString(fmt.Sprintf("%d", typed))
	case []string:
		builder.WriteByte('[')
		for index, item := range typed {
			if index > 0 {
				builder.WriteByte(',')
			}
			writeNodeJSON(builder, item)
		}
		builder.WriteByte(']')
	case []any:
		builder.WriteByte('[')
		for index, item := range typed {
			if index > 0 {
				builder.WriteByte(',')
			}
			writeNodeJSON(builder, item)
		}
		builder.WriteByte(']')
	case nodeObject:
		builder.WriteByte('{')
		for index, pair := range typed {
			if index > 0 {
				builder.WriteByte(',')
			}
			writeNodeJSONString(builder, pair.key)
			builder.WriteByte(':')
			writeNodeJSON(builder, pair.value)
		}
		builder.WriteByte('}')
	case time.Time:
		writeNodeJSONString(builder, formatTime(typed))
	default:
		// The hash inputs above are deliberately closed over primitive values.
		// Keep an invalid future value deterministic rather than silently using
		// Go's different JSON escaping rules.
		writeNodeJSONString(builder, fmt.Sprint(typed))
	}
}

func writeNodeJSONString(builder *strings.Builder, value string) {
	builder.WriteByte('"')
	for _, character := range value {
		switch character {
		case '"':
			builder.WriteString(`\"`)
		case '\\':
			builder.WriteString(`\\`)
		case '\b':
			builder.WriteString(`\b`)
		case '\f':
			builder.WriteString(`\f`)
		case '\n':
			builder.WriteString(`\n`)
		case '\r':
			builder.WriteString(`\r`)
		case '\t':
			builder.WriteString(`\t`)
		default:
			if character < 0x20 {
				fmt.Fprintf(builder, `\u%04x`, character)
			} else {
				// JSON.stringify leaves <, >, &, U+2028 and U+2029 as
				// literal UTF-8. This is the compatibility-sensitive part.
				builder.WriteRune(character)
			}
		}
	}
	builder.WriteByte('"')
}
