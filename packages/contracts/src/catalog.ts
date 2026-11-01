import { z } from 'zod';
import { modelViewSchema, sellPricesSchema } from './models.js';

/** Public base prices, before the caller's access-group multiplier. */
export const catalogModelSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    id: modelViewSchema.shape.publicModelId,
    prices: sellPricesSchema.pick({ input: true, output: true, cacheRead: true }),
  }),
  z.object({
    kind: z.literal('image'),
    id: z.string().min(1),
    name: z.string().min(1),
    price: sellPricesSchema.shape.input,
  }),
]);

export const catalogSchema = z.object({ items: z.array(catalogModelSchema) });
export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type Catalog = z.infer<typeof catalogSchema>;

export function decodeCatalog(value: unknown): Catalog {
  return catalogSchema.parse(value);
}
