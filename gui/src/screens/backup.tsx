import { Checkbox } from "konsta/react";
import { useEffect, useState } from "react";
import { op, saveExport, unstageFile } from "../api";
import { day, fileName, GROUPS } from "../format";
import { t } from "../i18n";
import { go as nav } from "../router";
import { Btn, errText, Group, GroupIcon, Heading, Icon, type Page, PasswordField, Problem, Row, SwitchRow } from "../ui";
import { ClearDataRow } from "./about";
import { Import } from "./import";

/** Backup and export (as the web's 备份与导出): save a backup, restore one, or write a table for other tools. */
export function Backup({ want, go }: { want?: string; go: (p: Page) => void }) {
  const setSheet = (x: "save" | "restore" | "csv") => nav(`backup/${x}`);
  const [file, setFile] = useState<string>();
  // a file chosen to restore is for that screen only
  useEffect(() => {
    if (want !== "restore" && file) {
      unstageFile(file);
      setFile(undefined);
    }
  }, [want]);
  const titles = { save: t("Save a backup"), restore: t("Restore a backup"), csv: t("Export a table (CSV)") };
  // each a screen of its own (#/backup/save)
  if (want === "save") return <BackupSave />;
  if (want === "restore") return <Import file={file} onFile={setFile} go={go} kind="restore" title={titles.restore} />;
  if (want === "csv") return <CsvExport />;
  return (
    <section className="mx-auto w-full max-w-3xl">
      <Heading>{t("Backup")}</Heading>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Save or restore a backup file to move your data to another device.")}</p>
      <Group>
        <Row icon={<Icon k="backup" />} label={titles.save} sub={t("Encrypted with a password you choose")} onClick={() => setSheet("save")} />
        <Row icon={<Icon k="data" />} label={titles.restore} sub={t("Merges; nothing is overwritten")} onClick={() => setSheet("restore")} />
        <Row icon={<GroupIcon k="other" />} label={titles.csv} sub={t("Unencrypted, for spreadsheets and other tools")} onClick={() => setSheet("csv")} />
      </Group>
      <ClearDataRow />
    </section>
  );
}

/** A table of readings for other tools (web 导出表格): chosen groups only; unencrypted, so it says so. */
function CsvExport() {
  const [groups, setGroups] = useState<string[]>(GROUPS.filter((g) => !g.sensitive).map((g) => g.key));
  const [dateOnly, setDateOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<string>();
  const save = async () => {
    setErr(undefined);
    setDone(undefined);
    setBusy(true);
    try {
      let rows = 0;
      const path = await saveExport(`health-${day(Date.now())}.csv`, "text/csv", { name: "CSV", ext: "csv" }, async (path) => {
        const r = await op<{ path: string; rows: number }>("export.csv", { path, groups, date_only: dateOnly });
        rows = r.rows;
        return r.path;
      });
      if (path) setDone(t("Saved {{file}}: {{count}} rows. It isn't encrypted: keep it somewhere safe.", { file: fileName(path), count: rows }));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="[&_h3]:mt-6">
      <Heading>{t("Export a table (CSV)")}</Heading>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("Export unencrypted data for use in other software.")}</p>
      <form
        className="flex flex-col gap-3"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {[false, true].map((sensitive) => (
          <Group key={String(sensitive)} title={sensitive ? t("Sensitive: tick only what you need") : t("What to include")}>
            {GROUPS.filter((g) => g.sensitive === sensitive).map((g) => (
              <label key={g.key} className="select-none flex min-h-[52px] cursor-pointer items-center gap-4 px-4">
                <Checkbox
                  component="span"
                  checked={groups.includes(g.key)}
                  onChange={() => setGroups((x) => (x.includes(g.key) ? x.filter((k) => k !== g.key) : [...x, g.key]))}
                />
                <span className="flex-1 text-[16px]">{t(g.label)}</span>
              </label>
            ))}
          </Group>
        ))}
        <Group>
          <SwitchRow label={t("Dates only (no times or time zones)")} on={dateOnly} set={setDateOnly} />
        </Group>
        <Problem text={err} />
        <Btn type="submit" primary disabled={busy || !groups.length}>
          {busy ? t("Saving…") : t("Save table…")}
        </Btn>
      </form>
      {done && (
        <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]" role="status">
          {done}
        </p>
      )}
    </section>
  );
}

function BackupSave() {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<string>();
  // local date and time: a second backup the same day gets its own name
  const stamp = (() => {
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  })();
  const save = async () => {
    setErr(undefined);
    setDone(undefined);
    if (pw.length < 8) return setErr(t("Use at least 8 characters."));
    if (pw !== pw2) return setErr(t("The two passwords differ."));
    setBusy(true);
    try {
      let bytes = 0;
      // the save dialog already asked before replacing a file; elsewhere it's the app's own folder
      const path = await saveExport(`health-${stamp}.zuhealth`, "application/octet-stream", { name: t("PhysiMind backup"), ext: "zuhealth" }, async (path) => {
        const r = await op<{ bytes: number; path: string }>("backup.export", { path, password: pw, replace: true });
        bytes = r.bytes;
        return r.path;
      });
      if (!path) return;
      setDone(t("Saved {{file}} ({{mb}} MB). Keep the password safe: without it the backup cannot be opened.", { file: fileName(path), mb: (bytes / 1e6).toFixed(1) }));
      setPw("");
      setPw2("");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="[&_h3]:mt-6">
      <Heading>{t("Save a backup")}</Heading>
      <form
        className="flex flex-col gap-3"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <PasswordField label={t("Password")} value={pw} onChange={setPw} auto="new-password" />
        <PasswordField label={t("Repeat password")} value={pw2} onChange={setPw2} auto="new-password" />
        <p className="text-[13px] text-black/55 dark:text-white/55">{t("At least 8 characters. There is no way to recover a forgotten backup password.")}</p>
        <Problem text={err} />
        <Btn type="submit" primary disabled={busy}>
          {busy ? t("Saving…") : t("Save backup…")}
        </Btn>
      </form>
      {done && (
        <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]" role="status">
          {done}
        </p>
      )}
    </section>
  );
}

// ---- Health account (protocol 1, 3.1, 3.5): the identity code, linking, the inbox --------------------------
