import { useEffect, useState } from "react";
import { type Client, CLIENTS } from "../agents";
import { agentClients, type Audit, connectAgent, corePath, type Grant, inBackground, isDesktop, op } from "../api";
import { ago, groupLabel, GROUPS, when } from "../format";
import { locale as i18nLocale, t, tk } from "../i18n";
import { backBy, go as nav } from "../router";
import { Btn, card, Copy, DAY, errText, Group, GroupIcon, Heading, Item, Problem, SwitchRow, useOp, writeText } from "../ui";

/** A card's title, with one button that turns every switch in it on (or, when all are on, off). */
function CardHead({ title, on, set }: { title: string; on: boolean; set: (on: boolean) => void }) {
  return (
    <div className="mt-6 mb-2 flex items-center justify-between px-4">
      <h4 className="text-[13px] font-semibold text-black/55 dark:text-white/55">{title}</h4>
      <Btn type="button" link onClick={() => set(!on)}>
        {on ? t("Select none") : t("Select all")}
      </Btn>
    </div>
  );
}

const windowText = (w: Grant["window"]) =>
  w === "all" ? t("all time") : "last_days" in w ? t("last {{n}} days", { n: w.last_days }) : t("a date range");

const EXPIRY: [number, string][] = [
  [30, tk("30 days")],
  [90, tk("90 days")],
  [365, tk("1 year")],
];

/** After a grant is made: how to plug it into the chosen app, one click where the shell can do it. */
function ConnectSteps({ client, token, bin, found, done }: { client: Client; token: string; bin: string; found: boolean; done: () => void }) {
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const oneClick = client.oneClick && isDesktop;
  return (
    <div className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]" role="status">
      <h3 className="mb-2 text-[17px] font-semibold">{t("Connect {{name}}", { name: client.name })}</h3>
      {oneClick && (
        <>
          <p>
            {found ? t("{{name}} is on this computer.", { name: client.name }) : t("{{name}}'s settings folder wasn't found; it is created if you go ahead.", { name: client.name })}{" "}
            {t("PhysiMind can add itself to its settings for you. Other servers there are kept, and the original file is saved next to it (.health-bak).")}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn
              type="button"
              primary
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const f = await connectAgent(client.id, token);
                  setResult({ ok: true, text: t("Added to {{file}}. Restart {{name}} to pick it up.", { file: f, name: client.name }) });
                } catch (e) {
                  setResult({ ok: false, text: String(e) });
                }
                setBusy(false);
              }}
            >
              {t("Add to {{name}}", { name: client.name })}
            </Btn>
          </div>
          {result && <p className={result.ok ? "text-[13px] text-black/55 dark:text-white/55" : "text-[15px] text-brand-red"}>{result.text}</p>}
          <p className="text-[13px] text-black/55 dark:text-white/55">{t("Or do it by hand:")}</p>
        </>
      )}
      <ol className="list-decimal ps-5 leading-relaxed [&_li+li]:mt-3">
        {client.steps(bin, token).map((st) => (
          <li key={st.text}>
            {st.text}
            {st.code && (
              <div className="mt-1.5 flex items-start gap-2 [&_pre]:min-w-0 [&_pre]:flex-1 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre">
                <pre className="overflow-x-auto rounded-xl bg-black/5 p-3 font-mono text-xs whitespace-pre-wrap break-all dark:bg-white/10">{st.code}</pre>
                <Copy text={st.code} label={t("Copy")} />
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className="text-[13px] text-black/55 dark:text-white/55">
        {t("The token is shown only this once. The app works with your data even when PhysiMind is closed (with a passphrase lock, keep PhysiMind open and unlocked). If you move the PhysiMind app, or the access expires, connect again. Apps that run in a web browser (such as ChatGPT or claude.ai) can't reach PhysiMind: it only answers on this computer.")}
      </p>
      <Btn type="button" link onClick={done}>
        {t("Done")}
      </Btn>
    </div>
  );
}

/** Revoking cuts the app off at once: ask first, and say so if it fails. */
function Revoke({ id, name, done }: { id: number; name: string; done: () => void }) {
  const [ask, setAsk] = useState(false);
  const [err, setErr] = useState<string>();
  if (!ask)
    return (
      <Btn type="button" link onClick={() => setAsk(true)}>
        {t("Revoke")}
      </Btn>
    );
  return (
    <span className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center flex items-center gap-2">
      <Btn
        type="button"
        danger
        onClick={() =>
          op("grant.revoke", { id }).then(
            () => (setAsk(false), done()),
            (e) => setErr(errText(e)),
          )
        }
      >
        {t("Revoke {{name}}", { name })}
      </Btn>
      <Btn type="button" onClick={() => setAsk(false)}>
        {t("Keep")}
      </Btn>
      {err && <Problem text={err} />}
    </span>
  );
}

function LastUsed({ id }: { id: number }) {
  const [last, , reload] = useOp(() => op<Audit[]>("audit.list", { grant_id: id, limit: 1 }), [id]);
  usePoll(reload);
  if (!last) return null;
  return <span className="text-[13px] text-black/55 dark:text-white/55">{last[0] ? t("last used {{when}}", { when: ago(last[0].at) }) : t("not used yet")}</span>;
}

export function Agents({ want, path }: { want?: string; path?: string[] }) {
  const [grants, err, reload] = useOp(() => op<Grant[]>("grant.list"), []);
  const [found, setFound] = useState<string[]>([]);
  // connecting is two screens: the apps (#/agents/connect), then what the one chosen may use (…/connect/claude)
  const connecting = want === "connect";
  const client = connecting ? CLIENTS.find((c) => c.id === path?.[0]) : undefined;
  const [name, setName] = useState("");
  const [groups, setGroups] = useState<string[]>(GROUPS.filter((g) => !g.sensitive).map((g) => g.key));
  const [detail, setDetail] = useState(false);
  const [days, setDays] = useState(90);
  const [expiry, setExpiry] = useState(90);
  const [write, setWrite] = useState<Grant["write"]>("none");
  const [reports, setReports] = useState(false);
  const [profile, setProfile] = useState(false);
  const [made, setMade] = useState<{ client: Client; token: string }>();
  const [msg, setMsg] = useState<string>();
  const [bin, setBin] = useState("health");
  useEffect(() => {
    corePath().then(setBin, () => {});
    agentClients().then((c) => setFound(c.map((x) => x.id)), () => {});
  }, []);
  const [creating, setCreating] = useState(false);
  // each app starts from the defaults, not what the last one was given
  const pick = (c: Client) => {
    setName(c.id === "other" ? "" : c.name);
    setGroups(GROUPS.filter((g) => !g.sensitive).map((g) => g.key));
    setDetail(false);
    setDays(90);
    setExpiry(90);
    setWrite("none");
    setReports(false);
    setProfile(false);
    setMsg(undefined);
    setMade(undefined);
    nav(`agents/connect/${c.id}`);
  };
  const create = async () => {
    if (!client || creating) return;
    setMsg(undefined);
    setCreating(true);
    try {
      const r = await op<Grant & { token: string }>("grant.create", {
        name,
        groups: write === "derived" ? [...new Set([...groups, "derived"])] : groups,
        detail,
        reports,
        profile,
        window: days ? { last_days: days } : "all",
        write,
        expires_ms: Date.now() + expiry * DAY,
      });
      setMade({ client, token: r.token });
      backBy(2, "agents");
      reload();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setCreating(false);
    }
  };
  const toggle = (k: string) => setGroups((g) => (g.includes(k) ? g.filter((x) => x !== k) : [...g, k]));
  const everyday = GROUPS.filter((g) => g.key !== "derived" && !g.sensitive).map((g) => g.key);
  const sensitive = GROUPS.filter((g) => g.key !== "derived" && g.sensitive).map((g) => g.key);
  const setAll = (keys: string[], on: boolean) => setGroups((g) => (on ? [...new Set([...g, ...keys])] : g.filter((k) => !keys.includes(k))));
  const ordered = [...CLIENTS].sort((a, b) => Number(found.includes(b.id)) - Number(found.includes(a.id)));
  if (connecting)
    return (
      <section className="mx-auto w-full max-w-3xl">
        {!client ? (
          <>
            <Heading>{t("Connect an app")}</Heading>
            <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Choose the AI app that should use your health data.")}</p>
            <Group aria-label={t("Agent apps")}>
              {ordered.map((c) => (
                <Item key={c.id} title={c.name} text={found.includes(c.id) ? t("On this computer") : undefined} onClick={() => pick(c)} />
              ))}
            </Group>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <Heading>{client.id === "other" ? t("What the app may use") : t("What {{name}} may use", { name: client.name })}</Heading>
            <p className="text-[13px] text-black/55 dark:text-white/55">{t("It sees only what you turn on here. It can never delete anything or open your backups.")}</p>

            <CardHead title={t("Health data")} on={everyday.every((k) => groups.includes(k))} set={(on) => setAll(everyday, on)} />
            <Group>
              {GROUPS.filter((g) => g.key !== "derived" && !g.sensitive).map((g) => (
                <SwitchRow key={g.key} icon={<GroupIcon k={g.key} />} label={t(g.label)} on={groups.includes(g.key)} set={() => toggle(g.key)} />
              ))}
            </Group>

            <CardHead title={t("Sensitive data")} on={sensitive.every((k) => groups.includes(k))} set={(on) => setAll(sensitive, on)} />
            <Group>
              {GROUPS.filter((g) => g.key !== "derived" && g.sensitive).map((g) => (
                <SwitchRow key={g.key} icon={<GroupIcon k={g.key} />} label={t(g.label)} on={groups.includes(g.key)} set={() => toggle(g.key)} />
              ))}
            </Group>
            <p className="mt-1 mb-4 px-4 text-[13px] text-black/55 dark:text-white/55">{t("Off unless you turn them on. Turn on only what the app needs.")}</p>

            <CardHead title={t("Detail")} on={detail && reports && profile} set={(on) => (setDetail(on), setReports(on), setProfile(on))} />
            <Group>
              <SwitchRow label={t("Individual entries")} sub={t("Otherwise one summary per day")} on={detail} set={setDetail} />
              <SwitchRow label={t("Full lab report text")} sub={t("Every item on the report, including categories that are off")} on={reports} set={setReports} />
              <SwitchRow label={t("Age and sex")} sub={t("From your profile; never your birth month")} on={profile} set={setProfile} />
            </Group>

            <h4 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("What it may do")}</h4>
            <Group role="radiogroup" aria-label={t("What it may do")}>
              {(
                [
                  ["none", t("Read only"), t("The agent can only look at your data")],
                  ["propose", t("Read and write"), t("You confirm each entry the agent saves")],
                  ["derived", t("Full read and write"), t("The agent can write data without asking you")],
                ] as const
              ).map(([k, label, sub]) => (
                <li key={k}>
                  <label className="select-none flex items-center gap-3 px-4 py-3 relative cursor-default [&_input[type=radio]]:pointer-events-none [&_input[type=radio]]:absolute [&_input[type=radio]]:opacity-0">
                    <input type="radio" name="write" checked={write === k} onChange={() => setWrite(k)} />
                    <span className="me-auto grid min-w-0 gap-px">
                      <strong>{label}</strong>
                      <span className="text-[13px] text-black/55 dark:text-white/55">{sub}</span>
                    </span>
                    <span className="min-w-4 text-end font-semibold text-primary" aria-hidden="true">
                      {write === k ? "✓" : ""}
                    </span>
                  </label>
                </li>
              ))}
            </Group>

            <h4 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("Time")}</h4>
            <Group>
              <li className="flex items-center gap-3 px-4 py-3">
                <span className="me-auto grid min-w-0 gap-px" id="grant-back">
                  <strong>{t("Data from the last")}</strong>
                </span>
                <span className="mt-3 inline-flex rounded-[9px] bg-black/5 p-0.5 dark:bg-white/10" role="group" aria-labelledby="grant-back">
                  {(
                    [
                      [30, t("30 days")],
                      [90, t("90 days")],
                      [365, t("1 year")],
                      [0, t("All")],
                    ] as const
                  ).map(([d, l]) => (
                    <Btn key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
                      {l}
                    </Btn>
                  ))}
                </span>
              </li>
              <li className="flex items-center gap-3 px-4 py-3">
                <label className="me-auto grid min-w-0 gap-px" htmlFor="grant-expiry">
                  <strong>{t("Agent access ends after")}</strong>
                </label>
                <select id="grant-expiry" className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white w-auto min-w-36 max-w-1/2" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
                  {EXPIRY.map(([d, l]) => (
                    <option key={d} value={d}>
                      {t(l)}
                    </option>
                  ))}
                </select>
              </li>
            </Group>

            <h4 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("Name")}</h4>
            <Group>
              <li className="flex items-center gap-3 px-4 py-3">
                <label className="me-auto grid min-w-0 gap-px" htmlFor="grant-name">
                  <strong>{t("Name shown in the access log")}</strong>
                </label>
                <input id="grant-name" className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white w-auto min-w-36 max-w-1/2 text-end" placeholder={t("My agent")} value={name} onChange={(e) => setName(e.target.value)} required />
              </li>
            </Group>

            <Problem text={msg} />
            <Btn type="submit" primary className="mt-4 w-full!" disabled={creating || !groups.length || !name.trim()}>
              {t("Allow access")}
            </Btn>
          </form>
        )}
      </section>
    );
  return (
    <section className="mx-auto w-full max-w-3xl">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <Heading>{t("Agent access")}</Heading>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Btn type="button" primary onClick={() => (setMade(undefined), nav("agents/connect"))}>
            {t("Connect an app…")}
          </Btn>
        </div>
      </div>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">
        {t("Let AI apps (Claude, Codex and others) use your data through MCP, with access settings built in.")}
      </p>
      {made && <ConnectSteps client={made.client} token={made.token} bin={bin} found={found.includes(made.client.id)} done={() => setMade(undefined)} />}
      <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("Current access")}</h3>
      <Problem text={err} />
      {grants && !grants.length ? (
        <p className="text-black/55 dark:text-white/55">{t("No app has access yet.")}</p>
      ) : (
        <Group>
          {(grants ?? [])
            .slice()
            .reverse()
            .map((g) => {
              const live = !g.revoked_ms && g.expires_ms > Date.now();
              return (
                <li key={g.id} className={`flex items-center gap-3 px-4 py-3 ${live ? "" : "opacity-55"}`} aria-label={g.name}>
                  <span className="me-auto grid min-w-0 gap-px">
                    <strong>{g.name}</strong>
                    <span className="text-[13px] text-black/55 dark:text-white/55">
                      {g.groups.map(groupLabel).join(t(", "))}
                      {t(", ")}
                      {g.detail ? t("individual entries") : t("daily summaries")}
                      {t(", ")}
                      {windowText(g.window)}
                      {t(", ")}
                      {writeText(g.write)}
                    </span>
                    {live && <LastUsed id={g.id} />}
                  </span>
                  <span className="flex flex-none flex-col items-end gap-1.5">
                    <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs whitespace-nowrap text-black/60 dark:bg-white/10 dark:text-white/60">
                      {live
                        ? t("until {{date}}", { date: new Date(g.expires_ms).toLocaleDateString(i18nLocale()) })
                        : g.revoked_ms
                          ? t("revoked")
                          : t("expired")}
                    </span>
                    {live && <Revoke id={g.id} name={g.name} done={reload} />}
                  </span>
                </li>
              );
            })}
        </Group>
      )}
      <AuditLog />
    </section>
  );
}

/** Agents' reads change no data, so no change event announces them: look again every few seconds. */
function usePoll(reload: () => void, ms = 5000) {
  useEffect(() => {
    const t = setInterval(() => inBackground(reload), ms);
    return () => clearInterval(t);
  }, [reload, ms]);
}

function AuditLog() {
  const [log, err, reloadLog] = useOp(() => op<Audit[]>("audit.list", { limit: 200 }), []);
  usePoll(reloadLog);
  const [grants] = useOp(() => op<Grant[]>("grant.list"), []);
  const nameOf = (id: number) => grants?.find((g) => g.id === id)?.name ?? `#${id}`;
  return (
    <div className={`${card}`}>
      <h3 className="mb-2 text-[17px] font-semibold">{t("Access log")}</h3>
      <Problem text={err} />
      {log && !log.length && <p className="text-black/55 dark:text-white/55">{t("No agent has read anything yet.")}</p>}
      <table className="w-full text-sm">
        <tbody>
          {(log ?? []).map((a, i) => (
            <tr key={`${a.at}-${i}`}>
              <td className="px-2 py-1.5 align-top">{when(a.at)}</td>
              <th scope="row">{nameOf(a.grant_id)}</th>
              <td className="px-2 py-1.5 align-top">{a.op}</td>
              <td className="px-2 py-1.5 align-top">{a.metrics.join(", ")}</td>
              <td className="font-semibold tabular-nums">{a.denied ? <span className="text-amber-600">{t("refused")}</span> : t("{{count}} rows", { count: a.rows })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
