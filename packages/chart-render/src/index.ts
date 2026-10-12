/**
 * Chart views without React: the model, the geometry and an SVG renderer.
 *
 * The web app draws its JSX charts from the model and geometry here; a published site draws
 * the same charts as SVG strings with {@link renderChartSvg}. One source for both is what keeps a
 * figure on a site identical to the one in the app.
 */

export * from './model.js';
export * from './geometry.js';
export {
  escapeXml,
  renderChartSvg,
  type ChartLegendEntry,
  type ChartRenderOptions,
  type ChartTable,
  type RenderedChart,
} from './svg.js';
export type { ChartBucketInput, ChartCellInput, ChartInput, ChartSeriesInput } from './types.js';
