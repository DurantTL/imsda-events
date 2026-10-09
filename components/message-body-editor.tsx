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
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  RectangleHorizontal,
  Redo2,
  Undo2,
} from "lucide-react";
import {
  formatFileSize,
  MAX_INLINE_IMAGE_BYTES,
  MESSAGE_IMAGE_ACCEPT,
  messageFileUrl,
  type MessageFileRecord,
} from "@/modules/communications/message-file-rules";

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

type SerializedMessageImageNode = Spread<
  { type: "message-image"; version: 1; fileId: string; alt: string },
  SerializedTextNode
>;

/**
 * An uploaded image in the body, written in Markdown as `![description](msgfile:<id>)`. In the editor it is one
 * atomic chip, so a stray keystroke cannot damage the reference.
 */
export class MessageImageNode extends TextNode {
  __fileId: string;
  __alt: string;

  static getType() {
    return "message-image";
  }

  static clone(node: MessageImageNode) {
    return new MessageImageNode(node.__fileId, node.__alt, node.__key);
  }

  static importJSON(serializedNode: SerializedMessageImageNode) {
    return $createMessageImageNode(serializedNode.fileId, serializedNode.alt).updateFromJSON(serializedNode);
  }

  constructor(fileId: string, alt: string, key?: NodeKey) {
    super(`Image: ${alt.trim() || "picture"}`, key);
    this.__fileId = fileId;
    this.__alt = alt;
  }

  getFileId() {
    return this.getLatest().__fileId;
  }

  getAlt() {
    return this.getLatest().__alt;
  }

  createDOM(config: EditorConfig) {
    const element = super.createDOM(config);
    element.classList.add("message-editor-token", "message-editor-image");
    element.dataset.messageImage = this.__fileId;
    element.title = "Uploaded image";
    return element;
  }

  exportJSON(): SerializedMessageImageNode {
    return {
      ...super.exportJSON(),
      type: "message-image",
      version: 1,
      fileId: this.__fileId,
      alt: this.__alt,
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

export function $createMessageImageNode(fileId: string, alt: string) {
  return $applyNodeReplacement(new MessageImageNode(fileId, alt)).setMode("token");
}

export function $isMessageImageNode(node: LexicalNode | null | undefined): node is MessageImageNode {
  return node instanceof MessageImageNode;
}

const MESSAGE_IMAGE_TRANSFORMER: TextMatchTransformer = {
  dependencies: [MessageImageNode],
  export: (node) => (
    $isMessageImageNode(node) ? `![${node.getAlt()}](msgfile:${node.getFileId()})` : null
  ),
  getEndIndex: (node, match) => (
    $isMessageImageNode(node) ? false : (match.index ?? 0) + match[0].length
  ),
  importRegExp: /!\[([^\]]*)\]\(msgfile:([A-Za-z0-9_-]{8,64})\)/,
  regExp: /!\[([^\]]*)\]\(msgfile:([A-Za-z0-9_-]{8,64})\)$/,
  replace: (textNode, match) => {
    const imageNode = $createMessageImageNode(match[2], match[1]);
    textNode.replace(imageNode);
    return imageNode;
  },
  trigger: ")",
  type: "text-match",
};

type SerializedMessageButtonNode = Spread<
  { type: "message-button"; version: 1; url: string },
  SerializedTextNode
>;

/**
 * A button-style link, written in Markdown as `[Button text](url){.button}`. The renderer turns a button on a line
 * of its own into a table-based email button; anywhere else it is an ordinary link.
 */
export class MessageButtonNode extends TextNode {
  __url: string;

  static getType() {
    return "message-button";
  }

  static clone(node: MessageButtonNode) {
    return new MessageButtonNode(node.__text, node.__url, node.__key);
  }

  static importJSON(serializedNode: SerializedMessageButtonNode) {
    return $createMessageButtonNode(serializedNode.text, serializedNode.url).updateFromJSON(serializedNode);
  }

  constructor(label: string, url: string, key?: NodeKey) {
    super(label, key);
    this.__url = url;
  }

  getUrl() {
    return this.getLatest().__url;
  }

  createDOM(config: EditorConfig) {
    const element = super.createDOM(config);
    element.classList.add("message-editor-button");
    element.dataset.messageButton = "true";
    element.title = `Button linking to ${this.__url}`;
    return element;
  }

  exportJSON(): SerializedMessageButtonNode {
    return {
      ...super.exportJSON(),
      type: "message-button",
      version: 1,
      url: this.__url,
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

export function $createMessageButtonNode(label: string, url: string) {
  return $applyNodeReplacement(new MessageButtonNode(label, url)).setMode("token");
}

export function $isMessageButtonNode(node: LexicalNode | null | undefined): node is MessageButtonNode {
  return node instanceof MessageButtonNode;
}

const MESSAGE_BUTTON_TRANSFORMER: TextMatchTransformer = {
  dependencies: [MessageButtonNode],
  export: (node) => (
    $isMessageButtonNode(node) ? `[${node.getTextContent()}](${node.getUrl()}){.button}` : null
  ),
  getEndIndex: (node, match) => (
    $isMessageButtonNode(node) ? false : (match.index ?? 0) + match[0].length
  ),
  importRegExp: /\[([^\]]+)\]\(([^()\s]+)\)\{\.button\}/,
  regExp: /\[([^\]]+)\]\(([^()\s]+)\)\{\.button\}$/,
  replace: (textNode, match) => {
    const buttonNode = $createMessageButtonNode(match[1], match[2]);
    textNode.replace(buttonNode);
    return buttonNode;
  },
  trigger: "}",
  type: "text-match",
};

/** Whether a button or link destination is one the renderer will accept: a web, mail or phone link, or a link token. */
export function isAllowedEmailLinkTarget(value: string) {
  const url = value.trim();
  if (!url || /[\s()<>"']/.test(url)) return false;
  return /^(https?:\/\/|mailto:|tel:)\S+$/i.test(url) || /^\{\{[a-z0-9_]+\}\}$/.test(url);
}

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
  // Both before LINK, which would otherwise take the same text first.
  MESSAGE_IMAGE_TRANSFORMER,
  MESSAGE_BUTTON_TRANSFORMER,
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

const LIST_ITEM_LINE = /^\s*(?:[-*]\s+|\d+[.)]\s+)/;
const HARD_BREAK_LINE = /[ \t]{2,}$/;

/**
 * Bodies saved before paragraphs were separated by a blank line hold one
 * paragraph per line. Insert the missing blank line so the editor loads each
 * line as its own paragraph. A line ending in two spaces is a deliberate
 * in-paragraph line break (shift+enter) and stays joined to the next line.
 */
export function normalizeEmailMarkdownForEditor(source: string) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  lines.forEach((line, index) => {
    out.push(line);
    const next = lines[index + 1];
    if (next === undefined || !line.trim() || !next.trim()) return;
    const bothListItems = LIST_ITEM_LINE.test(line) && LIST_ITEM_LINE.test(next);
    const hardBreak = HARD_BREAK_LINE.test(line)
      && !LIST_ITEM_LINE.test(line)
      && !LIST_ITEM_LINE.test(next);
    if (!bothListItems && !hardBreak) out.push("");
  });
  return out.join("\n");
}

/** Load a stored Markdown body into the current editor. Call inside update(). */
export function $importEmailMarkdown(source: string) {
  $convertFromMarkdownString(
    normalizeEmailMarkdownForEditor(source),
    EMAIL_MARKDOWN_TRANSFORMERS,
    undefined,
    false,
  );
}

/**
 * The Markdown exporter escapes `_` in plain text, which turns a hand-typed
 * `{{announcement_body}}` into `{{announcement\_body}}`. Leave `{{ ... }}`
 * spans unescaped so a typed token matches an inserted one (#859).
 */
function unescapeTokenUnderscores(markdown: string) {
  return markdown.replace(/\{\{[^{}\n]*\}\}/g, (span) => span.replace(/\\_/g, "_"));
}

/**
 * Export the current editor as Markdown with a blank line between blocks, so
 * each block renders as its own paragraph. A line break inside a paragraph is
 * written as two trailing spaces and a newline. Call inside read().
 */
export function $exportEmailMarkdown() {
  return unescapeTokenUnderscores($convertToMarkdownString(EMAIL_MARKDOWN_TRANSFORMERS, undefined, false))
    .split("\n\n")
    .map((block) => (
      LIST_ITEM_LINE.test(block) ? block : block.replace(/[ \t]*\n/g, "  \n")
    ))
    .join("\n\n");
}

const MARKDOWN_LINK_PATTERN = /!?\[[^\]]*\]\([^)]*\)/g;

/**
 * True when `{{checkin_qr_url}}` appears outside a Markdown link. The token is
 * a page link, so on its own it prints the web address in the email instead of
 * showing a QR code. Written as [text]({{checkin_qr_url}}) it is a button, and
 * the QR code itself is the `checkin_qr_image` token.
 */
export function hasStandaloneCheckinQrUrl(source: string) {
  return /\{\{\s*checkin_qr_url\s*\}\}/.test(source.replace(MARKDOWN_LINK_PATTERN, ""));
}

/** What the editor needs to place uploaded pictures in a body: where they live and how to add one. */
export type MessageImageLibrary = {
  eventId: string;
  images: readonly MessageFileRecord[];
  onUploaded: (file: MessageFileRecord) => void;
};

type MessageBodyEditorProps = {
  value: string;
  tokens: readonly string[];
  /** Enables the toolbar's image button (#824). */
  imageLibrary?: MessageImageLibrary;
  /** Plain-language picker names, keyed by token. */
  tokenLabels?: Readonly<Record<string, string>>;
  maxLength?: number;
  onChange: (value: string) => void;
};

type EditorToolbarProps = {
  tokens: readonly string[];
  tokenLabels?: Readonly<Record<string, string>>;
  imageLibrary?: MessageImageLibrary;
  markChanged: () => void;
};

const BUTTON_LINK_SUGGESTIONS = ["{{portal_url}}", "{{checkin_qr_url}}"];

function EditorToolbar({ tokens, tokenLabels, imageLibrary, markChanged }: EditorToolbarProps) {
  const [editor] = useLexicalComposerContext();
  const [token, setToken] = useState(tokens[0] ?? "");
  const [panel, setPanel] = useState<"image" | "button" | null>(null);
  const [buttonText, setButtonText] = useState("");
  const [buttonUrl, setButtonUrl] = useState("");
  const [buttonError, setButtonError] = useState("");
  const [imageAlt, setImageAlt] = useState("");
  const [imageError, setImageError] = useState("");
  const [uploading, setUploading] = useState(false);

  function insertButton() {
    const text = buttonText.trim();
    const url = buttonUrl.trim();
    if (!text) {
      setButtonError("Enter the words on the button.");
      return;
    }
    if (/[[\]]/.test(text)) {
      setButtonError("Button text cannot contain square brackets.");
      return;
    }
    if (!isAllowedEmailLinkTarget(url)) {
      setButtonError("Enter a web address (https://…), a mailto: or tel: link, or a link token such as {{portal_url}}.");
      return;
    }
    markChanged();
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const node = $createMessageButtonNode(text, url);
      selection.insertNodes([node, $createTextNode(" ")]);
      node.selectNext();
    });
    setButtonText("");
    setButtonUrl("");
    setButtonError("");
    setPanel(null);
  }

  function insertImage(file: MessageFileRecord) {
    markChanged();
    const alt = imageAlt.trim().replace(/[[\]()]/g, "") || file.filename.replace(/\.[^.]+$/, "");
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      const node = $createMessageImageNode(file.id, alt);
      selection.insertNodes([node, $createTextNode(" ")]);
      node.selectNext();
    });
    setImageAlt("");
    setImageError("");
    setPanel(null);
  }

  async function uploadImage(file: File | undefined) {
    if (!file || !imageLibrary) return;
    if (file.size > MAX_INLINE_IMAGE_BYTES) {
      setImageError(`Images must be ${formatFileSize(MAX_INLINE_IMAGE_BYTES)} or smaller.`);
      return;
    }
    setUploading(true);
    setImageError("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("purpose", "inline-image");
      const response = await fetch(`/api/events/${encodeURIComponent(imageLibrary.eventId)}/message-files`, {
        method: "POST",
        body: form,
      });
      const result = await response.json().catch(() => ({})) as { file?: MessageFileRecord; message?: string };
      if (!response.ok || !result.file) throw new Error(result.message ?? "The image could not be uploaded.");
      imageLibrary.onUploaded(result.file);
      insertImage(result.file);
    } catch (caught) {
      setImageError(caught instanceof Error ? caught.message : "The image could not be uploaded.");
    } finally {
      setUploading(false);
    }
  }

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
    <>
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
        {button("Button link", <RectangleHorizontal size={16} />, () => setPanel(panel === "button" ? null : "button"))}
        {imageLibrary
          ? button("Insert image", <ImagePlus size={16} />, () => setPanel(panel === "image" ? null : "image"))
          : null}
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
              <option value={candidate} key={candidate}>
                {tokenLabels?.[candidate] ? `${tokenLabels[candidate]} — {{${candidate}}}` : `{{${candidate}}}`}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={insertToken}>Insert token</button>
      </div>
    </div>
    {panel === "button" && (
      <div className="message-editor-panel" role="group" aria-label="Insert a button link">
        <label>
          Button text
          <input value={buttonText} maxLength={60} placeholder="Open my check-in pass" onChange={(event) => setButtonText(event.target.value)} />
        </label>
        <label>
          Button link
          <input
            value={buttonUrl}
            list="message-editor-button-links"
            placeholder="https://… or {{portal_url}}"
            onChange={(event) => setButtonUrl(event.target.value)}
          />
          <datalist id="message-editor-button-links">
            {BUTTON_LINK_SUGGESTIONS.map((suggestion) => <option value={suggestion} key={suggestion} />)}
          </datalist>
        </label>
        <button type="button" className="secondary-button" onClick={insertButton}>Insert button</button>
        {buttonError ? <p className="form-error" role="alert">{buttonError}</p> : null}
        <small>A button on a line of its own is sent as a button; inside a sentence it is an ordinary link. Stored as [text](link){"{.button}"}.</small>
      </div>
    )}
    {panel === "image" && imageLibrary && (
      <div className="message-editor-panel" role="group" aria-label="Insert an image">
        <label>
          Description (shown if the picture is blocked)
          <input value={imageAlt} maxLength={120} placeholder="Map of the retreat grounds" onChange={(event) => setImageAlt(event.target.value)} />
        </label>
        <label>
          Upload a picture
          <input
            type="file"
            accept={MESSAGE_IMAGE_ACCEPT}
            disabled={uploading}
            onChange={(event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              input.value = "";
              void uploadImage(file);
            }}
          />
          <small>PNG, JPEG or WebP, {formatFileSize(MAX_INLINE_IMAGE_BYTES)} or smaller. Sent inside the email, so it shows without &quot;download pictures&quot;.</small>
        </label>
        {uploading ? <p role="status">Uploading…</p> : null}
        {imageError ? <p className="form-error" role="alert">{imageError}</p> : null}
        {imageLibrary.images.length > 0 && (
          <div className="message-editor-image-list">
            <strong>Or choose one already uploaded</strong>
            <ul>
              {imageLibrary.images.map((image) => (
                <li key={image.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={messageFileUrl(imageLibrary.eventId, image.id, "inline")} alt="" width={40} height={40} />
                  <span>{image.filename}</span>
                  <button type="button" className="secondary-button" onClick={() => insertImage(image)}>Insert</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )}
    </>
  );
}

function VisualEditor({ value, tokens, tokenLabels, imageLibrary, onChange }: MessageBodyEditorProps) {
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
          MessageImageNode,
          MessageButtonNode,
        ],
        editorState: () => {
          $importEmailMarkdown(value);
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
      <EditorToolbar tokens={tokens} tokenLabels={tokenLabels} imageLibrary={imageLibrary} markChanged={() => { userEdited.current = true; }} />
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
          const markdown = editorState.read(() => $exportEmailMarkdown());
          if (markdown !== value) onChange(markdown);
        }}
      />
    </LexicalComposer>
  );
}

export function MessageBodyEditor({
  value,
  tokens,
  tokenLabels,
  imageLibrary,
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
        <VisualEditor value={value} tokens={tokens} tokenLabels={tokenLabels} imageLibrary={imageLibrary} onChange={onChange} />
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
            Source mode supports headings, bold, italic, lists, links, inline code, rules, and template tokens. A link alone on its own line with {"{.button}"} after it, [Text](https://…){"{.button}"}, is sent as a button. An uploaded picture is ![description](msgfile:…); insert it from the visual editor.
          </small>
        </div>
      )}
      {hasStandaloneCheckinQrUrl(value) ? (
        <p className="message-editor-warning" role="status">
          <strong>{"{{checkin_qr_url}}"} is a page link, not a QR code.</strong>{" "}
          On its own it prints a web address in the email. Write it as a link, for example
          [Open my check-in pass]({"{{checkin_qr_url}}"}), or use the Check-in QR code (image) token to show the code itself.
        </p>
      ) : null}
      <div className="message-editor-footer">
        <span>Visual formatting is converted to the Markdown stored by existing template versions.</span>
        <span>{value.length.toLocaleString()} / {maxLength.toLocaleString()}</span>
      </div>
    </div>
  );
}
