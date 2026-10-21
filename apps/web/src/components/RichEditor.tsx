import { forwardRef, useEffect, useImperativeHandle, type ReactNode } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Bold, Code2, ImageIcon, Italic, Link2, List, ListOrdered, Quote, Redo2, RemoveFormatting, Underline as UnderlineIcon, Undo2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui";

export interface RichEditorHandle {
  insertText: (text: string) => void;
  focus: () => void;
  editor: Editor | null;
}

function ToolButton({ label, active, onClick, children, disabled }: { label: string; active?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={cn("rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text disabled:opacity-40", active && "bg-panel-2 text-text")}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** HTML email editor (tiptap). `toolbarExtra` renders extra buttons such as "insert variable". */
export const RichEditor = forwardRef<RichEditorHandle, {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
  toolbarExtra?: ReactNode;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  bare?: boolean;
  /** The text itself got focus (not the toolbar or a menu it opened). */
  onFocus?: () => void;
}>(function RichEditor({ value, onChange, placeholder, minHeight = 160, toolbarExtra, className, autoFocus, disabled, bare, onFocus }, ref) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }),
      Image.configure({ inline: true }),
      Placeholder.configure({ placeholder: placeholder ?? "" }),
    ],
    content: value || "",
    editable: !disabled,
    autofocus: autoFocus ? "end" : false,
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? "" : e.getHTML()),
    onFocus: () => onFocus?.(),
    editorProps: { attributes: { class: "tiptap prose-mail focus:outline-none px-3 py-2.5", style: `min-height:${minHeight}px` } },
  });

  // Keep external value changes (switching variants, loading data) in sync without clobbering typing.
  useEffect(() => {
    if (!editor) return;
    const current = editor.isEmpty ? "" : editor.getHTML();
    if ((value || "") !== current) editor.commands.setContent(value || "", false);
  }, [value, editor]);

  useEffect(() => {
    // No update event: toggling editability is not an edit, and emitting one marks untouched forms as changed.
    editor?.setEditable(!disabled, false);
  }, [disabled, editor]);

  useImperativeHandle(ref, () => ({
    insertText: (text: string) => editor?.chain().focus().insertContent(text).run(),
    focus: () => editor?.commands.focus(),
    editor,
  }));

  const setLink = () => {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "https://");
    if (url === null) return;
    if (!url) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };
  const addImage = () => {
    const url = window.prompt("Image URL", "https://");
    if (url) editor?.chain().focus().setImage({ src: url }).run();
  };

  return (
    <div className={cn(!bare && "rounded-lg border border-line-strong bg-panel focus-within:border-brand focus-within:ring-2 focus-within:ring-[var(--ring)]", className)}>
      {!disabled && (
        <div className="flex flex-wrap items-center gap-0.5 border-b border-line px-1.5 py-1">
          <ToolButton label="Bold" active={editor?.isActive("bold")} onClick={() => editor?.chain().focus().toggleBold().run()}>
            <Bold size={15} />
          </ToolButton>
          <ToolButton label="Italic" active={editor?.isActive("italic")} onClick={() => editor?.chain().focus().toggleItalic().run()}>
            <Italic size={15} />
          </ToolButton>
          <ToolButton label="Underline" active={editor?.isActive("underline")} onClick={() => editor?.chain().focus().toggleUnderline().run()}>
            <UnderlineIcon size={15} />
          </ToolButton>
          <ToolButton label="Link" active={editor?.isActive("link")} onClick={setLink}>
            <Link2 size={15} />
          </ToolButton>
          <ToolButton label="Bulleted list" active={editor?.isActive("bulletList")} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
            <List size={15} />
          </ToolButton>
          <ToolButton label="Numbered list" active={editor?.isActive("orderedList")} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
            <ListOrdered size={15} />
          </ToolButton>
          <ToolButton label="Quote" active={editor?.isActive("blockquote")} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>
            <Quote size={15} />
          </ToolButton>
          <ToolButton label="Code" active={editor?.isActive("code")} onClick={() => editor?.chain().focus().toggleCode().run()}>
            <Code2 size={15} />
          </ToolButton>
          <ToolButton label="Image" onClick={addImage}>
            <ImageIcon size={15} />
          </ToolButton>
          <ToolButton label="Clear formatting" onClick={() => editor?.chain().focus().unsetAllMarks().clearNodes().run()}>
            <RemoveFormatting size={15} />
          </ToolButton>
          <span className="mx-1 h-4 w-px bg-line" />
          <ToolButton label="Undo" disabled={!editor?.can().undo()} onClick={() => editor?.chain().focus().undo().run()}>
            <Undo2 size={15} />
          </ToolButton>
          <ToolButton label="Redo" disabled={!editor?.can().redo()} onClick={() => editor?.chain().focus().redo().run()}>
            <Redo2 size={15} />
          </ToolButton>
          {toolbarExtra && <div className="ml-auto flex items-center gap-1">{toolbarExtra}</div>}
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
});
