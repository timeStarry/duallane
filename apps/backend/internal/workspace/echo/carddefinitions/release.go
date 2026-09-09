package carddefinitions

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/timestarry/duallane/apps/backend/internal/workspace/cards"
	"github.com/timestarry/duallane/apps/backend/internal/workspace/echo/releases"
)

// ValidateReleaseCardPayload is the shared-card adapter for the active Node
// validateReleaseCardPayload contract. The release domain remains the source
// of truth for guide shape and limits; this adapter only converts its safe
// public map to the card registry's validation error type.
func ValidateReleaseCardPayload(payload any) (any, error) {
	object, ok := payload.(map[string]any)
	if !ok {
		return nil, releaseCardValidationError()
	}
	guide, err := releaseGuideFromPayload(object)
	if err != nil {
		return nil, releaseCardValidationError()
	}
	catalog, err := releases.NewGuideCatalog([]releases.Guide{guide})
	if err != nil {
		return nil, releaseCardValidationError()
	}
	normalized, ok := catalog.Guide(guide.Version)
	if !ok {
		return nil, releaseCardValidationError()
	}
	publishedAt, err := normalizePublishedAt(object["publishedAt"])
	if err != nil {
		return nil, err
	}
	return releasePayloadMap(normalized, publishedAt), nil
}

func releaseDefinition() cards.CardDefinition {
	return cards.CardDefinition{
		CardType:      releases.CardType,
		SchemaVersion: releases.CardSchemaVersion,
		// Node omits allowPublicUrls and limits for this definition, so the
		// shared registry supplies false and its normal default limits.
		ValidatePayload: ValidateReleaseCardPayload,
	}
}

func releaseGuideFromPayload(payload map[string]any) (releases.Guide, error) {
	sectionsValue, ok := payload["sections"].([]any)
	if !ok {
		return releases.Guide{}, errReleasePayload()
	}
	sections := make([]releases.GuideSection, len(sectionsValue))
	for index, sectionValue := range sectionsValue {
		section, ok := sectionValue.(map[string]any)
		if !ok {
			return releases.Guide{}, errReleasePayload()
		}
		itemsValue, ok := section["items"].([]any)
		if !ok {
			return releases.Guide{}, errReleasePayload()
		}
		items := make([]releases.GuideItem, len(itemsValue))
		for itemIndex, itemValue := range itemsValue {
			item, ok := itemValue.(map[string]any)
			if !ok {
				return releases.Guide{}, errReleasePayload()
			}
			items[itemIndex] = releases.GuideItem{
				Title:       releaseString(item["title"]),
				Description: releaseString(item["description"]),
				Location:    releaseString(item["location"]),
			}
		}
		sections[index] = releases.GuideSection{Title: releaseString(section["title"]), Items: items}
	}
	return releases.Guide{
		Version:    releaseString(payload["version"]),
		ReleasedAt: releaseString(payload["releasedAt"]),
		Title:      releaseString(payload["title"]),
		Summary:    releaseString(payload["summary"]),
		Sections:   sections,
	}, nil
}

func releaseString(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func normalizePublishedAt(value any) (string, error) {
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return "", errReleasePayload()
	}
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(text))
	if err != nil {
		return "", &cards.CardValidationError{Code: releases.CodeGuideInvalid, Message: "版本发布时间无效"}
	}
	return parsed.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z"), nil
}

func releasePayloadMap(guide releases.Guide, publishedAt string) map[string]any {
	data, _ := json.Marshal(guide)
	var payload map[string]any
	_ = json.Unmarshal(data, &payload)
	payload["publishedAt"] = publishedAt
	return payload
}

func releaseCardValidationError() error {
	return &cards.CardValidationError{Code: releases.CodeGuideInvalid, Message: releases.MessageGuideInvalid}
}

func errReleasePayload() error { return releaseCardValidationError() }
