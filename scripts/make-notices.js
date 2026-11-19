'use strict';
// Writes THIRD-PARTY-NOTICES.md from the license files of the packages bundled into lib/vendor.js.
const fs = require('fs');
const path = require('path');
const nm = path.join(__dirname, 'vendor', 'node_modules');
const PKGS = ['@mcap/core', '@foxglove/rosbag', '@foxglove/rosmsg', '@foxglove/rosmsg-serialization', '@foxglove/rosmsg2-serialization', '@foxglove/ros2idl-parser', '@foxglove/omgidl-parser', '@foxglove/message-definition', '@foxglove/cdr', '@foxglove/crc', '@foxglove/rostime', 'fzstd', 'lz4js', 'seek-bzip', 'protobufjs', 'long', 'heap', 'heap-js', 'md5-typescript', 'tslib'];
const ISC_LZ4JS = `ISC License\n\nCopyright (c) John Chadwick\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;
const out = ['# Third-party notices', '',
  'lib/vendor.js bundles the packages below (built by scripts/build-vendor.js with esbuild). All of them have permissive licenses. Two mechanical changes are made while bundling: seek-bzip\'s deprecated `new Buffer(x)` calls become `Buffer.alloc` or `Buffer.from`, and the protobufjs file loader (src/util/fetch.js, used only to load .proto files) is replaced by a stub that throws, because the extension builds protobuf types from the descriptors inside the recording. Nothing else is changed.', '',
  '| Package | Version | License |', '|---|---|---|'];
const texts = [];
for (const p of PKGS) {
  const dir = path.join(nm, p);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  out.push(`| ${p} | ${j.version} | ${j.license} |`);
  const f = fs.readdirSync(dir).find((x) => /^licen[cs]e(\.(md|txt))?$/i.test(x));
  texts.push(`## ${p} ${j.version}\n\n\`\`\`\n${(f ? fs.readFileSync(path.join(dir, f), 'utf8') : p === 'lz4js' ? ISC_LZ4JS : '').trim()}\n\`\`\``);
}
out.push('', ...texts.flatMap((t) => [t, '']));
fs.writeFileSync(path.join(__dirname, '..', 'THIRD-PARTY-NOTICES.md'), out.join('\n'));
console.log('wrote THIRD-PARTY-NOTICES.md');
