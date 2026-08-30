/**
 * The container-views resource: the only place the views URL appears.
 *
 * One read, summary-shaped (see the schema). Pairs with the item-query resource: this says which
 * views a container offers and which can render, and `itemQuery` runs one of them.
 */

import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  containerViewConfigurationsSchema,
  containerViewsSchema,
  type ContainerViewConfigurations,
  type ContainerViews,
} from '../schemas/index.js';
import type {
  AppendViewSetupRequestContract,
  ReplaceViewSetupRequestContract,
  SetViewsRequestContract,
} from '../contracts.js';
import { structuredItemSchema, type StructuredItem } from './items.js';

/** The views a container offers, which cannot currently render, and which one opens. */
export const containerViews = (itemId: string): QueryEndpoint<ContainerViews> =>
  defineQuery<ContainerViews>({
    operation: 'views.get',
    path: `/api/v1/items/${itemId}/views`,
    schema: containerViewsSchema,
    cacheKey: ['items', itemId, 'views'],
  });

/** Reads the view fields required by view-backed write operations. */
export const containerViewConfigurations = (
  itemId: string,
): QueryEndpoint<ContainerViewConfigurations> =>
  defineQuery<ContainerViewConfigurations>({
    operation: 'views.getConfigurations',
    path: `/api/v1/items/${itemId}/views`,
    schema: containerViewConfigurationsSchema,
    cacheKey: ['items', itemId, 'view-configurations'],
  });

/**
 * Replaces a container's whole view set and returns the summary after the change.
 *
 * The body is the full closed view shape the contract defines; a caller authoring views owns getting
 * it right, and the server answers 422 where it does not. Setting the views changes what `query`
 * runs and what a container opens to, so it invalidates the item and its cached views.
 */
export const setContainerViews = (
  itemId: string,
  body: SetViewsRequestContract,
): CommandEndpoint<ContainerViews> =>
  defineCommand<ContainerViews>({
    operation: 'views.set',
    method: 'PUT',
    path: `/api/v1/items/${itemId}/views`,
    schema: containerViewsSchema,
    body,
    invalidates: [
      ['items', itemId, 'views'],
      ['items', itemId],
    ],
  });

/** Atomically appends a schema-and-view setup to an item. */
export const appendViewSetup = (
  itemId: string,
  body: AppendViewSetupRequestContract,
): CommandEndpoint<StructuredItem> =>
  defineCommand<StructuredItem>({
    operation: 'views.appendSetup',
    method: 'POST',
    path: `/api/v1/items/${itemId}/view-setups`,
    schema: structuredItemSchema,
    body,
    invalidates: [['items', itemId]],
  });

/** Atomically replaces one schema-and-view setup on an item. */
export const replaceViewSetup = (
  itemId: string,
  viewId: string,
  body: ReplaceViewSetupRequestContract,
): CommandEndpoint<StructuredItem> =>
  defineCommand<StructuredItem>({
    operation: 'views.replaceSetup',
    method: 'PUT',
    path: `/api/v1/items/${itemId}/view-setups/${encodeURIComponent(viewId)}`,
    schema: structuredItemSchema,
    body,
    invalidates: [['items', itemId]],
  });
