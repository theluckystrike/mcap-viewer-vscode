# Changelog

## 0.1.0

- First release. Opens MCAP files (.mcap) and ROS 1 bags (.bag, format 2.0) with uncompressed, LZ4, zstd or bz2 chunks.
- Recording facts, a topic table with types, counts and rates, schemas, metadata and attachments.
- Messages decoded from the schemas in the file: ROS 1, ROS 2 CDR (ros2msg and ros2idl), JSON and protobuf.
- A time slider, pages of 50 messages and a plot of one number field over the recording.
- Zovo Pro tools: Export a topic to CSV or JSON, Trim to a new MCAP file, Compare two recordings (1 free try each).
