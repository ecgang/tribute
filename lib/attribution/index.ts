/** Attribution backend dispatcher: returns relevance weights for the chosen backend. */
import type { BackendId, RagTrace } from "../schema";
import {
  cannedCausalWeights,
  citationWeights,
  retrievalWeights,
  semanticWeights,
  type WeightMap,
} from "./passive";

export function relevanceWeights(
  trace: RagTrace,
  backend: BackendId,
  override?: { causal?: WeightMap },
): WeightMap {
  switch (backend) {
    case "retrieval":
      return retrievalWeights(trace);
    case "citation":
      return citationWeights(trace);
    case "semantic":
      return semanticWeights(trace);
    case "causal":
      // Live mode injects measured leave-one-out deltas; otherwise use pre-baked.
      return override?.causal ?? cannedCausalWeights(trace);
  }
}

export * from "./passive";
