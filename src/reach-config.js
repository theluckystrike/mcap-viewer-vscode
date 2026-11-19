'use strict';
// REACH1: this listing's Pro tools for the viewer toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  prefix: 'mcapViewer',
  triesKey: 'mcapViewer.proTrial',
  slot: '#toolbar',
  tools: [
    { id: 'export', title: 'Export a topic to CSV or JSON', command: 'mcapViewer.exportTopic' },
    { id: 'trim', title: 'Trim to a new MCAP file', command: 'mcapViewer.trim' },
    { id: 'compare', title: 'Compare two recordings', command: 'mcapViewer.compare' },
  ],
};
