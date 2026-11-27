// What each unit draws. Units never read the layout: they fill the slot they are given.
import { Arrange } from "../arrange/Arrange";
import { Deck } from "../deck/Deck";
import { WaveStack } from "../deck/WaveStack";
import { Inspector } from "../library/Inspector";
import { LibraryMain } from "../library/Library";
import { Sidebar } from "../library/Sidebar";
import { Mixer } from "../mixer/Mixer";
import { ToolBody } from "../shell/ToolPanel";
import type { UnitId } from "../../lib/layout/model";
import { useApp } from "../../store/app";

function Waves() {
  const count = useApp((s) => s.settings?.decks ?? 2);
  const loaded = useApp((s) => s.decks.map((d) => (d ? 1 : 0)).join(""));
  // Empty C and D lanes would only take space, as on the Mix screen today.
  const decks = count > 2 ? [0, 1, 2, 3].filter((d) => d < 2 || loaded[d] === "1") : [0, 1];
  return <WaveStack decks={decks} />;
}

function DeckUnit({ deck }: { deck: number }) {
  const four = useApp((s) => (s.settings?.decks ?? 2) > 2);
  return <Deck deck={deck} compact={four} />;
}

function MixerUnit() {
  const count = useApp((s) => s.settings?.decks ?? 2);
  return <Mixer count={count} />;
}

/** A panel that was drawn at a fixed width beside the library, stretched to fill its part. */
const Fill = ({ children }: { children: React.ReactNode }) => <div className="flex min-h-0 min-w-0 flex-1 [&>aside]:!flex [&>aside]:!w-full [&>aside]:border-l-0 [&>*]:min-w-0 [&>*]:flex-1">{children}</div>;

const Panel = ({ children }: { children: React.ReactNode }) => <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-zinc-900/40">{children}</div>;

export function UnitView({ unit }: { unit: UnitId }) {
  switch (unit) {
    case "waves":
      return <Waves />;
    case "deck.A":
      return <DeckUnit deck={0} />;
    case "deck.B":
      return <DeckUnit deck={1} />;
    case "deck.C":
      return <DeckUnit deck={2} />;
    case "deck.D":
      return <DeckUnit deck={3} />;
    case "mixer":
      return <MixerUnit />;
    case "library":
      return (
        <Panel>
          <LibraryMain standalone />
        </Panel>
      );
    case "sidebar":
      return (
        <Panel>
          <Fill>
            <Sidebar />
          </Fill>
        </Panel>
      );
    case "details":
      return (
        <Panel>
          <Fill>
            <Inspector placeholder />
          </Fill>
        </Panel>
      );
    case "tool.pads":
      return <ToolBody tab="pads" />;
    case "tool.steps":
      return <ToolBody tab="steps" />;
    case "tool.effects":
      return <ToolBody tab="effects" />;
    case "tool.mic":
      return <ToolBody tab="inputs" />;
    case "tool.record":
      return <ToolBody tab="recording" />;
    case "arrange":
      return <Arrange />;
    default:
      // Not a part of its own yet (see NOT_YET in units.ts); never drawn.
      return null;
  }
}
