'use strict';
// Builds lib/vendor.js from scripts/vendor/entry.js (npm run vendor installs scripts/vendor/package.json first).
// The bundle is CommonJS for the extension host (Node), minified, with the licenses kept as legal comments.
// One mechanical change while bundling: seek-bzip calls the deprecated `new Buffer(x)`, which makes Node print a
// DEP0005 warning; it is rewritten to Buffer.alloc (number) or Buffer.from (anything else). And protobufjs's file
// loader (src/util/fetch.js, used only by Root.load to read .proto files from disk or by XMLHttpRequest) is replaced by
// a stub that throws: the viewer builds types from the descriptors inside the recording and never loads files.
const fs = require('fs');
const path = require('path');
const esbuild = require('./vendor/node_modules/esbuild');
const root = path.join(__dirname, '..');
const noDeprecatedBuffer = {
  name: 'seek-bzip-buffer',
  setup(build) {
    build.onLoad({ filter: /seek-bzip[\\/]lib[\\/].*\.js$/ }, (a) => {
      const src = fs.readFileSync(a.path, 'utf8').replace(/new Buffer\(/g, '__zovoBuffer(');
      return { contents: `var __zovoBuffer = function (x) { return typeof x === 'number' ? Buffer.alloc(x) : Buffer.from(x); };\n${src}`, loader: 'js' };
    });
  },
};
const noProtoFetch = {
  name: 'no-protobuf-fetch',
  setup(build) {
    build.onLoad({ filter: /protobufjs[\\/]src[\\/]util[\\/]fetch\.js$/ }, () => ({ contents: "module.exports = function fetch() { throw new Error('Loading .proto files is not part of this build.'); };", loader: 'js' }));
  },
};
esbuild.build({
  entryPoints: [path.join(__dirname, 'vendor', 'entry.js')],
  outfile: path.join(root, 'lib', 'vendor.js'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node16', minify: true, legalComments: 'eof',
  banner: { js: '// lib/vendor.js: third-party code bundled by scripts/build-vendor.js. Licenses: THIRD-PARTY-NOTICES.md.' },
  plugins: [noDeprecatedBuffer, noProtoFetch],
  logLevel: 'warning',
}).then(() => console.log('wrote lib/vendor.js'), (e) => { console.error(e); process.exit(1); });
