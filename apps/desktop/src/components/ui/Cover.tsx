// A track's cover art, or a quiet two-colour square with a disc when it has none.
import clsx from "clsx";
import { Disc3 } from "lucide-react";
import { placeholderColors, useArtwork } from "../../lib/artwork";

export function Cover({ trackId, has, title, artist, size, className, rounded = "rounded-md", quiet = false }: { trackId: number | null | undefined; has?: boolean; title: string; artist?: string; size: number; className?: string; rounded?: string; /** No placeholder when there is no cover (busy lists). */ quiet?: boolean }) {
  // Twice the size on screen, for sharp covers on high-density displays.
  const px = size <= 32 ? 64 : size <= 64 ? 128 : 256;
  const url = useArtwork(trackId, has, px);
  const [a, b] = placeholderColors(`${title}|${artist ?? ""}`);
  if (quiet && !url) return <div className={clsx("shrink-0", rounded, className)} style={{ width: size, height: size }} data-testid="cover" data-has-art="no" />;
  return (
    <div className={clsx("relative shrink-0 overflow-hidden", rounded, className)} style={{ width: size, height: size, background: url ? undefined : `linear-gradient(135deg, ${a}, ${b})` }} data-testid="cover" data-has-art={url ? "yes" : "no"}>
      {url ? <img src={url} alt="" className="size-full object-cover" draggable={false} /> : <Disc3 size={Math.max(10, size * 0.45)} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white/25" />}
    </div>
  );
}
