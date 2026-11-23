import { Fragment, useEffect, useState } from "react";
import { api, type StandardChange, type StandardView, type User } from "../api.ts";

export function StandardsPage({ user }: { user: User }) {
  const [standards, setStandards] = useState<StandardView[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [changes, setChanges] = useState<StandardChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const canEdit = user.role === "approver";

  useEffect(() => {
    api.standards().then(setStandards).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    setChanges(null);
    if (open) api.standardChanges(open).then(setChanges).catch((e: Error) => setError(e.message));
  }, [open]);

  async function toggle(s: StandardView) {
    setBusy(s.id);
    setError(null);
    try {
      const updated = await api.setStandardEnabled(s.id, !s.enabled);
      setStandards((list) => list?.map((x) => (x.id === updated.id ? updated : x)) ?? null);
      if (open === s.id) setChanges(await api.standardChanges(s.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <div className="row spread">
        <h2>Engineering standards</h2>
        <span className="muted small">
          {canEdit ? "You are an approver: you can enable or disable standards." : "Only approvers can enable or disable standards."}
        </span>
      </div>
      <p className="muted">
        Standards live in <code>standards/*.yaml</code> in the repo and are loaded into the database by the seed script.
        Each version is kept, so old reviews still show the rule they ran against.
      </p>
      {error && <div className="error">{error}</div>}
      {standards && (
        <table className="table">
          <thead>
            <tr><th>Standard</th><th>Severity</th><th>Detector</th><th>Version</th><th>Status</th><th>Last change</th></tr>
          </thead>
          <tbody>
            {standards.map((s) => (
              <Fragment key={s.id}>
                <tr className="clickable" onClick={() => setOpen(open === s.id ? null : s.id)}>
                  <td><strong>{s.id}</strong> {s.title}</td>
                  <td><span className={`sev sev-${s.severity}`}>{s.severity}</span></td>
                  <td><code>{s.detector}</code></td>
                  <td><code>{s.contentHash.slice(0, 8)}</code></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <label className={`switch ${canEdit ? "" : "locked"}`} title={canEdit ? "" : "Approvers only"}>
                      <input type="checkbox" checked={s.enabled && !s.retiredAt} disabled={!canEdit || !!s.retiredAt || busy === s.id} onChange={() => toggle(s)} />
                      <span>{s.retiredAt ? "retired" : s.enabled ? "enabled" : "disabled"}</span>
                    </label>
                  </td>
                  <td className="muted small">{s.updatedBy ? `${s.updatedBy.name}, ${new Date(s.updatedAt).toLocaleString()}` : "never changed"}</td>
                </tr>
                {open === s.id && (
                  <tr className="expanded">
                    <td colSpan={6}>
                      <p>{s.rule}</p>
                      {s.compliant && (<><div className="label">Compliant</div><pre className="evidence ok">{s.compliant}</pre></>)}
                      {s.violating && (<><div className="label">Violating</div><pre className="evidence bad">{s.violating}</pre></>)}
                      <div className="label">Change log</div>
                      {!changes && <p className="muted">Loading…</p>}
                      {changes && changes.length === 0 && <p className="muted">No changes recorded.</p>}
                      {changes && changes.length > 0 && (
                        <ul className="log">
                          {changes.map((c) => (
                            <li key={c.id}>
                              {new Date(c.changedAt).toLocaleString()}: <strong>{c.changedBy.name}</strong> set {c.field}{" "}
                              {c.oldValue} → {c.newValue}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
