import "./i18n";
import { KonstaProvider } from "konsta/react";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useAppearance } from "./ui";
import "./app.css";

// a phone: only the content scrolls (App's <main>); the page itself stays put, with no bounce of its own
const root = document.documentElement;
root.classList.add("max-wide:h-full", "max-wide:overflow-hidden", "max-wide:overscroll-none");
document.body.classList.add("max-wide:h-full", "max-wide:overflow-hidden", "max-wide:overscroll-none");

/** Konsta's look (iOS's or Material's) and dark mode, as More › Appearance has them (the platform's by default):
 *  Konsta reads `k-ios` / `k-material` and `.dark` on an ancestor. */
function Root() {
  const { theme, dark } = useAppearance();
  useEffect(() => {
    root.classList.toggle("k-ios", theme === "ios");
    root.classList.toggle("k-material", theme === "material");
    root.classList.toggle("dark", dark);
  }, [theme, dark]);
  return (
    <KonstaProvider theme={theme} dark={dark}>
      <App />
    </KonstaProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
