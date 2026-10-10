// Jest environment for suites that run pdf-parse for real. pdfjs loads its
// worker with a dynamic import(), which Jest's module system cannot serve
// without --experimental-vm-modules; pdfjs first looks for a preloaded
// handler on globalThis.pdfjsWorker, so this environment requires the worker
// file in Node's own realm (outside Jest's registry) and hands it over.
const NodeEnvironment = require('jest-environment-node').default;
const { getPath } = require('pdf-parse/worker');
class PdfjsEnvironment extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    this.global.pdfjsWorker = require(getPath());
  }
}
module.exports = PdfjsEnvironment;
