package p2p

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
)

const (
	SecureEnvelopeVersion = 1
	MaxEnvelopeValueBytes = 16_384
)

var (
	ErrInvalidMessage  = errors.New("invalid p2p message")
	ErrInvalidEnvelope = errors.New("invalid secure envelope")
	base64URLPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

// SecureEnvelope is the only non-system frame that P2P relays. The server
// treats nonce and ciphertext as opaque strings and never decodes them.
type SecureEnvelope struct {
	Type       string `json:"type"`
	Version    int    `json:"v"`
	Channel    string `json:"channel"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type clientMessage struct {
	Type       string  `json:"type"`
	Version    float64 `json:"v"`
	Channel    string  `json:"channel"`
	Nonce      string  `json:"nonce"`
	Ciphertext string  `json:"ciphertext"`
}

type ClientMessageKind uint8

const (
	ClientMessageInvalid ClientMessageKind = iota
	ClientMessageLeave
	ClientMessageSecure
)

type ClientMessage struct {
	Kind     ClientMessageKind
	Envelope SecureEnvelope
}

// ParseClientMessage validates only the protocol shape. It does not attempt to
// inspect or decrypt the payload represented by ciphertext.
func ParseClientMessage(raw []byte) (ClientMessage, error) {
	if len(raw) == 0 {
		return ClientMessage{}, ErrInvalidMessage
	}
	var message clientMessage
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&message); err != nil {
		return ClientMessage{}, ErrInvalidMessage
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return ClientMessage{}, ErrInvalidMessage
	}

	switch message.Type {
	case "leave":
		return ClientMessage{Kind: ClientMessageLeave}, nil
	case "secure":
		if message.Version != SecureEnvelopeVersion || message.Version != float64(int(message.Version)) {
			return ClientMessage{}, ErrInvalidEnvelope
		}
		if !isAllowedChannel(message.Channel) || !isSafeBase64URL(message.Nonce) || !isSafeBase64URL(message.Ciphertext) {
			return ClientMessage{}, ErrInvalidEnvelope
		}
		return ClientMessage{
			Kind: ClientMessageSecure,
			Envelope: SecureEnvelope{
				Type:       "secure",
				Version:    SecureEnvelopeVersion,
				Channel:    message.Channel,
				Nonce:      message.Nonce,
				Ciphertext: message.Ciphertext,
			},
		}, nil
	default:
		return ClientMessage{}, ErrInvalidMessage
	}
}

func isAllowedChannel(channel string) bool {
	switch channel {
	case "signal", "ws-chat", "profile":
		return true
	default:
		return false
	}
}

func isSafeBase64URL(value string) bool {
	return len(value) > 0 && len(value) <= MaxEnvelopeValueBytes && base64URLPattern.MatchString(value)
}

func validateSecureEnvelope(envelope SecureEnvelope) error {
	if envelope.Type != "secure" || envelope.Version != SecureEnvelopeVersion || !isAllowedChannel(envelope.Channel) || !isSafeBase64URL(envelope.Nonce) || !isSafeBase64URL(envelope.Ciphertext) {
		return ErrInvalidEnvelope
	}
	return nil
}

type publicPeer struct {
	ID string `json:"id"`
}

type systemMessage struct {
	Type   string       `json:"type"`
	Event  string       `json:"event"`
	PeerID string       `json:"peerId,omitempty"`
	Peers  []publicPeer `json:"peers,omitempty"`
}

type relayedMessage struct {
	Type       string     `json:"type"`
	Version    int        `json:"v"`
	Channel    string     `json:"channel"`
	Nonce      string     `json:"nonce"`
	Ciphertext string     `json:"ciphertext"`
	From       publicPeer `json:"from"`
	ReceivedAt string     `json:"receivedAt"`
}

func marshalSystem(event, peerID string, peers []publicPeer) []byte {
	message := systemMessage{Type: "system", Event: event, PeerID: peerID, Peers: peers}
	return mustMarshal(message)
}

func marshalSystemWithPeers(event string, peers []publicPeer) []byte {
	return mustMarshal(struct {
		Type  string       `json:"type"`
		Event string       `json:"event"`
		Peers []publicPeer `json:"peers"`
	}{Type: "system", Event: event, Peers: peers})
}

func marshalRelayed(envelope SecureEnvelope, peerID, receivedAt string) []byte {
	message := relayedMessage{
		Type:       "secure",
		Version:    SecureEnvelopeVersion,
		Channel:    envelope.Channel,
		Nonce:      envelope.Nonce,
		Ciphertext: envelope.Ciphertext,
		From:       publicPeer{ID: peerID},
		ReceivedAt: receivedAt,
	}
	return mustMarshal(message)
}

func mustMarshal(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(fmt.Sprintf("marshal p2p protocol message: %v", err))
	}
	return encoded
}
