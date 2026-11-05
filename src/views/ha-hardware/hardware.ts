/**
 * The hardware data lives in src/state now, so wizard-state can reach it
 * without importing a view. Only device-selection-view still imports it from
 * here, because another open change edits the lines around that import. Once
 * that lands, point the import at ../../state/ha-hardware.js and delete this
 * file.
 */
export * from "../../state/ha-hardware.js";
