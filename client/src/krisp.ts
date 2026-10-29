// Krisp's package, behind one module of ours so its lazy chunk has a name
// (krisp-*.js) in every build that carries it. ./call imports this only
// when a call or voice wants Krisp. @livekit/krisp-noise-filter is
// LiveKit's, under LiveKit's terms of service (not MIT or Apache-2.0), and
// works only with LiveKit Cloud.
export { KrispNoiseFilter, isKrispNoiseFilterSupported } from "@livekit/krisp-noise-filter";
