// One wire-contract version for both the browser and the Worker. Keeping the
// number in a tiny dependency-free module makes staggered deployments safe
// without relying on two hand-edited constants or a source-code regex test.
export const FORECAST_PAYLOAD_VERSION = 7;
