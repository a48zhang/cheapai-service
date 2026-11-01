import { z } from 'zod';
import { modelViewSchema } from './models.js';

/** Exact effective rates: up to 8 base-price + 18 multiplier decimal places. */
const catalogPriceSchema = z
  .string()
  .max(82)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,26})?$/u);

export const catalogGroupsSchema = z.object({
  items: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })),
});
export type CatalogGroup = z.infer<typeof catalogGroupsSchema>['items'][number];

/** Prices already include the selected public group's multiplier. */
export const catalogModelSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    id: modelViewSchema.shape.publicModelId,
    prices: z.object({
      input: catalogPriceSchema,
      output: catalogPriceSchema,
      cacheRead: catalogPriceSchema.optional(),
    }),
  }),
  z.object({
    kind: z.literal('image'),
    id: z.string().min(1),
    name: z.string().min(1),
    price: catalogPriceSchema,
  }),
]);

export const catalogSchema = z.object({ items: z.array(catalogModelSchema) });
export type CatalogModel = z.infer<typeof catalogModelSchema>;
export type Catalog = z.infer<typeof catalogSchema>;

export function decodeCatalog(value: unknown): Catalog {
  return catalogSchema.parse(value);
}
