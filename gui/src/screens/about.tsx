import { useEffect, useState } from "react";
import { clearData, isMobile, OpError } from "../api";
import { t } from "../i18n";
import { go as nav } from "../router";
import { Btn, Group, Heading, Icon, Problem, Row, Screen, Sheet, WebLink } from "../ui";

/** Every sentence matches what the desktop does (checked 2026-11-24): data in the encrypted profile (SQLCipher, key in
 *  the keychain or from the passphrase); OCR on this computer, models downloaded once from Hugging Face and GitHub
 *  (health-ocr components); lab results sealed to the account's key, the lab's device history kept by the backend
 *  (as on the web); WHOOP relayed, not kept; LAN sync direct and encrypted, the relay sees sealed signalling only;
 *  agents only through grants, every call audited. Change the page when any of that changes. */
function Privacy() {
  const sections: [string, string[]][] = [
    [
      t("Where your data is"),
      [
        (isMobile ? t("Your health data is kept in one encrypted file on this device. Its key is in the device's secure storage (Keychain or Keystore).") : t("Your health data is kept in one encrypted file on this computer. Its key is in your system keychain, or comes from your passphrase if you set one.")),
        (isMobile ? t("Nothing is uploaded to a cloud. If this device is lost or the data deleted, it can't be recovered: save a backup now and then in Backup.") : t("Nothing is uploaded to a cloud. If this computer is lost or the data deleted, it can't be recovered: save a backup now and then in Backup.")),
      ],
    ],
    [
      t("How it's protected"),
      [
        (isMobile ? t("Lab reports are read entirely on this device; photos and PDFs aren't uploaded. The first use downloads the recognition models from Hugging Face and GitHub.") : t("Lab reports are read entirely on this computer; photos and PDFs aren't uploaded. The first use downloads the recognition models from Hugging Face and GitHub.")),
        t("Lab results arrive encrypted (some PDF files aren't, but random file names keep others from finding them), and only your devices can open them. The lab records the devices and dates you used, for its staff to see."),
        t("When WHOOP is connected, its data passes through the health service on its way here and isn't kept."),
        t("Local network sync sends data directly between your own devices on the same network, encrypted. The health service only passes on sealed connection details: it can't read them or tell whose they are."),
        t("AI assistants (MCP) read your health data only within the access you grant in Agent access, and every read is recorded there."),
      ],
    ],
    [t("Coming later"), [t("Android and iOS versions will follow.")]],
  ];
  return (
    <>
      {sections.map(([title, lines]) => (
        <section key={title} aria-label={title}>
          <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{title}</h3>
          <Group>
            {lines.map((line) => (
              <li key={line} className="flex items-center gap-3 px-4 py-3">
                <span className="me-auto grid min-w-0 gap-px">{line}</span>
              </li>
            ))}
          </Group>
        </section>
      ))}
    </>
  );
}

type LicenseEntry = { name: string; versions: string[]; license: string; url?: string };

/** The main components by hand, with the copyright lines from their own license files (checked 2026-11-24); the
 *  full list is generated (scripts/gen-licenses.ts). License texts, copyright lines and the LOINC notice stay in
 *  English, as written. */
const MAIN_COMPONENTS: { name: string; license: string; by: string; url: string }[] = [
  { name: "Tauri", license: "MIT OR Apache-2.0", by: "Copyright (c) 2017 - Present Tauri Apps Contributors", url: "https://tauri.app" },
  { name: "React", license: "MIT", by: "Copyright (c) Meta Platforms, Inc. and affiliates.", url: "https://react.dev" },
  { name: "i18next, react-i18next", license: "MIT", by: "Copyright (c) 2025 i18next", url: "https://www.i18next.com" },
  { name: "SQLCipher", license: "BSD-3-Clause", by: "Copyright (c) 2025, ZETETIC LLC", url: "https://www.zetetic.net/sqlcipher/" },
  { name: "SQLite", license: "Public domain", by: "SQLite Consortium", url: "https://sqlite.org/copyright.html" },
  { name: "LibTomCrypt", license: "Public domain or WTFPL", by: "Tom St Denis and contributors", url: "https://github.com/libtom/libtomcrypt" },
  { name: "OpenSSL", license: "Apache-2.0", by: "The OpenSSL Project Authors", url: "https://www.openssl.org" },
  { name: "rusqlite", license: "MIT", by: "Copyright (c) 2014 The rusqlite developers", url: "https://github.com/rusqlite/rusqlite" },
  { name: "tract", license: "MIT OR Apache-2.0", by: "Sonos, Inc. and Mathieu Poumeyrol", url: "https://github.com/sonos/tract" },
  { name: "hayro", license: "Apache-2.0 OR MIT", by: "Copyright (c) The Hayro Authors", url: "https://github.com/LaurenzV/hayro" },
  { name: "str0m", license: "MIT OR Apache-2.0", by: "Martin Algesten", url: "https://github.com/algesten/str0m" },
  { name: "RustCrypto", license: "MIT OR Apache-2.0", by: "Copyright (c) 2019-2026 The RustCrypto Project Developers", url: "https://github.com/RustCrypto" },
  { name: "dalek-cryptography", license: "BSD-3-Clause", by: "Copyright (c) 2016-2021 isis agora lovecruft", url: "https://github.com/dalek-cryptography" },
  { name: "rustls", license: "Apache-2.0 OR ISC OR MIT", by: "Copyright (c) 2016, Joseph Birr-Pixton", url: "https://github.com/rustls/rustls" },
  { name: "PP-OCRv5", license: "Apache-2.0", by: "PaddlePaddle Authors", url: "https://github.com/PaddlePaddle/PaddleOCR" },
  { name: "multilingual-e5-small", license: "MIT", by: "intfloat", url: "https://huggingface.co/intfloat/multilingual-e5-small" },
  {
    name: "LOINC",
    license: "LOINC License",
    by: "Copyright (c) 1995 Regenstrief Institute, Inc. and the Logical Observation Identifiers Names and Codes (LOINC) Committee",
    url: "https://loinc.org/license/",
  },
  { name: "UCUM", license: "UCUM License", by: "Copyright 1999-2024 Regenstrief Institute, Inc.", url: "https://unitsofmeasure.org/license" },
];

/** The attribution the LOINC license asks for, verbatim (as the web shows it). */
const LOINC_NOTICE =
  "This product includes all or a portion of the LOINC® table, LOINC panels and forms file, LOINC document ontology file, and/or LOINC hierarchies file, or is derived from one or more of the foregoing, subject to a license from Regenstrief Institute, Inc. LOINC is a registered United States trademark of Regenstrief Institute, Inc. Full license: https://loinc.org/license/";

function Licenses() {
  const [all, setAll] = useState<{ crates: LicenseEntry[]; npm: LicenseEntry[]; texts: Record<string, string> }>();
  useEffect(() => {
    import("../licenses.json").then((m) => setAll(m.default as typeof all));
  }, []);
  const list = (items: LicenseEntry[]) => (
    <ul className="mb-3 columns-2 gap-6 text-xs [&_li]:break-inside-avoid [&_li]:py-0.5">
      {items.map((c) => (
        <li key={c.name}>
          {c.url ? <WebLink url={c.url} label={c.name} /> : c.name} <span className="text-[13px] text-black/55 dark:text-white/55">{c.versions.join(", ")}</span>{" "}
          <span className="text-[13px] text-black/55 dark:text-white/55 font-mono text-[13px] break-all">{c.license}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{t("PhysiMind is open-source software under the MIT License. It uses these open-source components and data, with thanks to their authors.")}</p>
      <Group aria-label={t("Components")}>
        {MAIN_COMPONENTS.map((c) => (
          <li key={c.name} className="flex items-center gap-3 px-4 py-3">
            <span className="me-auto grid min-w-0 gap-px">
              <strong>
                <WebLink url={c.url} label={c.name} />
              </strong>
              <span className="text-[13px] text-black/55 dark:text-white/55">{c.by}</span>
            </span>
            <span className="inline-block rounded-full bg-black/5 px-2 py-0.5 text-xs whitespace-nowrap text-black/60 dark:bg-white/10 dark:text-white/60">{c.license}</span>
          </li>
        ))}
      </Group>
      <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">LOINC</h3>
      <p className="text-[13px] text-black/55 dark:text-white/55 mb-5 leading-snug">{LOINC_NOTICE}</p>
      {all && (
        <>
          <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("All components")}</h3>
          <details className="mb-2 [&_summary]:cursor-pointer [&_summary]:py-1.5 [&_pre]:max-h-96 [&_pre]:overflow-auto [&_pre]:text-xs [&_pre]:leading-snug [&_pre]:whitespace-pre-wrap [&_pre]:text-black/55">
            <summary className="select-none cursor-pointer py-1.5">{t("{{count}} Rust crates", { count: all.crates.length })}</summary>
            {list(all.crates)}
          </details>
          <details className="mb-2 [&_summary]:cursor-pointer [&_summary]:py-1.5 [&_pre]:max-h-96 [&_pre]:overflow-auto [&_pre]:text-xs [&_pre]:leading-snug [&_pre]:whitespace-pre-wrap [&_pre]:text-black/55">
            <summary className="select-none cursor-pointer py-1.5">{t("{{count}} JavaScript packages", { count: all.npm.length })}</summary>
            {list(all.npm)}
          </details>
          <h3 className="mt-6 mb-2 px-4 text-[13px] font-semibold text-black/55 dark:text-white/55">{t("License texts")}</h3>
          {Object.entries(all.texts).map(([name, text]) => (
            <details key={name} className="mb-2 [&_summary]:cursor-pointer [&_summary]:py-1.5 [&_pre]:max-h-96 [&_pre]:overflow-auto [&_pre]:text-xs [&_pre]:leading-snug [&_pre]:whitespace-pre-wrap [&_pre]:text-black/55">
              <summary className="select-none cursor-pointer py-1.5">{name}</summary>
              <pre className="overflow-x-auto rounded-xl bg-black/5 p-3 font-mono text-xs whitespace-pre-wrap break-all dark:bg-white/10">{text}</pre>
            </details>
          ))}
          <p className="text-[13px] text-black/55 dark:text-white/55">
            {t("Other licenses named above:")} <WebLink url="https://www.mozilla.org/MPL/2.0/" label="MPL-2.0" />, <WebLink url="https://cdla.dev/permissive-2-0/" label="CDLA-Permissive-2.0" />,{" "}
            <WebLink url="https://www.boost.org/LICENSE_1_0.txt" label="BSL-1.0" />
          </p>
        </>
      )}
    </>
  );
}

/** About (as the web's 更多 › 关于): the version, privacy and open-source licenses. */
export function About({ version, want }: { version?: string; want?: string }) {
  const view = want === "privacy" || want === "licenses" ? want : undefined;
  const setView = (v: "privacy" | "licenses") => nav(`about/${v}`);
  if (view) return <Screen title={view === "privacy" ? t("Privacy") : t("Open-source licenses")}>{view === "privacy" ? <Privacy /> : <Licenses />}</Screen>;
  return (
    <section className="mx-auto w-full max-w-3xl">
      <Heading>{t("About")}</Heading>
      <p className="mb-5 max-w-prose text-[15px] text-black/55 dark:text-white/55">{version ? t("PhysiMind {{version}}", { version }) : "PhysiMind"}</p>
      <Group>
        <Row icon={<Icon k="shield" />} label={t("Privacy")} onClick={() => setView("privacy")} />
        <Row icon={<Icon k="scale" />} label={t("Open-source licenses")} onClick={() => setView("licenses")} />
      </Group>
    </section>
  );
}

// ---- VALD ForceDecks (as the web's fd-report.tsx; grouping and the best jump come from the core, labs.rs) ----------

/** The confirm word for "Clear data": the same in every language (the owner's choice, as on the web). */
const CLEAR_WORD = "DELETE";

/** "Clear data" (as the web's): a quiet red text button on its own line; the confirm form opens in a sheet. Works
 *  when the database no longer opens too (the shell stops the core and deletes the files without opening them). */
export function ClearDataRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="mt-5">
        <Btn type="button" link danger onClick={() => setOpen(true)}>
          {t("Clear data")}
        </Btn>
      </p>
      {open && (
        <Sheet label={t("Clear data")} close={() => setOpen(false)}>
          <ClearData cancel={() => setOpen(false)} />
        </Sheet>
      )}
    </>
  );
}

function ClearData({ cancel }: { cancel: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [done, setDone] = useState(false);
  const ok = typed.trim().toUpperCase() === CLEAR_WORD;
  const run = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      await clearData(typed);
      setDone(true);
      // settings kept in this window go too: a fresh install
      try {
        localStorage.clear();
      } catch {}
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      setErr(
        e instanceof OpError && e.code === "busy"
          ? t("Health data is in use by another program (such as a connected AI assistant). Quit it, then try again.")
          : t("Couldn't clear the data"),
      );
      setBusy(false);
    }
  };
  return (
    <section className="[&_h3]:mt-6">
      <Heading>{t("Clear data")}</Heading>
      <form
        className="flex flex-col gap-3"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <p className="text-amber-600">
          {t("This deletes all Health data on this device: every record, your health account and identity code, links to other devices, and settings. This can't be undone.")}
        </p>
        <p className="text-[13px] text-black/55 dark:text-white/55">
          {t("To keep your data, save a backup first. Data on your other devices isn't affected; to sync again, link them again.")}
        </p>
        <label className="flex flex-col gap-1.5 text-[13px] text-black/60 dark:text-white/60">
          {t("Type “{{words}}” to confirm", { words: CLEAR_WORD })}
          <input className="w-full rounded-xl bg-black/5 px-3 py-2.5 text-base text-black outline-none focus:ring-2 focus:ring-primary dark:bg-white/10 dark:text-white" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={busy || done} />
        </label>
        <Problem text={err} />
        {done ? (
          <p className="mb-4 rounded-2xl bg-amber-500/15 px-4 py-3 text-[15px]" role="status">
            {t("Cleared. Reloading…")}
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Btn type="button" disabled={busy} onClick={cancel}>
              {t("Cancel")}
            </Btn>
            <Btn type="submit" danger disabled={!ok || busy}>
              {busy ? t("Clearing…") : t("Clear data")}
            </Btn>
          </div>
        )}
      </form>
    </section>
  );
}
