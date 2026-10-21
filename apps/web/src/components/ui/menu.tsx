import * as RM from "@radix-ui/react-dropdown-menu";
import * as RP from "@radix-ui/react-popover";
import * as RT from "@radix-ui/react-tooltip";
import { Check, ChevronRight, MoreHorizontal } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

const surface = "animate-in z-50 min-w-[11rem] rounded-lg border border-line bg-panel p-1 shadow-lg";
const item =
  "relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-panel-2";

export const Menu = RM.Root;
export const MenuTrigger = RM.Trigger;

export function MenuContent({ children, align = "end", className }: { children: ReactNode; align?: "start" | "end" | "center"; className?: string }) {
  return (
    <RM.Portal>
      <RM.Content
        align={align}
        sideOffset={4}
        collisionPadding={8}
        // A long menu never runs past the window: it takes the side with more room and scrolls inside.
        className={cn(surface, "scroll-thin max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto", className)}
        onCloseAutoFocus={(e) => {
          // An item that opened a dialog: leave focus where the dialog put it instead of pulling it back to the trigger.
          if (document.activeElement?.closest("[role=dialog]")) e.preventDefault();
        }}
      >
        {children}
      </RM.Content>
    </RM.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  icon,
  danger,
  disabled,
  shortcut,
}: {
  children: ReactNode;
  onSelect?: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    // The action runs once the menu has closed and released focus, so a dialog it opens keeps its autofocused field.
    <RM.Item disabled={disabled} onSelect={onSelect && (() => setTimeout(onSelect, 0))} className={cn(item, danger && "text-bad")}>
      {icon && <span className={cn("flex w-4 justify-center", danger ? "text-bad" : "text-muted")}>{icon}</span>}
      <span className="flex-1">{children}</span>
      {shortcut && <span className="text-xs text-faint">{shortcut}</span>}
    </RM.Item>
  );
}

export function MenuCheckItem({ children, checked, onChange }: { children: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <RM.CheckboxItem checked={checked} onCheckedChange={onChange} onSelect={(e) => e.preventDefault()} className={cn(item, "pl-8")}>
      <RM.ItemIndicator className="absolute left-2.5">
        <Check size={14} className="text-brand" />
      </RM.ItemIndicator>
      {children}
    </RM.CheckboxItem>
  );
}

export function MenuSub({ label, icon, children }: { label: ReactNode; icon?: ReactNode; children: ReactNode }) {
  return (
    <RM.Sub>
      <RM.SubTrigger className={item}>
        {icon && <span className="flex w-4 justify-center text-muted">{icon}</span>}
        <span className="flex-1">{label}</span>
        <ChevronRight size={14} className="text-faint" />
      </RM.SubTrigger>
      <RM.Portal>
        <RM.SubContent sideOffset={6} collisionPadding={8} className={cn(surface, "scroll-thin max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto")}>
          {children}
        </RM.SubContent>
      </RM.Portal>
    </RM.Sub>
  );
}

export const MenuSeparator = () => <RM.Separator className="my-1 h-px bg-line" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <RM.Label className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-faint">{children}</RM.Label>;

/** "⋯" row actions menu. */
export function RowMenu({ children, label = "More actions" }: { children: ReactNode; label?: string }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" aria-label={label} onClick={(e) => e.stopPropagation()} className="rounded-md p-1.5 text-faint hover:bg-panel-2 hover:text-text">
          <MoreHorizontal size={16} />
        </button>
      </MenuTrigger>
      <MenuContent>{children}</MenuContent>
    </Menu>
  );
}

export function Popover({
  trigger,
  children,
  align = "start",
  className,
  open,
  onOpenChange,
  collisionPadding,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "end" | "center";
  className?: string;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  /** Space to keep from the window's edges (px). */
  collisionPadding?: number;
}) {
  return (
    <RP.Root open={open} onOpenChange={onOpenChange}>
      <RP.Trigger asChild>{trigger}</RP.Trigger>
      <RP.Portal>
        <RP.Content align={align} sideOffset={6} collisionPadding={collisionPadding} className={cn("animate-in z-50 rounded-xl border border-line bg-panel p-3 shadow-lg focus:outline-none", className)}>
          {children}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}

export const PopoverClose = RP.Close;

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  // The same elements whether or not there's a hint, so a button whose hint comes and goes isn't replaced (and keeps
  // keyboard focus); without one it never opens.
  const [open, setOpen] = useState(false);
  return (
    <RT.Root delayDuration={250} open={!!content && open} onOpenChange={setOpen}>
      <RT.Trigger asChild>{children}</RT.Trigger>
      {!!content && (
        <RT.Portal>
          <RT.Content side={side} sideOffset={5} className="z-[60] max-w-xs rounded-md bg-[#15161c] px-2 py-1 text-xs leading-snug text-white shadow-lg dark:bg-[#ececf1] dark:text-[#15161c]">
            {content}
          </RT.Content>
        </RT.Portal>
      )}
    </RT.Root>
  );
}

export const TooltipProvider = RT.Provider;
