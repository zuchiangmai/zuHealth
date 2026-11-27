// The account fixture from the web code (protocol 0.2, 1, 3.5): what W derives, signs and seals from one fixed
// AMK, so crates/health-proto proves the same bytes (jws.json starts at the seed and skips the HKDF step).
// Run: bun scripts/gen-account-fixture.ts   (needs the pre-pol repo next to this one)

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const P = join(homedir(), "Documents/GitHub/pre-pol");
const W = join(P, "market/health/src/client");
const kit = await import(join(P, "packages/app-kit/src/health-account.ts"));
const { hpkeSeal } = await import(join(W, "lib/health/proto/hpke.ts"));
const { encodeIdentity } = await import(join(W, "lib/health/proto/qr.ts"));
const { x25519 } = await import(join(P, "node_modules/@noble/curves/ed25519.js"));

const fill = (n: number, b: number) => new Uint8Array(n).fill(b);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const enc = new TextEncoder();

const amk = fill(32, 0x11);
const a = kit.accountOf(amk);
const inboxPub = x25519.getPublicKey(a.inboxSecret);
const pk = kit.b64u(inboxPub);
// as lib/account.ts detach writes it: the body, then aud, at, jti
const payload = kit.requestPayload({ pk }, "api-dev-health.4seas.xyz", 1795176000000, fill(16, 0x22));
const jws = a.sign("health-key", payload);

const linkSk = fill(32, 0x33);
const linkPk = x25519.getPublicKey(linkSk);
const channel = kit.base32(fill(16, 0x44));
const plain = enc.encode(JSON.stringify({ v: 1, amk: kit.b64u(amk) }));
const sealed = await hpkeSeal(linkPk, plain, { info: enc.encode("health-link-1"), aad: enc.encode(channel), ephemeralSecret: fill(32, 0x55) });

const result = enc.encode(JSON.stringify({ v: 1, id: "0193a5c2-7e1f-7b3a-9c4d-2f6e8a1b5c90", uid: a.id }));
const sealedResult = await hpkeSeal(inboxPub, result, { info: enc.encode("sibian-health-1"), ephemeralSecret: fill(32, 0x66) });

const commit = execSync("git rev-parse --short HEAD", { cwd: P }).toString().trim();
const out = {
  about: `Made by scripts/gen-account-fixture.ts from the web code (pre-pol ${commit}); do not edit`,
  amk: hex(amk),
  id: a.id,
  sign_pub: kit.b64u(a.signPub),
  inbox_pub: pk,
  identity: encodeIdentity(a.id, inboxPub),
  request: { payload: JSON.stringify(payload), jws },
  link: {
    sk: hex(linkSk),
    channel,
    code: kit.linkCode(channel, linkPk),
    check: kit.linkCheck(channel, linkPk, a.id),
    plain: new TextDecoder().decode(plain),
    eph: hex(fill(32, 0x55)),
    sealed: kit.b64u(new Uint8Array([...sealed.enc, ...sealed.ct])),
  },
  result: { eph: hex(fill(32, 0x66)), plain: new TextDecoder().decode(result), sealed: kit.b64u(new Uint8Array([...sealedResult.enc, ...sealedResult.ct])) },
};
writeFileSync(new URL("../crates/health-proto/tests/fixtures/web-account.json", import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log("wrote web-account.json", a.id);
