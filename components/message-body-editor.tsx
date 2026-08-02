"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  TextNode,
  UNDO_COMMAND,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  HEADING,
  INLINE_CODE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  ORDERED_LIST,
  UNORDERED_LIST,
  type ElementTransformer,
  type TextMatchTransformer,
  type Transformer,
} from "@lexical/markdown";
import { $createHeadingNode, HeadingNode } from "@lexical/rich-text";
import {
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListItemNode,
  ListNode,
} from "@lexical/list";
import { LinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { $setBlocksType } from "@lexical/selection";
import {
  $createHorizontalRuleNode,
  $isHorizontalRuleNode,
  HorizontalRuleNode,
  INSERT_HORIZONTAL_RULE_COMMAND,
} from "@lexical/extension";
import {
  Bold,
  Braces,
  Code2,
  FileCode2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Redo2,
  Undo2,
} from "lucide-react";

type SerializedMessageTokenNode = Spread<
  { type: "message-token"; version: 1 },
  SerializedTextNode
>;

export class MessageTokenNode extends TextNode {
  static getType() {
    return "message-token";
  }

  static clone(node: MessageTokenNode) {
    return new MessageTokenNode(node.__text, node.__key);
  }

  static importJSON(serializedNode: SerializedMessageTokenNode) {
    return $createMessageTokenNode(serializedNode.text).updateFromJSON(serializedNode);
  }

  constructor(text: string, key?: NodeKey) {
    super(text, key);
  }

  createDOM(config: EditorConfig) {
    const element = super.createDOM(config);
    element.classList.add("message-editor-token");
    element.dataset.messageToken = "true";
    element.title = "Template token";
    return element;
  }

  exportJSON(): SerializedMessageTokenNode {
    return {
      ...super.exportJSON(),
      type: "message-token",
      version: 1,
    };
  }

  isTextEntity() {
    return true;
  }

  canInsertTextBefore() {
    return false;
  }

  canInsertTextAfter() {
    return false;
  }
}

export function $createMessageTokenNode(text: string) {
  return $applyNodeReplacement(new MessageTokenNode(text)).setMode("token");
}

export function $isMessageTokenNode(node: LexicalNode | null | undefined): node is MessageTokenNode {
  return node instanceof MessageTokenNode;
}

const MESSAGE_TOKEN_TRANSFORMER: TextMatchTransformer = {
  dependencies: [MessageTokenNode],
  export: (node) => ($isMessageTokenNode(node) ? node.getTextContent() : null),
  getEndIndex: (node, match) => (
    $isMessageTokenNode(node) ? false : (match.index ?? 0) + match[0].length
  ),
  importRegExp: /\{\{[a-z0-9_]+\}\}/,
  regExp: /\{\{[a-z0-9_]+\}\}$/,
  replace: (textNode, match) => {
    const tokenNode = $createMessageTokenNode(match[0]);
    textNode.replace(tokenNode);
    return tokenNode;
  },
  trigger: "}",
  type: "text-match",
};

const HORIZONTAL_RULE_TRANSFORMER: ElementTransformer = {
  dependencies: [HorizontalRuleNode],
  export: (node) => ($isHorizontalRuleNode(node) ? "---" : null),
  regExp: /^(?:-{3,}|_{3,}|\*{3,})\s?$/,
  replace: (parentNode) => {
    parentNode.replace($createHorizontalRuleNode());
  },
  type: "element",
};

export const EMAIL_MARKDOWN_TRANSFORMERS: Transformer[] = [
  HORIZONTAL_RULE_TRANSFORMER,
  HEADING,
  UNORDERED_LIST,
  ORDERED_LIST,
  INLINE_CODE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  MESSAGE_TOKEN_TRANSFORMER,
];

type MessageBodyEditorProps = {
  value: string;
  tokens: readonly string[];
  maxLength?: number;
  onChange: (value: string) => void;
};

type EditorToolbarProps = {
  tokens: readonly string[];
  markChanged: () => void;
};

function EditorToolbar({ tokens, markChanged }: EditorToolbarProps) {
  const [editor] = useLexicalComposerContext();
  const [token, setToken] = useState(tokens[0] ?? "");

  function setBlock(tag: "p" | "h1" | "h2" | "h3") {
    markChanged();
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      $setBlocksType(
        selection,
        () => tag === "p" ? $createParagraphNode() : $createHeadingNode(tag),
      );
    });
  }

  function formatText(format: "bold" | "italic" | "code") {
    markChanged();
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
  }

  function insertToken() {
    if (!token) return;
    markChanged();
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const tokenNode = $createMessageTokenNode(`{{${token}}}`);
      selection.insertNodes([tokenNode, $createTextNode(" ")]);
      tokenNode.selectNext();
    });
  }

  function editLink() {
    const url = window.prompt("Link URL (http, https, mailto, or tel). Leave blank to remove the link.");
    if (url === null) return;
    markChanged();
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, url.trim() || null);
  }

  const button = (
    label: string,
    icon: ReactNode,
    action: () => void,
  ) => (
    <button
      aria-label={label}
      title={label}
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={action}
    >
      {icon}
    </button>
  );

  return (
    <div className="message-editor-toolbar" role="toolbar" aria-label="Message formatting">
      <div>
        {button("Paragraph", <Pilcrow size={16} />, () => setBlock("p"))}
        {button("Heading 1", <Heading1 size={16} />, () => setBlock("h1"))}
        {button("Heading 2", <Heading2 size={16} />, () => setBlock("h2"))}
        {button("Heading 3", <Heading3 size={16} />, () => setBlock("h3"))}
      </div>
      <div>
        {button("Bold", <Bold size={16} />, () => formatText("bold"))}
        {button("Italic", <Italic size={16} />, () => formatText("italic"))}
        {button("Inline code", <Code2 size={16} />, () => formatText("code"))}
        {button("Link", <Link2 size={16} />, editLink)}
      </div>
      <div>
        {button("Bulleted list", <List size={16} />, () => {
          markChanged();
          editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
        })}
        {button("Numbered list", <ListOrdered size={16} />, () => {
          markChanged();
          editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
        })}
        {button("Horizontal rule", <Minus size={16} />, () => {
          markChanged();
          editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined);
        })}
      </div>
      <div>
        {button("Undo", <Undo2 size={16} />, () => editor.dispatchCommand(UNDO_COMMAND, undefined))}
        {button("Redo", <Redo2 size={16} />, () => editor.dispatchCommand(REDO_COMMAND, undefined))}
      </div>
      <div className="message-editor-token-control">
        <Braces size={16} aria-hidden="true" />
        <label>
          <span className="sr-only">Template token</span>
          <select value={token} onChange={(event) => setToken(event.target.value)}>
            {tokens.map((candidate) => (
              <option value={candidate} key={candidate}>{`{{${candidate}}}`}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={insertToken}>Insert token</button>
      </div>
    </div>
  );
}

function VisualEditor({ value, tokens, onChange }: MessageBodyEditorProps) {
  const [mounted, setMounted] = useState(false);
  const userEdited = useRef(false);

  useEffect(() => {
    // Lexical must initialize after hydration because its editor state changes placeholder markup.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="message-editor-loading">Loading visual editor…</div>;
  }

  return (
    <LexicalComposer
      initialConfig={{
        namespace: "imsda-message-body",
        nodes: [
          HeadingNode,
          ListNode,
          ListItemNode,
          LinkNode,
          HorizontalRuleNode,
          MessageTokenNode,
        ],
        editorState: () => {
          $convertFromMarkdownString(value, EMAIL_MARKDOWN_TRANSFORMERS, undefined, true);
        },
        onError(error) {
          throw error;
        },
        theme: {
          heading: {
            h1: "message-editor-h1",
            h2: "message-editor-h2",
            h3: "message-editor-h3",
          },
          link: "message-editor-link",
          list: {
            listitem: "message-editor-list-item",
            nested: { listitem: "message-editor-list-item-nested" },
            ol: "message-editor-list",
            ul: "message-editor-list",
          },
          paragraph: "message-editor-paragraph",
          text: {
            bold: "message-editor-bold",
            code: "message-editor-code",
            italic: "message-editor-italic",
          },
        },
      }}
    >
      <EditorToolbar tokens={tokens} markChanged={() => { userEdited.current = true; }} />
      <div className="message-editor-email">
        <div className="message-editor-email-header">IMSDA Events</div>
        <div className="message-editor-email-body">
          <RichTextPlugin
            contentEditable={(
              <ContentEditable
                aria-label="Message body visual editor"
                className="message-editor-content"
                onBeforeInput={() => { userEdited.current = true; }}
                onKeyDown={() => { userEdited.current = true; }}
                onPaste={() => { userEdited.current = true; }}
              />
            )}
            placeholder={<div className="message-editor-placeholder">Write the email message…</div>}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
      </div>
      <HistoryPlugin />
      <ListPlugin />
      <LinkPlugin />
      <OnChangePlugin
        ignoreSelectionChange
        onChange={(editorState) => {
          if (!userEdited.current) return;
          const markdown = editorState.read(() => (
            $convertToMarkdownString(EMAIL_MARKDOWN_TRANSFORMERS, undefined, true)
          ));
          if (markdown !== value) onChange(markdown);
        }}
      />
    </LexicalComposer>
  );
}

export function MessageBodyEditor({
  value,
  tokens,
  maxLength = 12000,
  onChange,
}: MessageBodyEditorProps) {
  const [mode, setMode] = useState<"visual" | "source">("visual");

  return (
    <div className="message-body-editor">
      <div className="message-editor-mode" role="group" aria-label="Message editor mode">
        <button
          aria-pressed={mode === "visual"}
          className={mode === "visual" ? "selected" : ""}
          type="button"
          onClick={() => setMode("visual")}
        >
          <Braces size={15} aria-hidden="true" /> Visual
        </button>
        <button
          aria-pressed={mode === "source"}
          className={mode === "source" ? "selected" : ""}
          type="button"
          onClick={() => setMode("source")}
        >
          <FileCode2 size={15} aria-hidden="true" /> Markdown
        </button>
      </div>
      {mode === "visual" ? (
        <VisualEditor value={value} tokens={tokens} onChange={onChange} />
      ) : (
        <div className="message-editor-source">
          <label htmlFor="message-body-source">Markdown source</label>
          <textarea
            id="message-body-source"
            aria-describedby="message-body-source-help"
            value={value}
            rows={22}
            maxLength={maxLength}
            required
            onChange={(event) => onChange(event.target.value)}
          />
          <small id="message-body-source-help">
            Source mode supports headings, bold, italic, lists, links, inline code, rules, and template tokens.
          </small>
        </div>
      )}
      <div className="message-editor-footer">
        <span>Visual formatting is converted to the Markdown stored by existing template versions.</span>
        <span>{value.length.toLocaleString()} / {maxLength.toLocaleString()}</span>
      </div>
    </div>
  );
}
