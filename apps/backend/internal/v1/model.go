package v1

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrForbidden     = errors.New("v1.forbidden")
	ErrNotFound      = errors.New("v1.not_found")
	ErrInvalidInput  = errors.New("v1.invalid_input")
	ErrRateLimited   = errors.New("v1.rate_limited")
	ErrProactiveDeny = errors.New("v1.proactive_disabled")
)

type SyncEvent struct {
	Seq            int64          `json:"seq"`
	Type           string         `json:"type"`
	ConversationID string         `json:"conversationId,omitempty"`
	Payload        map[string]any `json:"payload"`
	CreatedAt      string         `json:"createdAt"`
}

type SyncDeltaResponse struct {
	CurrentSeq    int64       `json:"currentSeq"`
	HasMore       bool        `json:"hasMore"`
	ResetRequired bool        `json:"resetRequired"`
	Events        []SyncEvent `json:"events"`
}

type SearchMessageHit struct {
	ID             string `json:"id"`
	ConversationID string `json:"conversationId"`
	ThreadRootID   string `json:"threadRootId,omitempty"`
	AuthorID       string `json:"authorId"`
	AuthorName     string `json:"authorName"`
	PlainText      string `json:"plainText"`
	CreatedAt      string `json:"createdAt"`
}

type SearchFileHit struct {
	ID              string `json:"id"`
	FileName        string `json:"fileName"`
	MIMEType        string `json:"mimeType"`
	ByteSize        int64  `json:"byteSize"`
	ConversationID  string `json:"conversationId,omitempty"`
	SourceMessageID string `json:"sourceMessageId,omitempty"`
	Width           *int   `json:"width,omitempty"`
	Height          *int   `json:"height,omitempty"`
	ThumbHash       string `json:"thumbHash,omitempty"`
	CreatedAt       string `json:"createdAt"`
}

type SearchResponse struct {
	Messages []SearchMessageHit `json:"messages"`
	Files    []SearchFileHit    `json:"files"`
}

type ThreadReply struct {
	ID                string `json:"id"`
	ConversationID    string `json:"conversationId"`
	ThreadRootID      string `json:"threadRootId"`
	AlsoSendToChannel bool   `json:"alsoSendToChannel"`
	AuthorID          string `json:"authorId"`
	AuthorName        string `json:"authorName"`
	PlainText         string `json:"plainText"`
	EditedAt          string `json:"editedAt,omitempty"`
	CreatedAt         string `json:"createdAt"`
}

type ThreadView struct {
	RootMessageID string        `json:"rootMessageId"`
	ThreadTitle   string        `json:"threadTitle,omitempty"`
	ReplyCount    int           `json:"replyCount"`
	Replies       []ThreadReply `json:"replies"`
}

type UserDevice struct {
	ID           string `json:"id"`
	Platform     string `json:"platform"`
	DeviceName   string `json:"deviceName"`
	AppVersion   string `json:"appVersion"`
	LastActiveAt string `json:"lastActiveAt"`
	Current      bool   `json:"current"`
}

type QRLoginSession struct {
	ID         string `json:"id"`
	Challenge  string `json:"challenge"`
	Status     string `json:"status"`
	Platform   string `json:"platform,omitempty"`
	DeviceName string `json:"deviceName,omitempty"`
	ExpiresAt  string `json:"expiresAt"`
}

type BotCommand struct {
	Command     string `json:"command"`
	Description string `json:"description"`
	Scope       string `json:"scope"`
}

type BotWebhookConfig struct {
	BotID      string `json:"botId"`
	URL        string `json:"url"`
	Enabled    bool   `json:"enabled"`
	LastStatus *int   `json:"lastStatus,omitempty"`
	LastError  string `json:"lastError,omitempty"`
}

type CardKitBlock struct {
	Type     string         `json:"type"`
	Title    string         `json:"title,omitempty"`
	Subtitle string         `json:"subtitle,omitempty"`
	Badge    string         `json:"badge,omitempty"`
	Tone     string         `json:"tone,omitempty"`
	Content  string         `json:"content,omitempty"`
	Items    []map[string]any `json:"items,omitempty"`
	PollID   string         `json:"pollId,omitempty"`
	Options  []map[string]any `json:"options,omitempty"`
	Elements []map[string]any `json:"elements,omitempty"`
}

type CardKitDocument struct {
	Version      int            `json:"version"`
	CardID       string         `json:"cardId"`
	CardType     string         `json:"cardType"`
	Status       string         `json:"status"`
	Revision     int            `json:"revision"`
	FallbackText string         `json:"fallbackText"`
	Blocks       []CardKitBlock `json:"blocks"`
}

func ValidateCardKitDocument(doc CardKitDocument) error {
	if doc.Version != 1 {
		return fmt.Errorf("%w: card version must be 1", ErrInvalidInput)
	}
	if strings.TrimSpace(doc.FallbackText) == "" {
		return fmt.Errorf("%w: fallbackText is required", ErrInvalidInput)
	}
	if len(doc.Blocks) == 0 || len(doc.Blocks) > 32 {
		return fmt.Errorf("%w: blocks must contain 1..32 items", ErrInvalidInput)
	}
	for i, block := range doc.Blocks {
		switch block.Type {
		case "header":
			if strings.TrimSpace(block.Title) == "" {
				return fmt.Errorf("%w: block[%d] header requires title", ErrInvalidInput, i)
			}
		case "markdown":
			if strings.TrimSpace(block.Content) == "" {
				return fmt.Errorf("%w: block[%d] markdown requires content", ErrInvalidInput, i)
			}
		case "fields":
			if len(block.Items) == 0 {
				return fmt.Errorf("%w: block[%d] fields requires items", ErrInvalidInput, i)
			}
		case "poll":
			if strings.TrimSpace(block.PollID) == "" || len(block.Options) < 2 {
				return fmt.Errorf("%w: block[%d] poll requires pollId and at least 2 options", ErrInvalidInput, i)
			}
		case "actions":
			if len(block.Elements) == 0 || len(block.Elements) > 8 {
				return fmt.Errorf("%w: block[%d] actions requires 1..8 elements", ErrInvalidInput, i)
			}
			for j, el := range block.Elements {
				actionID, _ := el["actionId"].(string)
				if strings.TrimSpace(actionID) == "" {
					return fmt.Errorf("%w: block[%d].elements[%d] requires non-empty actionId", ErrInvalidInput, i, j)
				}
			}
		case "divider":
			// valid separator
		default:
			return fmt.Errorf("%w: unsupported block type %q", ErrInvalidInput, block.Type)
		}
	}
	return nil
}

func SignWebhookDelivery(secret string, timestamp time.Time, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d.", timestamp.UTC().Unix())))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}
