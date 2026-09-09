package botgateway

import "testing"

func TestGatewayMessageRequestHashMatchesNodeJSON(t *testing.T) {
	special := "<>&\u2028\u2029"
	message := messageIdempotencyInput{
		ConversationID:   "conv_hash",
		ClientMessageID:  "msg_hash",
		ReplyToMessageID: nil,
		Content: MessageContent{
			Format:    MessageContentFormat,
			PlainText: special,
			Blocks:    []map[string]any{{"type": "text", "text": special}},
		},
	}
	got, err := hashGatewayRequest(message)
	if err != nil {
		t.Fatal(err)
	}
	const want = "f5974a7af29c825872c6ed7548c9f24c923fe34aa50a330952151b67857c0278"
	if got != want {
		t.Fatalf("message request hash = %s, want %s", got, want)
	}
}

func TestGatewayCardRequestHashMatchesNodeJSON(t *testing.T) {
	special := "<>&\u2028\u2029"
	card := cardIdempotencyInput{
		ConversationID: "conv_hash",
		CardType:       "future.poll",
		SchemaVersion:  1,
		FallbackText:   special,
		Payload:        map[string]any{"value": special},
	}
	got, err := hashGatewayRequest(card)
	if err != nil {
		t.Fatal(err)
	}
	const want = "b12ffd121fe338896e43fcb393a04f864b8a21d7698027939b2b1089b5fc34f5"
	if got != want {
		t.Fatalf("card request hash = %s, want %s", got, want)
	}
}

func TestNodeJSONMarshalDoesNotRewriteLiteralUnicodeEscapeText(t *testing.T) {
	encoded, err := nodeJSONMarshal(`\u2028`)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `"\\u2028"` {
		t.Fatalf("encoded literal escape = %s", encoded)
	}
}
