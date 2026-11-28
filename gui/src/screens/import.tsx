import { type ReactNode, useEffect, useRef, useState } from "react";
import { chooseImportFile, FILE_TYPES, installOcr, isDesktop, isMobile, ocrComponent, type OcrProgress, onOcrProgress, op, stageFile, unstageFile } from "../api";
import { fileName, type ImportKind, importKind, KIND_LABEL } from "../format";
import { t, tk } from "../i18n";
import { isTouch } from "../pickers";
import { Btn, errText, Group, Heading, Icon, IconDot, Item, type Page, PasswordField, Problem, WebLink } from "../ui";

const WEB_VERSION = "https://zuchiangmai.com/health";

/** Where a file dropped on the desktop window goes: the picker on screen, if there is one (else Data sources). */
export let dropInto: ((path: string) => void) | undefined;

type PickKind = "report" | "apple" | "restore" | "file";

/** The ways to pick a file, the same on every device: a lab report from the camera, the photos or the files; an
 *  export or a backup from the files. The desktop's dialog imports a file where it is; a phone's picker (and the
 *  browser preview) hands its bytes over first. A screen without a finger takes a file dropped on it too. */
function FilePick({ path, onPath, kind }: { path?: string; onPath: (p: string) => void; kind: PickKind }) {
  const [name, setName] = useState<string>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const take = async (f?: File | null) => {
    if (!f) return;
    setErr(undefined);
    setBusy(true);
    try {
      onPath(await stageFile(f));
      setName(f.name);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const chosen = (p: string) => (setName(undefined), onPath(p));
  const latest = useRef(chosen);
  latest.current = chosen;
  useEffect(() => {
    if (isTouch) return;
    dropInto = (p) => latest.current(p);
    return () => void (dropInto = undefined);
  }, []);
  // one row: the desktop's open dialog, or the system's picker behind a hidden input
  const row = (icon: string, color: string, title: string, accept: string | undefined, types: keyof typeof FILE_TYPES, capture?: boolean) =>
    isDesktop ? (
      <Item key={title} color={color} icon={<Icon k={icon} />} title={title} onClick={async () => { const p = await chooseImportFile(types); if (p) chosen(p); }} />
    ) : (
      <label key={title} className="select-none flex min-h-[64px] w-full cursor-pointer items-center gap-4 px-4 py-3 transition-colors active:bg-black/5 dark:active:bg-white/10">
        <IconDot color={color}>
          <Icon k={icon} />
        </IconDot>
        <span className="min-w-0 flex-1 text-[17px] material:text-[16px]">{title}</span>
        <input type="file" hidden accept={accept} capture={capture ? "environment" : undefined} onChange={(e) => {
            void take(e.target.files?.[0]);
            // the same file chosen again still counts
            e.target.value = "";
          }} />
      </label>
    );
  return (
    <div aria-busy={busy}>
      {path && (
        <Group>
          <Item icon={<Icon k="data" />} title={name ?? fileName(path)} text={t("Chosen")} />
        </Group>
      )}
      <Group title={path ? t("Choose another file…") : undefined}>
        {kind === "report" && isTouch && row("camera", "#0a7397", t("Take a photo"), "image/*", "photo", true)}
        {kind === "report" && row("photos", "#43a047", t("Choose from photos"), "image/*", "photo")}
        {row("folder", "#1e88e5", t("Choose from files"), kind === "report" ? "image/*,application/pdf" : kind === "apple" ? ".zip,application/zip" : undefined, kind)}
      </Group>
      {!isTouch && (
        <div
          className={`mb-5 rounded-3xl border-[1.5px] border-dashed px-4 py-6 text-center text-[15px] text-black/55 dark:text-white/55 ${over ? "border-primary bg-primary/10" : "border-black/20 dark:border-white/20"}`}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            void take(e.dataTransfer.files[0]);
          }}
        >
          {t("Or drag a file here.")}
        </div>
      )}
      <Problem text={err} />
    </div>
  );
}

interface FileResult {
  written: number;
  added: number;
  sources: number;
  apple?: { records: number; broken: number; skipped_types: Record<string, number> };
}

interface BackupResult {
  added_imports: number;
  erased_imports: number;
  refused_imports: number;
  refused_corrections: number;
  skipped_metrics: string[];
  missing_blobs: string[];
  restored_blobs: number;
}

/** The lab report just read: Waiting for you shows it first. */
export let justRead: number | undefined;

const IMPORT_LEDE: Record<string, string> = {
  apple: tk("On your iPhone, open Health, tap your picture, then Export All Health Data; choose the .zip here."),
  report: tk("A photo (JPEG, PNG) or a PDF."),
  restore: tk("A PhysiMind backup (.zuhealth) from this app or the web version."),
  file: tk("A photo or PDF of a lab report, an Apple Health export, a PhysiMind backup (.zuhealth) or WHOOP data. Importing the same file again updates it; nothing is doubled."),
};

export function Import({
  file,
  onFile,
  go,
  kind: hint = "file",
  title,
  part,
}: {
  file?: string;
  onFile: (p?: string) => void;
  go: (p: Page) => void;
  kind?: string;
  title?: string;
  /** a part of a page (Add), not the page: a smaller heading */
  part?: boolean;
}) {
  const [password, setPassword] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState<ReactNode>();
  // a lab report's steps, as the web's: asked before the one-off download of the models, then the download, then
  // the reading, each with its progress
  const [step, setStep] = useState<"ask" | "download" | "read">();
  const [progress, setProgress] = useState<OcrProgress>();
  const [askMb, setAskMb] = useState(0);
  useEffect(() => onOcrProgress(setProgress), []);
  const kind: ImportKind | null = file ? importKind(file) : null;
  useEffect(() => {
    setErr(undefined);
    setDone(undefined);
    setPassword("");
    setSource(file ? fileName(file).replace(/\.jsonl$/i, "") : "");
  }, [file]);
  const run = async () => {
    if (!file || !kind) return;
    setBusy(true);
    setErr(undefined);
    setDone(undefined);
    try {
      if (kind === "report") return void (await readReport());
      if (kind === "backup") {
        const r = await op<BackupResult>("backup.import", { path: file, password });
        const notes: string[] = [];
        if (r.refused_imports + r.refused_corrections) notes.push(t("{{count}} entries were refused because their dates lie in the future, which means a damaged or altered file.", { count: r.refused_imports + r.refused_corrections }));
        if (r.skipped_metrics.length) notes.push(t("{{count}} measures were skipped because their unit differs on this computer: {{list}}.", { count: r.skipped_metrics.length, list: r.skipped_metrics.join(", ") }));
        if (r.missing_blobs.length) notes.push(t("{{count}} original files (such as lab report photos) are not in this backup; the readings from them are.", { count: r.missing_blobs.length }));
        setDone(
          <>
            <p>
              {r.erased_imports
                ? t("Restored: {{added}} imports added, {{erased}} removed because they were deleted on the other device. Nothing here was overwritten.", { added: r.added_imports, erased: r.erased_imports })
                : t("Restored: {{added}} imports added. Nothing here was overwritten.", { added: r.added_imports })}
            </p>
            {notes.map((n) => (
              <p key={n} className="text-[13px] text-black/55 dark:text-white/55">
                {n}
              </p>
            ))}
          </>,
        );
      } else {
        const r = await op<FileResult>(`import.${kind}`, kind === "rows" ? { path: file, source } : { path: file });
        const broken = r.apple?.broken ?? 0;
        setDone(
          <>
            <p>
              {t("Imported {{n}} readings from {{count}} devices.", { n: r.written.toLocaleString(), count: r.sources })}
              {r.added < r.written ? ` ${t("{{n}} were already here and were updated.", { n: (r.written - r.added).toLocaleString() })}` : ""}
            </p>
            {broken > 0 && <p className="text-[13px] text-black/55 dark:text-white/55">{t("{{n}} records had a bad date or value and were left out.", { n: broken.toLocaleString() })}</p>}
          </>,
        );
      }
      setPassword("");
      unstageFile(file);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  /** A lab report: the models first if they're missing (asked once; a phone takes only the ~21 MB it needs, not
   *  the matching model), then read; the result opens for checking (nothing counts until it's confirmed). */
  const reading = useRef(false);
  const readReport = async (fetch = false) => {
    if (!file || reading.current) return;
    reading.current = true;
    // the check opens only if the person is still here; elsewhere the review badge says it's waiting
    const at = location.hash;
    setErr(undefined);
    setProgress(undefined);
    try {
      const comp = await ocrComponent();
      if (comp && !comp.ready) {
        const missing = comp.files.filter((f) => !f.installed && (f.required || !isMobile));
        if (!fetch) {
          setAskMb(Math.max(1, Math.round(missing.reduce((n, f) => n + f.bytes, 0) / 1e6)));
          return setStep("ask");
        }
        setStep("download");
        await installOcr(!isMobile);
        setProgress(undefined);
      }
      setStep("read");
      const r = await op<{ import_id: number; items: number; matched: number }>("import.ocr", { path: file, tz_min: -new Date().getTimezoneOffset() });
      justRead = r.import_id;
      unstageFile(file); // read: the report's copy is kept in the data now
      setStep(undefined);
      if (location.hash === at) go("review");
    } catch (e) {
      setStep(undefined);
      setErr(errText(e));
    } finally {
      reading.current = false;
    }
  };
  // a report is read as soon as it is chosen (as the web's): there is nothing to fill in first. Once per file
  // (StrictMode runs effects twice: the report would be imported twice)
  const started = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per file chosen
  useEffect(() => {
    // cleared: the same file chosen again is read again
    if (!file) started.current = undefined;
    if (!file || kind !== "report" || started.current === file) return;
    started.current = file;
    void readReport();
  }, [file]);
  return (
    <section className="[&_h3]:mt-6">
      {part ? <h3 className="mt-6 mb-1.5 text-[17px] font-semibold">{title}</h3> : <Heading>{title ?? t("Import a file")}</Heading>}
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t(IMPORT_LEDE[hint] ?? IMPORT_LEDE.file!)}</p>
      {hint === "restore" && (
        <p className="text-[13px] text-black/55 dark:text-white/55">
          {t("Web version")} <WebLink url={WEB_VERSION} />
        </p>
      )}
      <FilePick path={file} onPath={onFile} kind={hint === "report" || hint === "apple" || hint === "restore" ? hint : "file"} />
      {file && !kind && (
        <Problem text={t("PhysiMind can't read this kind of file. Choose a lab report photo or PDF, a .zip from Apple Health, a .zuhealth backup, or a WHOOP .json file.")} />
      )}
      {file && kind === "report" && (
        <div aria-busy={step === "download" || step === "read"}>
          {step === "ask" ? (
            <div className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]">
              <p>{t("The first time, PhysiMind needs the text-recognition models (about {{mb}} MB), once. Reports are read here; nothing is uploaded.", { mb: askMb })}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Btn type="button" primary onClick={() => void readReport(true)}>
                  {t("Download and read")}
                </Btn>
                <Btn type="button" onClick={() => (setStep(undefined), onFile(undefined))}>
                  {t("Not now")}
                </Btn>
              </div>
            </div>
          ) : step ? (
            <div role="status" className="[&_progress]:h-1.5 [&_progress]:w-full [&_progress]:accent-primary">
              {/* a bar only where there's something to count: bytes, or the pages of a PDF */}
              {progress?.stage === step && (step === "download" || progress.total > 1) ? (
                <progress value={progress.done} max={progress.total} />
              ) : (
                <progress />
              )}
              <p className="text-[13px] text-black/55 dark:text-white/55">
                {step === "download"
                  ? t("Downloading the text-recognition models {{pct}}%", { pct: progress?.stage === "download" ? Math.floor((progress.done * 100) / Math.max(1, progress.total)) : 0 })
                  : progress?.stage === "read" && progress.total > 1
                    ? t("Reading page {{n}} of {{m}}…", { n: progress.done + 1, m: progress.total })
                    : t("Reading the report…")}
              </p>
            </div>
          ) : err ? (
            <>
              <Problem text={err} />
              <Btn type="button" primary onClick={() => void readReport()}>
                {t("Try again")}
              </Btn>
            </>
          ) : null}
        </div>
      )}
      {file && kind && kind !== "report" && (
        <form
          className="flex flex-col gap-3"
          aria-busy={busy}
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <p className="text-[13px] text-black/55 dark:text-white/55">{t(KIND_LABEL[kind])}</p>
          {kind === "backup" && <PasswordField label={t("Backup password")} value={password} onChange={setPassword} auto="current-password" />}
          {kind === "rows" && (
            <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
              {t("Where these readings come from")}
              <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={source} onChange={(e) => setSource(e.target.value)} required />
            </label>
          )}
          <Problem text={err} />
          <Btn type="submit" primary disabled={busy}>
            {busy ? (kind === "backup" ? t("Restoring…") : t("Importing…")) : kind === "backup" ? t("Restore backup") : t("Import")}
          </Btn>
          {busy && (
            <p className="text-[13px] text-black/55 dark:text-white/55">
              {t("Large exports can take a few minutes. PhysiMind answers again when the import is done; keep this page open to see the result.")}
            </p>
          )}
        </form>
      )}
      {done && (
        <div className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]" role="status">
          {done}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" primary onClick={() => go("readings")}>
              {t("See my readings")}
            </Btn>
            <Btn type="button" onClick={() => onFile(undefined)}>
              {t("Import another file")}
            </Btn>
          </div>
        </div>
      )}
    </section>
  );
}
