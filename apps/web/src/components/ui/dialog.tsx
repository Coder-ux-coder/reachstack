import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import { Input } from "./form";

/**
 * A dialog opens with the cursor in its first text field rather than on the close button. Only with a mouse: on a
 * phone that would pop up the keyboard. A field with autoFocus still wins (Radix skips this when focus is inside).
 */
function focusFirstField(e: Event) {
  if (!window.matchMedia?.("(pointer: fine)").matches) return;
  const field = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
    "[data-dialog-body] :is(input:not([type=hidden],[type=checkbox],[type=radio],[type=file],[type=range]):not(:disabled,[readonly]), textarea:not(:disabled,[readonly]), [contenteditable=true])",
  );
  if (!field) return;
  e.preventDefault();
  field.focus();
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  className,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const width = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px] data-[state=open]:animate-in" />
        <RD.Content
          onOpenAutoFocus={focusFirstField}
          className={cn(
            "animate-in fixed left-1/2 top-[8vh] z-50 flex max-h-[84vh] w-[calc(100vw-2rem)] -translate-x-1/2 flex-col rounded-xl border border-line bg-panel shadow-2xl focus:outline-none",
            width,
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <RD.Title className="text-base font-semibold">{title}</RD.Title>
              {description ? <RD.Description className="mt-1 text-[13px] text-muted">{description}</RD.Description> : <RD.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</RD.Description>}
            </div>
            <RD.Close className="rounded-md p-1 text-faint hover:bg-panel-2 hover:text-text" aria-label="Close">
              <X size={16} />
            </RD.Close>
          </div>
          {children && (
            <div data-dialog-body className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {children}
            </div>
          )}
          {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/** Right-hand panel for record details (lead, account, email). */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = "max-w-xl",
  actions,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  actions?: ReactNode;
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <RD.Content className={cn("fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-panel shadow-2xl focus:outline-none", width)}>
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <RD.Title className="truncate text-base font-semibold">{title}</RD.Title>
              {description ? <RD.Description className="mt-0.5 truncate text-[13px] text-muted">{description}</RD.Description> : <RD.Description className="sr-only">Details</RD.Description>}
            </div>
            <div className="flex items-center gap-1">
              {actions}
              <RD.Close className="rounded-md p-1.5 text-faint hover:bg-panel-2 hover:text-text" aria-label="Close">
                <X size={16} />
              </RD.Close>
            </div>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  /** The button that backs out, when "Cancel" would read as the action itself. */
  cancelLabel?: string;
  danger?: boolean;
  /** Ask the user to type this text before confirming (destructive actions). */
  typeToConfirm?: string;
}

const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState("");
  const resolver = useRef<(v: boolean) => void>(undefined);
  const confirm = useCallback((o: ConfirmOptions) => {
    setTyped("");
    setOpts(o);
    return new Promise<boolean>((res) => (resolver.current = res));
  }, []);
  const close = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = undefined;
    setOpts(null);
  };
  const blocked = !!opts?.typeToConfirm && typed.trim() !== opts.typeToConfirm;
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={!!opts}
        onOpenChange={(v) => !v && close(false)}
        size="sm"
        title={opts?.title ?? ""}
        description={opts?.description}
        footer={
          <>
            <Button onClick={() => close(false)}>{opts?.cancelLabel ?? "Cancel"}</Button>
            <Button variant={opts?.danger ? "danger" : "primary"} disabled={blocked} onClick={() => close(true)} autoFocus={!opts?.typeToConfirm}>
              {opts?.confirmLabel ?? "Confirm"}
            </Button>
          </>
        }
      >
        {opts?.typeToConfirm ? (
          <div>
            <p className="mb-2 text-[13px] text-muted">
              Type <span className="font-mono font-medium text-text">{opts.typeToConfirm}</span> to confirm.
            </p>
            <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !blocked && close(true)} />
          </div>
        ) : null}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);
