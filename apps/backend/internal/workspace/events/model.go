package events

import (
	"encoding/json"
	"time"
)

const (
	DefaultSpaceID         = "spc_default"
	DefaultReplayLimit     = 200
	MaxReplayLimit         = 200
	DefaultBatchSize       = 256
	MaxBatchSize           = 1000
	MaxPayloadBytes        = 256 * 1024
	EventVersion           = 1
	SyncReasonCursorAhead  = "cursor_ahead"
	SyncReasonReplayLimit  = "replay_limit"
	SyncReasonReplayWindow = "replay_window_exceeded"
)

// EventRecord is the storage representation. It intentionally has no JSON
// tags: payload JSON and nullable database columns must not cross a transport
// boundary without the event projection below.
type EventRecord struct {
	ID             string
	SpaceID        string
	Seq            int64
	Type           string
	ActorID        *string
	ConversationID *string
	TargetType     *string
	TargetID       *string
	PayloadJSON    []byte
	CreatedAt      time.Time
}

// EventTarget is the small target reference used by the existing realtime
// envelope. It deliberately uses id (rather than the storage target_id key).
type EventTarget struct {
	Type string  `json:"type"`
	ID   *string `json:"id"`
}

// Event is the safe, actor-specific event projection. Actor and target
// references remain nullable to preserve the current JSON contract.
type Event struct {
	ID             string         `json:"id"`
	SpaceID        string         `json:"spaceId"`
	Seq            int64          `json:"seq"`
	Type           string         `json:"type"`
	ActorID        *string        `json:"actorId"`
	ConversationID *string        `json:"conversationId"`
	TargetType     *string        `json:"targetType"`
	TargetID       *string        `json:"targetId"`
	Target         *EventTarget   `json:"target"`
	Payload        map[string]any `json:"payload"`
	CreatedAt      string         `json:"createdAt"`
}

// ReplayInput identifies the actor and cursor for one bounded replay batch.
// The actor is looked up from storage for every call; callers cannot supply an
// authorization snapshot.
type ReplayInput struct {
	ActorID string
	LastSeq int64
	Limit   int
}

// ReplayResult is suitable for a WebSocket ready/sync projection. Events are
// ordered by seq and already filtered for the actor.
type ReplayResult struct {
	Events       []Event `json:"events"`
	CurrentSeq   int64   `json:"currentSeq"`
	ReplayFrom   int64   `json:"replayFrom"`
	ReplayCount  int     `json:"replayCount"`
	HasMore      bool    `json:"hasMore"`
	SyncRequired bool    `json:"syncRequired"`
	Reason       string  `json:"reason,omitempty"`
}

// ParsePayloadObject accepts only an existing JSON object. Malformed or
// scalar payloads become an empty object, keeping one bad row from exposing a
// database/provider error or breaking the entire replay stream.
func ParsePayloadObject(raw []byte) map[string]any {
	var value map[string]any
	if len(raw) == 0 || len(raw) > MaxPayloadBytes || json.Unmarshal(raw, &value) != nil || value == nil {
		return map[string]any{}
	}
	return value
}

func formatTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z")
}
