// streamReader.js — drain a Page.printToPDF ReturnAsStream handle.
//
// We ask printToPDF for a stream instead of one giant base64 blob over the
// debugger transport (large PDFs are more reliable chunked). IO.read yields
// base64 chunks until eof; we concatenate and decode once.

import { cmd } from "../engine/cdp.js";

/**
 * @param {{tabId:number, sessionId?:string}} target
 * @param {string} handle  stream handle from Page.printToPDF{transferMode:"ReturnAsStream"}
 * @returns {Promise<Uint8Array>}
 */
export async function readStreamToBytes(target, handle) {
  const chunks = [];
  let total = 0;
  // read in ~1MB slices
  for (;;) {
    const r = await cmd(target, "IO.read", { handle, size: 1 << 20 }, 30000);
    if (r && r.data) {
      const bytes = r.base64Encoded ? b64ToBytes(r.data) : strToBytes(r.data);
      chunks.push(bytes);
      total += bytes.length;
    }
    if (!r || r.eof) break;
  }
  try { await cmd(target, "IO.close", { handle }, 8000); } catch (e) {}

  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function strToBytes(s) {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
}
