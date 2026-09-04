package overview

import "time"

const DefaultSpaceID = "spc_default"

type Counts struct {
	Members       int64 `json:"members"`
	Conversations int64 `json:"conversations"`
	Messages      int64 `json:"messages"`
	Files         int64 `json:"files"`
	UploadedBytes int64 `json:"uploadedBytes"`
}

type Statistics struct {
	AsOf         string `json:"asOf"`
	DayStartedAt string `json:"dayStartedAt"`
	Totals       Counts `json:"totals"`
	Today        Counts `json:"today"`
}

type StatisticsRecord struct {
	Totals Counts
	Today  Counts
}

type AuditInput struct {
	ID               string
	SpaceID          string
	ActorUserID      string
	ActorGitHubLogin string
	Action           string
	TargetType       string
	TargetID         string
	Result           string
	Reason           string
	RequestID        string
	IPAddress        string
	UserAgent        string
	CreatedAt        time.Time
}
