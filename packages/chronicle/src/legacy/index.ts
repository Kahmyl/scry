/**
 * Compatibility surface for pre-rearchitecture Artifact behavior.
 *
 * New Scry code MUST NOT build against this surface.
 *
 * It contains the old Veil-coupled artifact admission and storage contract
 * only so existing consumers can continue compiling while they are migrated
 * deliberately.
 */
export * from "./artifact-storage/index.js";
