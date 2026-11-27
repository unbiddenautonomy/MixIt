// Edit layout mode (Nachi's choice: parts are moved by dragging only in this mode, so a
// slip while playing never rearranges the screen). The button turns it on; the bar across
// the top of each window says what to do, and holds Undo, Redo, saved layouts and Done.
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { LayoutDashboard, Redo2, Undo2 } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { isMainWindow } from "../../lib/screens";
import { shortcutLabel } from "../../lib/actions";
import { applySavedPreset, applyStandard, deletePreset, editStep, renameSavedPreset, savePreset, setEditing, useLayout } from "../../store/layout";
import { ask, askText } from "../shell/Dialogs";
import { Btn } from "../ui/Button";

/** The top bar's switch for Edit layout mode. */
export function EditLayoutButton() {
  const editing = useLayout((s) => s.editing);
  return (
    <Btn size="sm" tone="ghost" active={editing} onClick={() => setEditing(!editing)} aria-label={editing ? "Finish editing the layout" : "Edit the layout: move parts by dragging their tabs"} title={editing ? "Finish editing the layout (Esc)" : "Edit the layout: drag parts to move them"}>
      <LayoutDashboard size={14} />
      <span className="hidden xl:inline">{editing ? "Done" : "Edit layout"}</span>
    </Btn>
  );
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/** Esc, ⌘Z and ⌘⇧Z while editing. Returns nothing; listens while mounted. */
function useEditKeys(editing: boolean, dragging: () => boolean) {
  useEffect(() => {
    if (!editing) return;
    const key = (e: KeyboardEvent) => {
      if (typing(e.target) || dragging()) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") setEditing(false);
      else if (mod && e.key.toLowerCase() === "z") editStep(e.shiftKey ? "redo" : "undo");
      else if (mod && e.key.toLowerCase() === "y") editStep("redo");
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [editing, dragging]);
}

export function EditBar({ dragging }: { dragging: () => boolean }) {
  const editing = useLayout((s) => s.editing);
  const canUndo = useLayout((s) => s.canUndo);
  const canRedo = useLayout((s) => s.canRedo);
  useEditKeys(editing, dragging);
  if (!editing) return null;
  return (
    <div role="toolbar" aria-label="Edit layout" data-testid="edit-bar" className="mb-1 flex shrink-0 items-center gap-2 rounded-lg border border-[var(--accent)]/30 bg-[var(--accent)]/[0.07] px-2 py-1 text-xs text-zinc-300">
      <span className="min-w-0 flex-1 truncate">Drag a part by its name onto an edge to put it beside another part, or onto the middle to make it a tab.</span>
      <Btn size="sm" tone="ghost" disabled={!canUndo} onClick={() => editStep("undo")} aria-label="Undo the last layout change" title={`Undo (${shortcutLabel("Mod+Z")})`}>
        <Undo2 size={13} />
      </Btn>
      <Btn size="sm" tone="ghost" disabled={!canRedo} onClick={() => editStep("redo")} aria-label="Redo" title={`Redo (${shortcutLabel("Mod+Shift+Z")})`}>
        <Redo2 size={13} />
      </Btn>
      {isMainWindow && <Saved />}
      <Btn size="sm" onClick={() => setEditing(false)}>
        Done
      </Btn>
    </div>
  );
}

/** Saved layouts: apply one, save this one under a name, rename or delete. */
function Saved() {
  const presets = useLayout((s) => s.presets);
  const saveAs = async () => {
    const name = await askText({ title: "Save this layout", placeholder: "Home studio, Club with projector…", confirm: "Save", help: "You can switch to it any time from here, on any screens." });
    if (name == null) return;
    if (presets.some((p) => p.name.toLowerCase() === name.trim().toLowerCase()) && !(await ask({ title: `Replace "${name.trim()}"?`, body: "A saved layout already has that name.", confirm: "Replace" }))) return;
    const why = savePreset(name);
    if (why) toast.message(why);
    else toast.success(`Saved as "${name.trim() || "My layout"}".`);
  };
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Btn size="sm" tone="ghost" aria-label="Saved layouts">
          Layouts
        </Btn>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="menu">
          <DropdownMenu.Item className="menu-item" onSelect={() => applyStandard()}>
            The standard layout
          </DropdownMenu.Item>
          {presets.map((p) => (
            <DropdownMenu.Sub key={p.id}>
              <DropdownMenu.SubTrigger className="menu-item">{p.name}</DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="menu" sideOffset={4}>
                  <DropdownMenu.Item
                    className="menu-item"
                    onSelect={() => {
                      const why = applySavedPreset(p.id);
                      if (why) toast.message(why);
                    }}
                  >
                    Use this layout
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="menu-item"
                    onSelect={async () => {
                      const name = await askText({ title: "Rename this layout", initial: p.name, confirm: "Rename" });
                      if (name != null) renameSavedPreset(p.id, name);
                    }}
                  >
                    Rename…
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    className="menu-item text-red-300"
                    onSelect={async () => {
                      if (await ask({ title: `Delete "${p.name}"?`, body: "The layout showing now stays as it is.", confirm: "Delete", danger: true })) deletePreset(p.id);
                    }}
                  >
                    Delete…
                  </DropdownMenu.Item>
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-white/[0.06]" />
          <DropdownMenu.Item className="menu-item" onSelect={() => void saveAs()}>
            Save this layout…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
