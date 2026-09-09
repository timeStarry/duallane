package messages

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	extast "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// This is ECMAScript WhiteSpace + LineTerminator, not Go's unicode.IsSpace:
// Node trims BOM but retains NEXT LINE (U+0085).
const nodeSummaryWhitespace = `[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var (
	nodeSummaryParser     = newNodeSummaryParser()
	nodeSummaryFence      = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})")
	nodeSummaryImage      = regexp.MustCompile(`!\[[^\]\n]*\]\([^)\n]*\)`)
	nodeSummaryHTML       = regexp.MustCompile(`</?[A-Za-z][^>]*>`)
	nodeSummaryTable      = regexp.MustCompile(`(?m)^` + nodeSummaryWhitespace + `*\|?` + nodeSummaryWhitespace + `*:?-{3,}:?` + nodeSummaryWhitespace + `*(?:\|` + nodeSummaryWhitespace + `*:?-{3,}:?` + nodeSummaryWhitespace + `*)+\|?` + nodeSummaryWhitespace + `*$`)
	nodeSummarySpaces     = regexp.MustCompile(`[\t ]+`)
	nodeSummaryLineSpaces = regexp.MustCompile(` *\n *`)
	nodeSummaryBlankLines = regexp.MustCompile(`\n{3,}`)
)

func newNodeSummaryParser() parser.Parser {
	// Node explicitly disables indented code. Keep Goldmark's other CommonMark
	// block/inline parsers and reference definitions, then enable GFM.
	blocks := parser.DefaultBlockParsers()
	withoutIndentedCode := make([]util.PrioritizedValue, 0, len(blocks)-1)
	for _, block := range blocks {
		// The default CodeBlockParser has priority 500 in pinned Goldmark v1.8.6.
		if block.Priority == 500 {
			continue
		}
		if block.Priority == 1000 {
			block.Value = nodeSummaryParagraphParser{parser.NewParagraphParser()}
		}
		withoutIndentedCode = append(withoutIndentedCode, block)
	}
	return goldmark.New(
		goldmark.WithParser(parser.NewParser(
			parser.WithBlockParsers(withoutIndentedCode...),
			parser.WithInlineParsers(parser.DefaultInlineParsers()...),
			parser.WithParagraphTransformers(parser.DefaultParagraphTransformers()...),
		)),
		goldmark.WithExtensions(extension.GFM),
	).Parser()
}

// Removing the code parser also requires allowing indented paragraphs;
// otherwise Goldmark skips lines that Node parses as ordinary Markdown.
type nodeSummaryParagraphParser struct{ parser.BlockParser }

func (nodeSummaryParagraphParser) CanAcceptIndentedLine() bool { return true }

// nodeMarkdownSummary matches the entire text-block branch of Node
// workspace.buildPlainText, including literal and whitespace-only fallbacks.
// It only walks an AST: no HTML is rendered and no links are fetched.
func nodeMarkdownSummary(source string) string {
	if source == "" {
		return ""
	}
	normalized := normalizeNodeSummaryNewlines(source)
	var summary string
	if nodeSummaryHasUnclosedFence(normalized) || nodeSummaryImage.MatchString(source) ||
		nodeSummaryHTML.MatchString(source) || nodeSummaryTable.MatchString(source) {
		// Match Node's source-level guard even inside inline/fenced code. This
		// fallback intentionally does not restore boundary spaces.
		summary = normalizeNodeSummary(source, true)
	} else {
		// micromark replaces NUL during parsing, but not in literal fallback.
		input := []byte(strings.ReplaceAll(normalized, "\x00", "\ufffd"))
		root := nodeSummaryParser.Parse(text.NewReader(input))
		parts := make([]string, 0)
		collectNodeSummaryBlocks(root, input, &parts)
		summary = normalizeNodeSummary(strings.Join(parts, "\n"), true)
		if summary != "" {
			first, _ := utf8.DecodeRuneInString(source)
			last, _ := utf8.DecodeLastRuneInString(source)
			if isNodeSummarySpace(first) {
				summary = " " + summary
			}
			if isNodeSummarySpace(last) {
				summary += " "
			}
		}
	}
	if summary == "" {
		// fallbackTextSummary does not collapse repeated blank lines.
		summary = normalizeNodeSummary(source, false)
	}
	if summary == "" && strings.ContainsFunc(source, isNodeSummarySpace) {
		return " "
	}
	return summary
}

func collectNodeSummaryBlocks(node ast.Node, source []byte, parts *[]string) {
	var value string
	switch node.Kind() {
	case ast.KindParagraph, ast.KindTextBlock, ast.KindHeading:
		var content strings.Builder
		writeNodeSummaryInline(&content, node, source)
		value = content.String()
	case ast.KindFencedCodeBlock, ast.KindCodeBlock:
		value = string(node.Lines().Value(source))
	case ast.KindThematicBreak:
		value = "[分割线]"
	case ast.KindHTMLBlock, extast.KindTable:
		return
	default:
		// strip-markdown unwraps list/listItem/blockquote into paragraphs.
		for child := node.FirstChild(); child != nil; child = child.NextSibling() {
			collectNodeSummaryBlocks(child, source, parts)
		}
		return
	}
	if value = nodeSummaryTrim(value); value != "" {
		*parts = append(*parts, value)
	}
}

func writeNodeSummaryInline(out *strings.Builder, node ast.Node, source []byte) {
	switch node := node.(type) {
	case *ast.Text:
		value := node.Segment.Value(source)
		if node.IsRaw() {
			out.Write(value)
		} else {
			writeNodeSummaryText(out, value)
		}
		if node.SoftLineBreak() || node.HardLineBreak() {
			out.WriteByte('\n')
		}
		return
	case *ast.String:
		if node.IsRaw() || node.IsCode() {
			out.Write(node.Value)
		} else {
			writeNodeSummaryText(out, node.Value)
		}
		return
	case *ast.CodeSpan:
		for child := node.FirstChild(); child != nil; child = child.NextSibling() {
			value := child.(*ast.Text).Segment.Value(source)
			out.Write(value)
		}
		return
	case *ast.AutoLink:
		// An autolink label is literal; Markdown escapes do not apply here.
		out.Write(node.Label(source))
		return
	case *ast.Image, *ast.RawHTML, *extast.TaskCheckBox:
		return
	}
	for child := node.FirstChild(); child != nil; child = child.NextSibling() {
		writeNodeSummaryInline(out, child, source)
	}
}

func writeNodeSummaryText(out *strings.Builder, value []byte) {
	// Goldmark retains escapes and character references in Text segments. Decode
	// once, in source order: escaped '&' and '&amp;lt;' must not be decoded twice.
	for i := 0; i < len(value); {
		if value[i] == '\\' && i+1 < len(value) && util.IsPunct(value[i+1]) {
			out.WriteByte(value[i+1])
			i += 2
			continue
		}
		if value[i] == '&' {
			// HTML5 entity names fit in 31 ASCII bytes; numeric references have
			// at most 7 decimal or 6 hex digits. Bound the scan for invalid input.
			end := i + 1
			for end < len(value) && end-i <= 33 && value[end] != ';' {
				c := value[end]
				if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '#') {
					break
				}
				end++
			}
			if end < len(value) && value[end] == ';' {
				name := string(value[i+1 : end])
				if entity, ok := util.LookUpHTML5EntityByName(name); ok {
					out.Write(entity.Characters)
					i = end + 1
					continue
				}
				if validNodeSummaryNumericEntity(name) {
					out.WriteRune(decodeNodeSummaryNumericEntity(name))
					i = end + 1
					continue
				}
			}
		}
		out.WriteByte(value[i])
		i++
	}
}

func decodeNodeSummaryNumericEntity(name string) rune {
	digits, base := name[1:], 10
	if digits[0] == 'x' || digits[0] == 'X' {
		digits, base = digits[1:], 16
	}
	value, _ := strconv.ParseUint(digits, base, 32)
	// micromark replaces forbidden controls, surrogates and noncharacters;
	// HTML rendering's Windows-1252 remapping would differ (e.g. &#128;).
	if value == 0 || value < 0x20 && value != 0x09 && value != 0x0a && value != 0x0c && value != 0x0d ||
		value >= 0x7f && value <= 0x9f || value >= 0xd800 && value <= 0xdfff ||
		value >= 0xfdd0 && value <= 0xfdef || value&0xffff == 0xfffe || value&0xffff == 0xffff || value > 0x10ffff {
		return '\ufffd'
	}
	return rune(value)
}

func validNodeSummaryNumericEntity(name string) bool {
	if len(name) < 2 || name[0] != '#' {
		return false
	}
	digits := name[1:]
	hex := digits[0] == 'x' || digits[0] == 'X'
	limit := 7
	if hex {
		digits = digits[1:]
		limit = 6
	}
	if len(digits) == 0 || len(digits) > limit {
		return false
	}
	for _, c := range digits {
		if !(c >= '0' && c <= '9' || hex && (c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func nodeSummaryHasUnclosedFence(source string) bool {
	fence := ""
	for line := range strings.SplitSeq(source, "\n") {
		match := nodeSummaryFence.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		if fence == "" {
			fence = match[1]
		} else if fence[0] == match[1][0] && len(match[1]) >= len(fence) {
			fence = ""
		}
	}
	return fence != ""
}

func normalizeNodeSummaryNewlines(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
}

func normalizeNodeSummary(value string, collapseBlankLines bool) string {
	value = normalizeNodeSummaryNewlines(value)
	value = nodeSummarySpaces.ReplaceAllString(value, " ")
	value = nodeSummaryLineSpaces.ReplaceAllString(value, "\n")
	if collapseBlankLines {
		value = nodeSummaryBlankLines.ReplaceAllString(value, "\n\n")
	}
	return nodeSummaryTrim(value)
}

// nodeSummaryTrim matches JavaScript String.trim for the final block join.
func nodeSummaryTrim(value string) string {
	return strings.TrimFunc(value, isNodeSummarySpace)
}

func isNodeSummarySpace(c rune) bool {
	return c >= '\t' && c <= '\r' || c == ' ' || c == '\u00a0' || c == '\u1680' ||
		c >= '\u2000' && c <= '\u200a' || c == '\u2028' || c == '\u2029' ||
		c == '\u202f' || c == '\u205f' || c == '\u3000' || c == '\ufeff'
}
