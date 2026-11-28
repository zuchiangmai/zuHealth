// The dashboard's scanner: one way to scan whatever code a person meets. A lab device's code opens its page; a new
// device's connection code leads to handing the account over, but only after saying so (a code stuck somewhere must
// not take the account in one tap); anything else is explained.
import { Dialog, DialogButton } from "konsta/react";
import { useState } from "react";
import { codeTarget, op, scanCode } from "../api";
import { t } from "../i18n";
import { go as nav } from "../router";
import { errText, Icon } from "../ui";
import { offerLinkCode } from "./account";

type Note = { title: string; text: string; again?: boolean; give?: string };

/** Opens the camera and goes where the code leads. `round`: a filled circle (beside the search field), else a bar
 *  button (the top bar's). */
export function ScanButton({ round }: { round?: boolean }) {
  const [note, setNote] = useState<Note>();
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    if (busy) return;
    setBusy(true);
    setNote(undefined);
    try {
      const text = await scanCode();
      if (!text) return;
      const c = codeTarget(text);
      if (c.kind === "device") return nav(`data/lab/${c.page}/${c.device}`);
      if (c.kind === "link") {
        const { account } = await op<{ account: unknown }>("account.show");
        if (!account) return setNote({ title: t("Can't connect a device"), text: t("There is no health account on this device yet.") });
        return setNote({
          title: t("Connect a new device?"),
          text: t("This code connects a new device of yours to your health account. Continue only if that device is in your hand now."),
          give: c.code,
        });
      }
      if (c.kind === "identity") return setNote({ title: t("This is an identity code"), text: t("Lab staff scan it to send you results."), again: true });
      setNote({ title: t("Not a PhysiMind code"), text: t("Scan the code on a lab device, or the connection code a new device of yours shows."), again: true });
    } catch (e) {
      setNote({ title: t("Can't scan"), text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        aria-label={t("Scan a code")}
        disabled={busy}
        onClick={() => void scan()}
        className={`grid shrink-0 select-none place-items-center text-primary transition-opacity active:opacity-60 ${round ? "h-11 w-11 rounded-full bg-white/80 shadow-sm dark:bg-white/10" : "h-11 w-11"}`}
      >
        <Icon k="scan" className="h-6 w-6" />
      </button>
      <Dialog
        opened={!!note}
        onBackdropClick={() => setNote(undefined)}
        title={note?.title}
        content={note?.text}
        buttons={
          note?.give ? (
            <>
              <DialogButton onClick={() => setNote(undefined)}>{t("Cancel")}</DialogButton>
              <DialogButton
                strong
                onClick={() => {
                  offerLinkCode(note.give!);
                  setNote(undefined);
                  nav("account/give");
                }}
              >
                {t("Continue")}
              </DialogButton>
            </>
          ) : (
            <>
              <DialogButton onClick={() => setNote(undefined)}>{t("OK")}</DialogButton>
              {note?.again && (
                <DialogButton strong onClick={() => void scan()}>
                  {t("Scan again")}
                </DialogButton>
              )}
            </>
          )
        }
      />
    </>
  );
}
