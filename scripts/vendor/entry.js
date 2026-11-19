// Entry for lib/vendor.js (scripts/build-vendor.js bundles it with esbuild from scripts/vendor/node_modules). Only third-party code goes in the bundle;
// src/ stays plain files. Every package here has a permissive license (THIRD-PARTY-NOTICES.md).
'use strict';
const mcap = require('@mcap/core');
const { Bag } = require('@foxglove/rosbag');
const rosmsg = require('@foxglove/rosmsg');
const ros1 = require('@foxglove/rosmsg-serialization');
const ros2 = require('@foxglove/rosmsg2-serialization');
const { parseRos2idl } = require('@foxglove/ros2idl-parser');
const fzstd = require('fzstd');
const lz4js = require('lz4js');
const bzip = require('seek-bzip');
const protobuf = require('protobufjs');
const descriptor = require('protobufjs/ext/descriptor');

module.exports = {
  McapIndexedReader: mcap.McapIndexedReader,
  McapStreamReader: mcap.McapStreamReader,
  McapWriter: mcap.McapWriter,
  MCAP_MAGIC: mcap.MCAP_MAGIC,
  Bag,
  parseRosMsg: rosmsg.parse,
  Ros1Reader: ros1.MessageReader,
  Ros1Writer: ros1.MessageWriter,
  CdrReader: ros2.MessageReader,
  CdrWriter: ros2.MessageWriter,
  parseRos2idl,
  zstdDecompress: (buf) => fzstd.decompress(buf),
  lz4Decompress: (buf, size) => lz4js.decompress(buf, size),
  lz4Compress: (buf) => lz4js.compress(buf),
  bz2Decompress: (buf, size) => bzip.decode(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength), size),
  protobuf,
  FileDescriptorSet: descriptor.FileDescriptorSet,
};
