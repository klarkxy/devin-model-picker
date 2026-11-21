'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-model-picker-vsix-'));
const extension = path.join(stage, 'extension');
fs.mkdirSync(extension);
for (const name of ['package.json', 'src', 'media', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.cpSync(path.join(root, name), path.join(extension, name), { recursive: true });
fs.writeFileSync(path.join(stage, '[Content_Types].xml'), '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/><Default Extension="" ContentType="text/plain"/></Types>');
fs.writeFileSync(path.join(stage, 'extension.vsixmanifest'), `<?xml version="1.0"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}"/><DisplayName>${pkg.displayName}</DisplayName><Description xml:space="preserve">${pkg.description}</Description><Tags>byok,fusion,devin</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.100.0"/><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>`);
const output = path.join(root, pkg.name + '-' + pkg.version + '.vsix');
fs.rmSync(output, { force: true });

// Minimal ZIP (store method) so packaging needs no external tool; VSIX only
// requires a zip container. Uses the system zip when available.
function zipStore(outFile, cwd) {
  const entries = [];
  const walk = (rel, abs) => {
    for (const item of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? rel + '/' + item.name : item.name;
      const childAbs = path.join(abs, item.name);
      if (item.isDirectory()) walk(childRel, childAbs);
      else entries.push({ name: childRel, data: fs.readFileSync(childAbs) });
    }
  };
  walk('', cwd);
  const chunks = [];
  const dos = () => {
    const date = new Date();
    return ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  };
  const crcTable = (() => { const table = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; } return table; })();
  const crc32 = buffer => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0, 6);         // flags
    local.writeUInt16LE(0, 8);         // store
    local.writeUInt16LE(dos(), 10);    // time
    local.writeUInt16LE(dos(), 12);    // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, entry.data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(dos(), 12);
    dir.writeUInt16LE(dos(), 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(entry.data.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += local.length + nameBytes.length + entry.data.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const part of central) centralSize += part.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  fs.writeFileSync(outFile, Buffer.concat([...chunks, ...central, end]));
}

let zipped = false;
for (const candidate of ['/usr/bin/zip', 'zip']) {
  try { execFileSync(candidate, ['-qr', output, '.'], { cwd: stage }); zipped = true; break; } catch {}
}
if (!zipped) zipStore(output, stage);
fs.rmSync(stage, { recursive: true });
console.log(output);
