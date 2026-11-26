// Settings, About: updating MixIt from the folder it was built in (git pull, rebuild,
// replace the app, restart). See src/lib/update.ts and src-tauri/src/update.rs.
import { Loader2, RefreshCw } from "lucide-react";
import { backend } from "../../backend";
import { updateSettings } from "../../lib/appCommands";
import { checkForUpdate, startUpdate, useUpdate } from "../../lib/update";
import { useApp } from "../../store/app";
import { Btn } from "../ui/Button";

export function Updates() {
  const info = useApp((s) => s.info);
  const checkOn = useApp((s) => s.settings?.checkUpdates !== false);
  const job = useApp((s) => s.jobs.update);
  const { status, checking, ready } = useUpdate();
  const building = !!job && !job.finished;
  if (backend().kind !== "tauri") return null;
  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-white/[0.06] pt-4" data-testid="updates">
      <div className="text-sm font-semibold text-zinc-100">Updates</div>
      <p className="text-zinc-400">
        MixIt updates itself from the folder it was built in: it gets the new code with git, builds the new app (about 5 to 15 minutes, while you keep using this one) and puts it in place. Then restart to use it.
        {info?.builtFrom ? <span className="text-zinc-500"> This copy is version {info.builtFrom.slice(0, 7)}.</span> : null}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Btn size="sm" onClick={() => void checkForUpdate()} disabled={checking || building}>
          {checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Check for updates
        </Btn>
        {status && status.waiting > 0 && status.canInstall && !building && !ready && (
          <Btn size="sm" tone="accent" onClick={startUpdate} data-testid="update-now">
            Update now
          </Btn>
        )}
        {building && (
          <Btn size="sm" onClick={() => void backend().updateCancel()}>
            Stop
          </Btn>
        )}
        {ready && (
          <Btn size="sm" tone="accent" onClick={() => void backend().updateRestart()}>
            Restart now
          </Btn>
        )}
      </div>
      {building && (
        <div className="flex items-center gap-2 text-zinc-300">
          <Loader2 size={12} className="animate-spin text-sky-300" />
          <span className="min-w-0 flex-1 truncate">{job.message}</span>
        </div>
      )}
      {status && !building && (
        <div className="text-zinc-400">
          {status.problem ? (
            <p className="text-amber-300/90">{status.problem}</p>
          ) : status.waiting === 0 ? (
            <p>You have the newest version ({status.branch}, {status.latest}).</p>
          ) : (
            <>
              <p>
                {status.waiting} {status.waiting === 1 ? "change is" : "changes are"} waiting on {status.branch}:
              </p>
              <ul className="ml-4 mt-1 list-disc text-zinc-500">
                {status.changes.slice(0, 8).map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </>
          )}
          {status.source && <p className="mt-1 text-[11px] text-zinc-600">From {status.source}</p>}
        </div>
      )}
      <label className="flex items-center gap-2 text-zinc-300">
        <input type="checkbox" checked={checkOn} onChange={(e) => void updateSettings({ checkUpdates: e.target.checked })} />
        Tell me when an update is ready (checks a little after MixIt starts)
      </label>
    </div>
  );
}
