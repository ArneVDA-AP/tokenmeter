#!/usr/bin/env node
// Tokenmeter native-messaging host.
//
// Registered with Firefox/Zen via a native manifest (see tokenmeter_host.json
// and integration/README.md). The forked Claude-Usage-Extension connects to it
// and posts usage snapshots; this host writes them atomically to
// %APPDATA%\Tokenmeter\web-usage.json, which Tokenmeter then reads.
//
// Native messaging framing (both directions): a 4-byte little-endian uint32
// length prefix followed by that many bytes of UTF-8 JSON.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSnapshot } = require('./transform');

function outputPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Tokenmeter', 'web-usage.json');
}

function writeSnapshot(snapshot) {
  const out = outputPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot));
  fs.renameSync(tmp, out); // atomic replace so readers never see a partial file
  return out;
}

function send(message) {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

// Accumulate stdin and parse length-prefixed messages.
let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const len = buffer.readUInt32LE(0);
    if (buffer.length < 4 + len) break;
    const body = buffer.slice(4, 4 + len);
    buffer = buffer.slice(4 + len);
    let msg;
    try { msg = JSON.parse(body.toString('utf8')); }
    catch (e) { send({ ok: false, error: 'bad json: ' + e.message }); continue; }
    try {
      const snapshot = buildSnapshot(msg);
      const written = writeSnapshot(snapshot);
      send({ ok: true, wrote: written, orgs: snapshot.orgs.length, conversations: snapshot.conversations.length });
    } catch (e) {
      send({ ok: false, error: String(e) });
    }
  }
});

process.stdin.on('end', () => process.exit(0));
