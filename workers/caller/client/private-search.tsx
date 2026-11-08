import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo";
import { privateSearchStateSchema, type PrivateSearchView } from "../../../shared/private-search";

import { errorSchema, type ActionInput } from "../../../shared/schemas";

type PrivateCommand = ActionInput & { action: string };

type Selection = { search: string; ids: string[] };

export function PrivateSearchPanel() {
  const [view, setView] = useState<PrivateSearchView>();
  const [continuity, setContinuity] = useState(false);
  const [query, setQuery] = useState("warmer jacket");
  const [lose, setLose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<Selection>({ search: "", ids: [] });
  const searchKey = `${view?.query ?? ""}:${view?.accepted_searches ?? ""}`;

  const selected =
    selection.search === searchKey ? selection.ids : (view?.results.map((p) => p.id) ?? []);

  const mounted = useRef(false);
  const revision = useRef(0);
  useEffect(() => {
    const polling = { disposed: false, reading: false };
    mounted.current = true;

    const read = async () => {
      if (polling.disposed || polling.reading) return;
      polling.reading = true;
      const current = revision.current;

      try {
        const r = await fetch("/api/state");

        if (!r.ok) return;
        const s = privateSearchStateSchema.parse(await r.json());

        if (polling.disposed || current !== revision.current) return;
        setView(s.private_access);
        setContinuity(!!s.session_id);
      } catch {
        /* Actions report errors; polling can retry. */
      } finally {
        polling.reading = false;
      }
    };

    void read();
    const timer = setInterval(read, 1000);

    return () => {
      polling.disposed = true;
      mounted.current = false;
      clearInterval(timer);
    };
  }, []);

  const action = async (name: string) => {
    revision.current += 1;
    setBusy(true);
    setError("");

    try {
      const command: PrivateCommand = { action: name };

      if (name === "private-search") {
        command.text = query;
        command.lose_response = lose;
      }

      if (name === "remember-shortlist") command.product_ids = selected;

      const r = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });

      const payload = await r.json();

      if (!r.ok) throw new Error(errorSchema.parse(payload).error);
      const s = privateSearchStateSchema.parse(payload);

      if (!mounted.current) return;
      revision.current += 1;
      setView(s.private_access);

      if (s.session_id) setContinuity(true);
      setLose(false);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  if (!view?.available) return null;

  return (
    <section
      aria-label="Private search demo"
      className="space-y-4 rounded-2xl border border-kumo-line bg-kumo-base p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
            Northstar · MOLE + Poppy
          </p>
          <h2 className="mt-1 text-lg font-semibold">Browse privately. Remember by choice.</h2>
        </div>
        <span className="rounded-full bg-kumo-elevated px-3 py-1 text-xs">
          {view?.pending
            ? "Update pending"
            : view?.balance == null
              ? "24 credits on first search"
              : `${view.balance} credits in your wallet`}
        </span>
      </div>
      <p className="text-sm text-kumo-subtle">
        Search costs 1 credit. Northstar receives the query and a MOLE proof; the search request
        carries no Poppy user, session or account credential.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action("private-search");
        }}
        className="space-y-3"
      >
        <label className="block text-sm font-medium">
          Find a jacket
          <input
            aria-label="Private search query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={80}
            disabled={busy || view?.pending}
            className="mt-1 block w-full rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy || view?.pending || !query.trim()}>
            {busy ? "Working…" : "Search privately"}
          </Button>
          <label className="flex items-center gap-2 text-xs text-kumo-subtle">
            <input
              type="checkbox"
              checked={lose}
              disabled={busy || view?.pending}
              onChange={(e) => setLose(e.target.checked)}
            />{" "}
            Lose the next search response
          </label>
        </div>
      </form>
      {view?.pending ? (
        <output className="block space-y-2 rounded-lg bg-kumo-elevated p-3">
          <p className="text-sm">
            A search is pending. Recovery resends the saved request and returns its recorded result.
            It spends no extra credit. Recover within 60 seconds.
          </p>
          <Button disabled={busy} onClick={() => void action("recover-private-search")}>
            Recover search
          </Button>
        </output>
      ) : null}
      {view?.results.length ? (
        <div className="space-y-3">
          {view.results.map((p) => (
            <label
              key={p.id}
              aria-label={`Select ${p.name}`}
              className="flex items-start gap-3 rounded-lg border border-kumo-line p-3"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.includes(p.id)}
                disabled={busy || view.shared}
                onChange={(e) =>
                  setSelection({
                    search: searchKey,
                    ids: e.target.checked
                      ? [...selected, p.id]
                      : selected.filter((id) => id !== p.id),
                  })
                }
              />
              <span>
                <span className="text-sm font-semibold">
                  {p.name} · ${p.price}
                </span>
                <span className="mt-1 block text-xs text-kumo-subtle">{p.description}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-kumo-subtle">
            {view.recovered ? "Recovered the recorded search. " : ""}Store executions:{" "}
            {view.accepted_searches} across this demo. Balance is visible to your client.
          </p>
          <div className="space-y-2 border-t border-kumo-line pt-3">
            <p className="text-sm">
              Saving shares the checked products and a persistent Poppy pseudonym with Northstar.
              Your private query history and MOLE wallet stay out of that message.
            </p>
            <Button
              disabled={busy || view.shared || !selected.length}
              onClick={() => void action("remember-shortlist")}
            >
              {view.shared ? "Shortlist saved with Poppy" : "Save shortlist with Poppy"}
            </Button>
          </div>
        </div>
      ) : null}
      <p className="text-xs text-kumo-subtle">
        {continuity
          ? "Poppy continuity is active. Account access still requires separate sign-in approval."
          : "No Poppy session has been created."}{" "}
        Synthetic allowance: one grant per caller wallet per day. Single-operator prototype; network
        metadata can still correlate requests.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-kumo-danger">
          {error.replaceAll("_", " ")}
        </p>
      ) : null}
      {view?.exchanges.length ? (
        <details className="text-xs text-kumo-subtle">
          <summary className="cursor-pointer">See protocol exchanges</summary>
          <ol className="mt-2 space-y-1 font-mono">
            {view.exchanges.map((e, i) => (
              <li key={i}>
                {e.method} {e.path} → {e.status}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}
