// Every third-party component shipped in the desktop app, with its license, for the About › Open-source licenses
// page: the Rust crates of the core and the Tauri shell (normal dependencies, every target) and the npm packages the
// interface bundles. Writes gui/src/licenses.json. Run after changing dependencies:
//   bun scripts/gen-licenses.ts
// The hand-written part (main components with their copyright lines, models, data, LOINC notice) is in
// gui/src/screens/about.tsx.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
type Entry = { name: string; versions: string[]; license: string; url?: string };
const byName = new Map<string, Entry>();
const add = (name: string, version: string, license: string, url?: string) => {
  if (name.startsWith("health")) return; // this app itself (MIT, stated on the page)
  const e = byName.get(`c:${name}`) ?? { name, versions: [], license, url: url || undefined };
  if (!e.versions.includes(version)) e.versions.push(version);
  byName.set(`c:${name}`, e);
};

for (const manifest of ["Cargo.toml", "gui/src-tauri/Cargo.toml"]) {
  const out = execFileSync(
    "cargo",
    ["tree", "--manifest-path", join(root, manifest), "-e", "normal", "--target", "all", "--prefix", "none", "--format", "{p}|{l}|{r}"],
    { encoding: "utf8", maxBuffer: 64 << 20 },
  );
  for (const line of out.split("\n")) {
    const [p, l, r] = line.split("|");
    const m = /^(\S+) v(\S+)/.exec(p ?? "");
    if (m && l) add(m[1]!, m[2]!, l.trim(), r?.trim());
  }
}
const crates = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

// npm packages the interface ships (production dependencies, all depths)
const tree = JSON.parse(execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], { cwd: join(root, "gui"), encoding: "utf8" }));
const npm = new Map<string, Entry>();
const walk = (deps: Record<string, { version: string }> | undefined) => {
  for (const [name, d] of Object.entries(deps ?? {})) {
    if (name === "typescript") continue; // an optional peer of react-i18next, not bundled
    const pj = join(root, "gui/node_modules", name, "package.json");
    if (!existsSync(pj)) continue;
    const p = JSON.parse(readFileSync(pj, "utf8"));
    const repo = typeof p.repository === "string" ? p.repository : p.repository?.url;
    const url = (p.homepage || repo || "").replace(/^git\+/, "").replace(/\.git$/, "") || undefined;
    const e = npm.get(name) ?? { name, versions: [], license: String(p.license ?? "unknown"), url };
    if (!e.versions.includes(d.version)) e.versions.push(d.version);
    npm.set(name, e);
    walk((d as { dependencies?: Record<string, { version: string }> }).dependencies);
  }
};
walk(tree.dependencies);

// full texts, from the license files the dependencies ship (Apache-2.0 from a crate that carries it verbatim)
const registry = join(homedir(), ".cargo/registry/src");
const crateFile = (prefix: string, file: string) => {
  for (const idx of readdirSync(registry)) {
    const dir = readdirSync(join(registry, idx)).find((d) => d.startsWith(prefix));
    if (dir && existsSync(join(registry, idx, dir, file))) return readFileSync(join(registry, idx, dir, file), "utf8");
  }
  throw new Error(`no ${file} in ${prefix}*`);
};
const texts = {
  "Apache-2.0": crateFile("serde-1.", "LICENSE-APACHE"),
  "MIT": `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
  "ISC": `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
  "BSD-3-Clause": `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  "Zlib": `This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages arising from the use of this software.

Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.

2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.

3. This notice may not be removed or altered from any source distribution.`,
  "Unicode-3.0": crateFile("unicode-ident-", "LICENSE-UNICODE"),
};

const out = { generated: "bun scripts/gen-licenses.ts", crates, npm: [...npm.values()].sort((a, b) => a.name.localeCompare(b.name)), texts };
writeFileSync(join(root, "gui/src/licenses.json"), `${JSON.stringify(out, null, 1)}\n`);
console.log(`crates ${crates.length}, npm ${out.npm.length}, texts ${Object.keys(texts).length}`);
