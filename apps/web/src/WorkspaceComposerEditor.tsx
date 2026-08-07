import { $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot, $getSelection, $insertNodes, $isLineBreakNode, $isRangeSelection, $isTextNode, DecoratorNode, type EditorConfig, type LexicalEditor, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { forwardRef, useEffect, useImperativeHandle, useRef, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { renderMessageParts, type EmoteItem } from "./emotes";

export type WorkspaceComposerBlock =
  | { type: "text"; text: string }
  | { type: "mention"; userId: string; label: string }
  | { type: "emote"; token: string; item: EmoteItem };

export type WorkspaceComposerDocument = {
  source: string;
  blocks: WorkspaceComposerBlock[];
};

export type WorkspaceComposerEditorHandle = {
  focus: () => void;
  insertText: (text: string) => void;
  insertMention: (userId: string, label: string, triggerLength?: number) => void;
  insertEmote: (item: EmoteItem, token: string) => void;
  applyInlineFormat: (prefix: string, suffix?: string, placeholder?: string) => void;
};

type SerializedMentionNode = Spread<{ userId: string; label: string }, SerializedLexicalNode>;
type SerializedEmoteNode = Spread<{ token: string; item: EmoteItem }, SerializedLexicalNode>;

class MentionNode extends DecoratorNode<ReactNode> {
  __userId: string;
  __label: string;

  static getType() { return "workspace-mention"; }
  static clone(node: MentionNode) { return new MentionNode(node.__userId, node.__label, node.__key); }
  static importJSON(node: SerializedMentionNode) { return new MentionNode(node.userId, node.label); }
  constructor(userId: string, label: string, key?: NodeKey) {
    super(key);
    this.__userId = userId;
    this.__label = label;
  }
  createDOM(_config: EditorConfig) { return document.createElement("span"); }
  updateDOM() { return false; }
  isInline() { return true; }
  getTextContent() { return `@${this.__label}`; }
  exportJSON(): SerializedMentionNode {
    return { type: "workspace-mention", version: 1, userId: this.__userId, label: this.__label };
  }
  decorate() {
    return <span className="workspace-editor-token mention" contentEditable={false}>@{this.__label}</span>;
  }
}

class EmoteNode extends DecoratorNode<ReactNode> {
  __item: EmoteItem;
  __token: string;

  static getType() { return "workspace-emote"; }
  static clone(node: EmoteNode) { return new EmoteNode(node.__item, node.__token, node.__key); }
  static importJSON(node: SerializedEmoteNode) { return new EmoteNode(node.item, node.token); }
  constructor(item: EmoteItem, token: string, key?: NodeKey) {
    super(key);
    this.__item = item;
    this.__token = token;
  }
  createDOM(_config: EditorConfig) { return document.createElement("span"); }
  updateDOM() { return false; }
  isInline() { return true; }
  getTextContent() { return this.__token; }
  exportJSON(): SerializedEmoteNode {
    return { type: "workspace-emote", version: 1, item: this.__item, token: this.__token };
  }
  decorate() {
    return <span className="workspace-editor-token emote" contentEditable={false}>{renderMessageParts(this.__token)}</span>;
  }
}

function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode;
}

function $isEmoteNode(node: LexicalNode | null | undefined): node is EmoteNode {
  return node instanceof EmoteNode;
}

function $setDocument(document: WorkspaceComposerDocument) {
  const root = $getRoot();
  root.clear();
  let paragraph = $createParagraphNode();
  root.append(paragraph);
  for (const block of document.blocks) {
    if (block.type === "mention") {
      paragraph.append(new MentionNode(block.userId, block.label));
      continue;
    }
    if (block.type === "emote") {
      paragraph.append(new EmoteNode(block.item, block.token));
      continue;
    }
    const lines = block.text.replace(/\r\n?/g, "\n").split("\n");
    lines.forEach((line, index) => {
      if (index > 0) {
        paragraph = $createParagraphNode();
        root.append(paragraph);
      }
      if (line) paragraph.append($createTextNode(line));
    });
  }
}

function documentSignature(document: WorkspaceComposerDocument) {
  return JSON.stringify(document.blocks);
}

function $serializeDocument(): WorkspaceComposerDocument {
  const blocks: WorkspaceComposerBlock[] = [];
  let text = "";
  const flushText = () => {
    if (!text) return;
    const previous = blocks.at(-1);
    if (previous?.type === "text") previous.text += text;
    else blocks.push({ type: "text", text });
    text = "";
  };
  const visit = (node: LexicalNode) => {
    if ($isTextNode(node)) {
      text += node.getTextContent();
      return;
    }
    if ($isLineBreakNode(node)) {
      text += "\n";
      return;
    }
    if ($isMentionNode(node)) {
      flushText();
      blocks.push({ type: "mention", userId: node.__userId, label: node.__label });
      return;
    }
    if ($isEmoteNode(node)) {
      flushText();
      blocks.push({ type: "emote", token: node.__token, item: node.__item });
      return;
    }
    const children = "getChildren" in node ? (node as LexicalNode & { getChildren(): LexicalNode[] }).getChildren() : [];
    children.forEach(visit);
  };
  const children = $getRoot().getChildren();
  children.forEach((child, index) => {
    visit(child);
    if (index < children.length - 1) text += "\n";
  });
  flushText();
  return {
    source: blocks.map((block) => block.type === "text" ? block.text : block.type === "mention" ? `@${block.label}` : block.token).join(""),
    blocks
  };
}

function WorkspaceComposerBridge({
  value,
  onChange,
  onMentionQuery,
  editorRef
}: {
  value: WorkspaceComposerDocument;
  onChange: (document: WorkspaceComposerDocument) => void;
  onMentionQuery: (query: string | null) => void;
  editorRef: React.ForwardedRef<WorkspaceComposerEditorHandle>;
}) {
  const [editor] = useLexicalComposerContext();
  const lastDocumentSignatureRef = useRef(documentSignature(value));

  useEffect(() => {
    const nextSignature = documentSignature(value);
    if (nextSignature === lastDocumentSignatureRef.current) return;
    editor.update(() => $setDocument(value));
    lastDocumentSignatureRef.current = nextSignature;
  }, [editor, value]);

  useImperativeHandle(editorRef, () => ({
    focus: () => editor.focus(),
    insertText: (text) => editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText(text);
    }),
    insertMention: (userId, label, triggerLength = 0) => editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection) && triggerLength > 0) {
        const node = selection.anchor.getNode();
        if ($isTextNode(node)) {
          const end = selection.anchor.offset;
          node.spliceText(Math.max(0, end - triggerLength), triggerLength, "");
        }
      }
      $insertNodes([new MentionNode(userId, label), $createTextNode(" ")]);
    }),
    insertEmote: (item, token) => editor.update(() => {
      if (item.kind === "image") $insertNodes([new EmoteNode(item, token), $createTextNode(" ")]);
      else $insertNodes([$createTextNode(token)]);
    }),
    applyInlineFormat: (prefix, suffix = prefix, placeholder = "文本") => editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const selected = selection.getTextContent();
      selection.insertText(`${prefix}${selected || placeholder}${suffix}`);
    })
  }), [editor, editorRef]);

  return <OnChangePlugin onChange={(editorState) => {
    editorState.read(() => {
      const document = $serializeDocument();
      lastDocumentSignatureRef.current = documentSignature(document);
      onChange(document);
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
        onMentionQuery(null);
        return;
      }
      const node = selection.anchor.getNode();
      if (!$isTextNode(node)) {
        onMentionQuery(null);
        return;
      }
      const before = node.getTextContent().slice(0, selection.anchor.offset);
      const match = before.match(/(?:^|\s)@([^\s@，。！？,.!?;；:：()[\]{}]*)$/u);
      onMentionQuery(match ? match[1] : null);
    });
  }} />;
}

export const WorkspaceComposerEditor = forwardRef<WorkspaceComposerEditorHandle, {
  value: WorkspaceComposerDocument;
  onChange: (document: WorkspaceComposerDocument) => void;
  onMentionQuery: (query: string | null) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  expanded: boolean;
  readOnly: boolean;
}>(({ value, onChange, onMentionQuery, onKeyDown, onPaste, expanded, readOnly }, ref) => (
  <LexicalComposer initialConfig={{
    namespace: "DualLaneWorkspaceComposer",
    nodes: [MentionNode, EmoteNode],
    editable: !readOnly,
    editorState: () => $setDocument(value),
    onError: (error) => { throw error; }
  }}>
    <div className={expanded ? "workspace-lexical-editor expanded" : "workspace-lexical-editor"}>
      <PlainTextPlugin
        contentEditable={<ContentEditable aria-label="输入消息" onKeyDown={onKeyDown} onPaste={onPaste} />}
        placeholder={<span className="workspace-lexical-placeholder">输入消息</span>}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <WorkspaceComposerBridge value={value} onChange={onChange} onMentionQuery={onMentionQuery} editorRef={ref} />
      <EditableStatePlugin readOnly={readOnly} />
    </div>
  </LexicalComposer>
));

WorkspaceComposerEditor.displayName = "WorkspaceComposerEditor";

function EditableStatePlugin({ readOnly }: { readOnly: boolean }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => editor.setEditable(!readOnly), [editor, readOnly]);
  return null;
}
