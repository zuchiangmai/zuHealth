import "./i18n";
import { App as KonstaApp } from "konsta/react";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useAppearance } from "./ui";
import "./app.css";

// a phone: only the content scrolls (App's <main>); the page itself stays put, with no bounce of its own
const root = document.documentElement;
root.classList.add("max-wide:h-full", "max-wide:overflow-hidden", "max-wide:overscroll-none");
document.body.classList.add("max-wide:h-full", "max-wide:overflow-hidden", "max-wide:overscroll-none");

/** Konsta's root, as Konsta has it: its App sets the look (iOS's or Material's, as More › Appearance has them,
 *  the platform's by default) and, with `safeAreas`, the safe areas its bars and sheets pad by (the notch, the
 *  Dynamic Island, the home indicator). Dark mode is `.dark` on an ancestor, which Konsta's App doesn't set. */
function Root() {
  const { theme, dark } = useAppearance();
  useEffect(() => void root.classList.toggle("dark", dark), [dark]);
  return (
    <KonstaApp theme={theme} dark={dark} safeAreas>
      <App />
    </KonstaApp>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
