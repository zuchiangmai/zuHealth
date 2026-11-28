import { Dialog, DialogButton } from "konsta/react";
import { type ReactNode, useState } from "react";
import { type AppUpdate, type Batch, checkUpdate, isAndroid, isMobile, op, openUpdate, type Status } from "../api";
import { ago, shortDate } from "../format";
import { t } from "../i18n";
import { birthLabel, Callout, Choice, errText, Group, GroupIcon, Heading, Icon, Item, LangSelect, type Look, type Page, type Personal, Row, setLook, sexLabel, type SyncShown, useLook, useOp, type WhoopStatus } from "../ui";
import { SyncValue, useSyncLive } from "./account";

/** How the app looks: the platform's own (and the system's dark mode), or either look, light or dark, chosen to
 *  review it on this device. */
function LookSelect() {
  const value = useLook();
  const options: { key: Look; label: string }[] = [
    { key: "auto", label: t("Automatic") },
    { key: "ios-light", label: t("iOS style, light") },
    { key: "ios-dark", label: t("iOS style, dark") },
    { key: "material-light", label: t("Android style, light") },
    { key: "material-dark", label: t("Android style, dark") },
  ];
  return <Choice label={t("Appearance")} icon={<Icon k="look" />} color="#c2185b" value={value} options={options} onChange={setLook} />;
}

/** Asks GitHub for a newer app and, if there is one, opens its package to download and install. */
function UpdateRow() {
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<AppUpdate>();
  const [err, setErr] = useState<string>();
  const check = async () => {
    if (busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      setFound(await checkUpdate());
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const close = () => (setFound(undefined), setErr(undefined));
  return (
    <>
      <Row color="#43a047" icon={<Icon k="update" />} label={t("Check for updates")} value={busy ? t("Checking…") : undefined} onClick={() => void check()} />
      <Dialog
        opened={!!found || !!err}
        onBackdropClick={close}
        title={err ? t("Can't check for updates") : found?.newer ? t("PhysiMind {{version}} is available", { version: found.latest }) : t("PhysiMind is up to date")}
        content={
          <span className="whitespace-pre-line">
            {err ??
              (found?.newer
                ? `${t("You have {{version}}. The new version downloads in your browser; open it to install it.", { version: found.current })}${found.notes ? `\n\n${found.notes}` : ""}`
                : t("You have the latest version, {{version}}.", { version: found?.current ?? "" }))}
          </span>
        }
        buttons={
          found?.newer && found.url ? (
            <>
              <DialogButton onClick={close}>{t("Later")}</DialogButton>
              <DialogButton
                strong
                onClick={() => {
                  openUpdate(found.url!);
                  close();
                }}
              >
                {t("Download")}
              </DialogButton>
            </>
          ) : (
            <DialogButton onClick={close}>{t("OK")}</DialogButton>
          )
        }
      />
    </>
  );
}

/** More (narrow screens), as the web's 更多: one card per part (profile, data sources, backup and export, other
 *  devices, about), each row opening its section at the right place. */
export function More({ go, status }: { go: (p: Page, want?: string) => void; status?: Status }) {
  const reviews = status?.reviews ?? 0;
  // each row says how things stand, as Settings does, not what the section is for
  const [me] = useOp(() => op<Personal>("profile.get"), []);
  const [whoop] = useOp(() => op<WhoopStatus>("whoop.status"), []);
  const [batches] = useOp(() => op<Batch[]>("import.list"), []);
  const [sync] = useOp(() => op<SyncShown>("sync.state"), []);
  const lastOf = (connector: string) => {
    const at = Math.max(0, ...(batches ?? []).filter((b) => b.connector === connector).map((b) => b.at ?? 0));
    return at ? t("Last import {{when}}", { when: shortDate(at) }) : batches ? t("Not imported yet") : undefined;
  };
  const profile = [sexLabel(me?.sex), me?.birth ? birthLabel(me.birth) : undefined].filter(Boolean).join(" · ") || (me ? t("Not set") : undefined);
  const whoopText =
    whoop?.state === "connected"
      ? whoop.last_sync
        ? t("Synced {{when}}", { when: ago(whoop.last_sync) })
        : t("Connected")
      : whoop?.state === "reauth"
        ? t("Sign in again")
        : whoop
          ? t("Not connected")
          : undefined;
  const live = useSyncLive();
  const row = (color: string, icon: ReactNode, label: string, p: Page, want?: string, text?: string, value?: ReactNode) => (
    <Row key={label} color={color} icon={icon} label={label} sub={text} value={value} onClick={() => go(p, want)} />
  );
  return (
    <section className="mx-auto w-full max-w-3xl">
      <Heading space="mb-4">{t("More")}</Heading>
      {reviews > 0 && (
        <Callout icon={<Icon k="review" />} title={t("{{count}} imports are waiting for you to check.", { count: reviews })} text={t("Nothing counts until you confirm it.")} onClick={() => go("review")} />
      )}
      <Group>{row("#7c4dff", <Icon k="profile" />, t("Profile"), "profile", undefined, profile)}</Group>
      <Group title={t("Data sources")}>
        {row("#1e88e5", <Icon k="data" />, t("Manage data"), "data", "manage", status ? t("{{obs}} entries from {{count}} sources", { obs: status.observations.toLocaleString(), count: status.sources }) : undefined)}
        {row("#e53935", <GroupIcon k="cardio" />, "WHOOP", "data", "whoop", whoopText)}
        {row("#f4511e", <GroupIcon k="activity" />, t("Apple Health"), "data", "apple", lastOf("apple_health"))}
        {row("#00897b", <GroupIcon k="lab" />, t("Lab report"), "data", "report", lastOf("ocr"))}
        {row("#3949ab", <Icon k="inbox" />, t("Lab results"), "data", "results", t("Sent to you by labs and service desks"))}
        {row("#43a047", <GroupIcon k="infectious" />, t("Lab self-service"), "data", "lab", t("A code for a lab device"))}
      </Group>
      <Group title={t("Backup and export")}>
        {row("#fb8c00", <Icon k="backup" />, t("Save a backup"), "backup", "save", t("Encrypted with a password you choose"))}
        {row("#fb8c00", <Icon k="data" />, t("Restore a backup"), "backup", "restore", t("Merges; nothing is overwritten"))}
        {row("#6d4c41", <GroupIcon k="other" />, t("Export a table (CSV)"), "backup", "csv", t("Unencrypted, for spreadsheets and other tools"))}
      </Group>
      <Group title={t("Other devices")}>
        {row("#039be5", <Icon k="wifi" />, t("Local network sync"), "account", "sync", undefined, <SyncValue st={sync} live={live} />)}
        {row("#5e35b1", <Icon k="link" />, t("Connect another device"), "account", "connect")}
        {row("#3949ab", <Icon k="list" />, t("Connection history"), "account", "history")}
      </Group>
      {/* agent apps on this computer (a narrow desktop window) */}
      {!isMobile && <Group title={t("Sharing")}>{row("#546e7a", <Icon k="agents" />, t("Agent access"), "agents")}</Group>}
      <Group title={t("About")}>
        {row("#00897b", <Icon k="shield" />, t("Privacy"), "about", "privacy", isMobile ? t("Your data is stored encrypted on this device") : t("Your data is stored encrypted on this computer"))}
        {row("#757575", <Icon k="scale" />, t("Open-source licenses"), "about", "licenses")}
        <LookSelect />
        <LangSelect />
        <Item color="#9e9e9e" icon={<Icon k="about" />} title={t("Version")} after={status?.version ?? "–"} />
        {/* Android installs updates from GitHub by hand; an iPhone updates through the App Store */}
        {isAndroid && <UpdateRow />}
      </Group>
    </section>
  );
}
