package feishucards

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestRawBoundaryMatchesNodeErrorPriorityAndURLCanonicalization(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		raw  string
		code string
	}{
		{
			name: "non-finite-positive",
			raw:  `{"elements":[{"tag":"action","actions":[{"tag":"button","text":"synthetic","value":{"action_id":"confirm","data":{"number":1e999}}}]}]}`,
			code: CodeInvalidPayload,
		},
		{
			name: "non-finite-negative",
			raw:  `{"elements":[{"tag":"action","actions":[{"tag":"button","text":"synthetic","value":{"action_id":"confirm","data":{"number":-1e999}}}]}]}`,
			code: CodeInvalidPayload,
		},
		{
			name: "unsafe-text-before-number",
			raw:  `{"elements":[{"tag":"action","actions":[{"tag":"button","text":"<script>synthetic</script>","value":{"action_id":"confirm","data":{"number":1e999}}}]}]}`,
			code: CodeUnsafeContent,
		},
		{name: "dotted-short-form", raw: `{"elements":[{"tag":"markdown","content":"[synthetic](https://127.1/boundary)"}]}`, code: CodePrivateURL},
		{name: "decimal-form", raw: `{"elements":[{"tag":"markdown","content":"[synthetic](https://2130706433/boundary)"}]}`, code: CodePrivateURL},
		{name: "hex-form", raw: `{"elements":[{"tag":"markdown","content":"[synthetic](https://0x7f000001/boundary)"}]}`, code: CodePrivateURL},
		{name: "octal-dotted-form", raw: `{"elements":[{"tag":"markdown","content":"[synthetic](https://0177.0.0.1/boundary)"}]}`, code: CodePrivateURL},
		{name: "public-mapped-ipv6", raw: `{"elements":[{"tag":"markdown","content":"[synthetic](https://[::ffff:8.8.8.8]/boundary)"}]}`, code: CodePrivateURL},
	}

	for _, fixture := range cases {
		fixture := fixture
		t.Run(fixture.name, func(t *testing.T) {
			_, err := ConvertJSON([]byte(fixture.raw))
			if got := errorCode(err); got != fixture.code {
				t.Fatalf("error code = %s, want %s (err=%v)", got, fixture.code, err)
			}
		})
	}
}

func TestRawTextCanonicalPreservesUTF16UnitsAndECMAScriptTrim(t *testing.T) {
	raw := json.RawMessage(`{"header":{"title":{"tag":"plain_text","content":"\ud800 title \u0085"}},"elements":[{"tag":"action","actions":[{"tag":"button","text":"\ud800 label","value":{"action_id":"confirm","data":{"z":"first","0":"zero","z":"last","a":"first","surrogate":"\ud800"}}}]}]}`)
	result, err := ConvertJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"format":"duallane.feishu-card.v1","config":{"version":"1.0","wideScreen":false},"header":{"title":"\ud800 title ` + "\u0085" + `","tone":"neutral"},"elements":[{"type":"actions","buttons":[{"type":"button","label":"\ud800 label","actionId":"confirm","style":"default","data":{"0":"zero","z":"last","a":"first","surrogate":"\ud800"}}]}]}`
	if string(result.PayloadJSON) != want {
		t.Fatalf("canonical raw differs\n got: %s\nwant: %s", result.PayloadJSON, want)
	}
	validated, err := ValidatePayloadJSON(json.RawMessage(result.PayloadJSON))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(validated, result.PayloadJSON) {
		t.Fatalf("validated canonical raw changed\n got: %s\nwant: %s", validated, result.PayloadJSON)
	}
	if got := nodeTrimSpace("\u0085 synthetic \u0085"); got != "\u0085 synthetic \u0085" {
		t.Fatalf("ECMAScript trim removed U+0085: %q", got)
	}
	markdown, err := ConvertJSON(json.RawMessage(`{"elements":[{"tag":"markdown","content":"\ud800 markdown"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(markdown.PayloadJSON, []byte(`"text":"\ud800 markdown"`)) {
		t.Fatalf("markdown lone UTF-16 unit was not retained: %s", markdown.PayloadJSON)
	}
}
