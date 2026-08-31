/** The current principal resource: the only place the `/me` profile URL appears. */

import { defineQuery, type QueryEndpoint } from '../endpoints.js';
import { currentPrincipalSchema, type CurrentPrincipal } from '../schemas/index.js';

/** The caller's database-backed identity and tenant role. */
export const currentPrincipal = (): QueryEndpoint<CurrentPrincipal> =>
  defineQuery<CurrentPrincipal>({
    operation: 'principal.current',
    path: '/api/v1/me',
    schema: currentPrincipalSchema,
    cacheKey: ['me'],
  });
