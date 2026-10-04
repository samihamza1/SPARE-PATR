import { searchQuerySchema } from '@autoparts/shared';
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import type { PlatformDeps } from '../../auth/plugin';
import { searchCatalog } from '../../catalog/search';
import { inTenant } from '../common';

/** Salesperson search (BRIEF scenario 1, ADR 0015). Any signed-in user may search. */
export function searchRoutes(app: FastifyInstance, deps: PlatformDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/catalog/search',
    { schema: { querystring: searchQuerySchema }, config: { access: 'authenticated' } },
    (request) =>
      inTenant(deps, request, async (trx) => {
        const { functional_currency } = await trx
          .selectFrom('tenants')
          .select('functional_currency')
          .executeTakeFirstOrThrow();
        return searchCatalog(trx, request.query, functional_currency, deps.now());
      }),
  );
}
