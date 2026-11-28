import "./i18n";
import { App as KonstaApp } from "konsta/react";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ScannerOverlay } from "./scanner";
import { useAppearance } from "./ui";
import "./app.css";

// only the pages scroll (each its own Konsta Page, App.tsx's stack); the document itself stays put, with no bounce
const root = document.documentElement;
root.classList.add("h-full", "overflow-hidden", "overscroll-none");
document.body.classList.add("h-full", "overflow-hidden", "overscroll-none");

/** Konsta's root, as Konsta has it: its App sets the look (iOS's or Material's, as More › Appearance has them,
 *  the platform's by default) and, with `safeAreas`, the safe areas its bars and sheets pad by (the notch, the
 *  Dynamic Island, the home indicator). Dark mode is `.dark` on an ancestor, which Konsta's App doesn't set. */
function Root() {
  const { theme, dark } = useAppearance();
  useEffect(() => void root.classList.toggle("dark", dark), [dark]);
  return (
    <KonstaApp theme={theme} dark={dark} safeAreas>
      <App />
      {/* over the camera while scanning (it hides the app, so it lives outside it) */}
      <ScannerOverlay />
    </KonstaApp>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
