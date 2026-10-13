// Layout semântico (docs/funcionalidades/13-layout-semantico.md): decide onde as coisas ficam, nunca o que existe.
// Recebe o documento e o que entra (com a relação declarada) e devolve lugares; a reorganização devolve um plano.
export { placeNew, findFreeSpot, overlaps, GAP, regionAt, boundsOfRects, REGION_PADDING, type PlacementRequest } from "./placement.js";
export { placeArranged, type ArrangedPlacement } from "./arranged.js";
export { planRebalance, displacement, REBALANCE_THRESHOLD, type Move, type RebalanceOptions } from "./rebalance.js";
export { blockSize, BLOCK_WIDTH } from "./blockSize.js";
export { SPACING, annotations, arrangedOn, arrangementOf, flowIds, flowRoot, sectionIds, type FlowDoc } from "./flow.js";
