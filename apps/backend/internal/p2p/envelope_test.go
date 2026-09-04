package p2p

import (
	"strings"
	"testing"
)

func TestParseClientMessage(t *testing.T) {
	tests := []struct {
		name        string
		input       string
		kind        ClientMessageKind
		wantErr     error
		wantChannel string
	}{
		{name: "leave", input: `{"type":"leave","ignored":"field"}`, kind: ClientMessageLeave},
		{name: "secure", input: `{"type":"secure","v":1,"channel":"ws-chat","nonce":"abc123_-","ciphertext":"opaque_-"}`, kind: ClientMessageSecure, wantChannel: "ws-chat"},
		{name: "numeric version", input: `{"type":"secure","v":1.0,"channel":"signal","nonce":"n","ciphertext":"c"}`, kind: ClientMessageSecure, wantChannel: "signal"},
		{name: "plaintext is rejected", input: `{"type":"message","body":"secret"}`, wantErr: ErrInvalidMessage},
		{name: "unknown type is rejected", input: `{"type":"system","event":"joined"}`, wantErr: ErrInvalidMessage},
		{name: "bad channel", input: `{"type":"secure","v":1,"channel":"message","nonce":"n","ciphertext":"c"}`, wantErr: ErrInvalidEnvelope},
		{name: "empty nonce", input: `{"type":"secure","v":1,"channel":"profile","nonce":"","ciphertext":"c"}`, wantErr: ErrInvalidEnvelope},
		{name: "padded base64 is rejected", input: `{"type":"secure","v":1,"channel":"profile","nonce":"n=","ciphertext":"c"}`, wantErr: ErrInvalidEnvelope},
		{name: "trailing json is rejected", input: `{"type":"leave"}{}`, wantErr: ErrInvalidMessage},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			message, err := ParseClientMessage([]byte(test.input))
			if test.wantErr != nil {
				if err != test.wantErr {
					t.Fatalf("ParseClientMessage() error = %v, want %v", err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseClientMessage() unexpected error: %v", err)
			}
			if message.Kind != test.kind {
				t.Fatalf("message kind = %d, want %d", message.Kind, test.kind)
			}
			if test.wantChannel != "" && message.Envelope.Channel != test.wantChannel {
				t.Fatalf("channel = %q, want %q", message.Envelope.Channel, test.wantChannel)
			}
		})
	}
}

func TestParseClientMessageRejectsOversizedEnvelopeValue(t *testing.T) {
	oversized := strings.Repeat("a", MaxEnvelopeValueBytes+1)
	input := `{"type":"secure","v":1,"channel":"ws-chat","nonce":"n","ciphertext":"` + oversized + `"}`
	_, err := ParseClientMessage([]byte(input))
	if err != ErrInvalidEnvelope {
		t.Fatalf("ParseClientMessage() error = %v, want %v", err, ErrInvalidEnvelope)
	}
}

func TestMarshalRelayedMessagePreservesOpaqueFields(t *testing.T) {
	envelope := SecureEnvelope{
		Type:       "secure",
		Version:    SecureEnvelopeVersion,
		Channel:    "profile",
		Nonce:      "nonce_-",
		Ciphertext: "ciphertext_-",
	}
	encoded := string(marshalRelayed(envelope, "peer-id", "2026-09-04T10:11:12.123Z"))
	wantFields := []string{`"type":"secure"`, `"v":1`, `"channel":"profile"`, `"nonce":"nonce_-"`, `"ciphertext":"ciphertext_-"`, `"from":{"id":"peer-id"}`, `"receivedAt":"2026-09-04T10:11:12.123Z"`}
	for _, field := range wantFields {
		if !strings.Contains(encoded, field) {
			t.Errorf("relayed message %q does not contain %s", encoded, field)
		}
	}
}
