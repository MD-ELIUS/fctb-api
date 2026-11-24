import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  computeFoodNutrition,
  findFoodByCodeOrId,
  getRetentionFactorForFood,
  sumNutrients,
} from './nutrition';
import type { Category, CookingMethod, Env, Food, RetentionFactor } from './types';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

const CACHE_CONTROL_VALUE = 'public, max-age=86400, s-maxage=86400';

/**
 * Edge caching middleware for read-only GET endpoints (excluding /api/health).
 * Uses Cloudflare's Cache API (caches.default) + Cache-Control headers to minimize D1 reads.
 */
app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' || c.req.path === '/api/health') {
    await next();
    return;
  }

  const cache = (caches as unknown as { default?: Cache }).default;
  const cacheKey = new Request(c.req.url, { method: 'GET' });

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const hitHeaders = new Headers(cached.headers);
      hitHeaders.set('X-Cache', 'HIT');
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers: hitHeaders,
      });
    }
  }

  await next();

  if (c.res.status === 200) {
    const headers = new Headers(c.res.headers);
    headers.set('Cache-Control', CACHE_CONTROL_VALUE);
    headers.set('X-Cache', 'MISS');

    const responseToServe = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });

    if (cache) {
      const responseToCache = responseToServe.clone();
      try {
        c.executionCtx.waitUntil(cache.put(cacheKey, responseToCache));
      } catch {
        await cache.put(cacheKey, responseToCache);
      }
    }

    c.res = responseToServe;
  }
});

function parsePagination(limitParam?: string, offsetParam?: string, defaultLimit = 50, maxLimit = 500) {
  const parsedLimit = limitParam !== undefined ? Number.parseInt(limitParam, 10) : defaultLimit;
  const parsedOffset = offsetParam !== undefined ? Number.parseInt(offsetParam, 10) : 0;

  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, maxLimit) : defaultLimit;
  const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
  return { limit, offset };
}

/**
 * GET / - API overview & endpoint directory
 */
app.get('/', (c) => {
  return c.json({
    name: 'FCTB-BD API',
    version: '1.0.0',
    description:
      'REST API for the Food Composition Table for Bangladesh (FCTB), powered by Cloudflare Workers & D1.',
    attribution:
      'Institute of Nutrition and Food Science (INFS), University of Dhaka & FAO/INFOODS.',
    endpoints: {
      health: 'GET /api/health',
      stats: 'GET /api/stats',
      foods: {
        list_or_search: 'GET /api/foods?q=rice&category=01&is_cooked=0&limit=50&offset=0',
        get_by_code_or_id: 'GET /api/foods/:code',
        nutrition: 'GET /api/foods/:code/nutrition?grams=150&cooking_method=Boiled',
        retention_factor: 'GET /api/foods/:code/retention-factor?cooking_method=Boiled',
      },
      categories: {
        list: 'GET /api/categories',
        get_by_id_or_code: 'GET /api/categories/:idOrCode?limit=50&offset=0',
      },
      cooking_methods: {
        list: 'GET /api/cooking-methods',
      },
      retention_factors: {
        list: 'GET /api/retention-factors',
        lookup: 'GET /api/retention-factors/lookup?food_code=01_0001&cooking_method=Boiled',
      },
      calculate: {
        single_get: 'GET /api/calculate?food_code=01_0001&grams=150&cooking_method=Boiled',
        single_post: 'POST /api/calculate { food_code, grams, cooking_method? }',
        meal_post: 'POST /api/calculate/meal { items: [{ food_code, grams, cooking_method? }] }',
      },
    },
  });
});

/**
 * GET /api/health - Database connectivity & table row counts
 */
app.get('/api/health', async (c) => {
  const db = c.env.fctb_db;
  const [foods, categories, cookingMethods, retentionFactors] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS count FROM foods').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM categories').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM cooking_methods').first<{ count: number }>(),
    db.prepare('SELECT COUNT(*) AS count FROM retention_factors').first<{ count: number }>(),
  ]);

  return c.json({
    status: 'ok',
    database: 'fctb-db',
    counts: {
      foods: foods?.count ?? 0,
      categories: categories?.count ?? 0,
      cooking_methods: cookingMethods?.count ?? 0,
      retention_factors: retentionFactors?.count ?? 0,
    },
  });
});

/**
 * GET /api/stats - Dataset summary statistics
 */
app.get('/api/stats', async (c) => {
  const db = c.env.fctb_db;
  const [summary, byCategory] = await Promise.all([
    db
      .prepare(
        `SELECT
           COUNT(*) AS total_foods,
           SUM(CASE WHEN is_cooked = 0 THEN 1 ELSE 0 END) AS raw_foods,
           SUM(CASE WHEN is_cooked = 1 THEN 1 ELSE 0 END) AS cooked_foods
         FROM foods`
      )
      .first<{ total_foods: number; raw_foods: number; cooked_foods: number }>(),
    db
      .prepare(
        `SELECT c.id, c.code, c.name, c.name_bn, COUNT(f.id) AS food_count
         FROM categories c
         LEFT JOIN foods f ON f.category_id = c.id
         GROUP BY c.id
         ORDER BY c.id ASC`
      )
      .all(),
  ]);

  return c.json({
    summary,
    categories: byCategory.results,
  });
});

/**
 * GET /api/foods - Search & filter foods
 * Query params: q, category, is_cooked, limit, offset
 */
app.get('/api/foods', async (c) => {
  const db = c.env.fctb_db;
  const q = c.req.query('q')?.trim() ?? '';
  const categoryParam = c.req.query('category')?.trim();
  const isCookedParam = c.req.query('is_cooked')?.trim();
  const { limit, offset } = parsePagination(c.req.query('limit'), c.req.query('offset'));

  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (q) {
    const pattern = `%${q}%`;
    conditions.push(
      `(LOWER(f.foodname_en) LIKE LOWER(?)
        OR LOWER(COALESCE(f.foodname_bn, '')) LIKE LOWER(?)
        OR COALESCE(f.foodname_bangla, '') LIKE ?
        OR LOWER(COALESCE(f.scientific_name, '')) LIKE LOWER(?)
        OR LOWER(f.code) LIKE LOWER(?))`
    );
    bindings.push(pattern, pattern, pattern, pattern, pattern);
  }

  if (categoryParam) {
    if (/^\d+$/.test(categoryParam)) {
      conditions.push('(f.category_id = ? OR c.code = ?)');
      bindings.push(Number(categoryParam), categoryParam.padStart(2, '0'));
    } else {
      conditions.push('c.code = ?');
      bindings.push(categoryParam);
    }
  }

  if (isCookedParam === '0' || isCookedParam === '1') {
    conditions.push('f.is_cooked = ?');
    bindings.push(Number(isCookedParam));
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM foods f
       LEFT JOIN categories c ON f.category_id = c.id
       ${whereClause}`
    )
    .bind(...bindings)
    .first<{ total: number }>();

  const rows = await db
    .prepare(
      `SELECT f.*, c.code AS category_code, c.name AS category_name, c.name_bn AS category_name_bn
       FROM foods f
       LEFT JOIN categories c ON f.category_id = c.id
       ${whereClause}
       ORDER BY f.id ASC
       LIMIT ? OFFSET ?`
    )
    .bind(...bindings, limit, offset)
    .all();

  return c.json({
    data: rows.results,
    meta: {
      total: countRow?.total ?? 0,
      limit,
      offset,
      count: rows.results.length,
    },
  });
});

/**
 * GET /api/foods/:code - Get single food by FCTB code or numeric ID
 */
app.get('/api/foods/:code', async (c) => {
  const db = c.env.fctb_db;
  const food = await findFoodByCodeOrId(db, c.req.param('code'));
  if (!food) {
    return c.json({ error: { message: 'Food not found', status: 404 } }, 404);
  }

  const category = await db
    .prepare('SELECT * FROM categories WHERE id = ? LIMIT 1')
    .bind(food.category_id)
    .first<Category>();

  return c.json({
    data: {
      ...food,
      category: category ?? null,
    },
  });
});

/**
 * GET /api/foods/:code/retention-factor - Get retention factor for food + cooking_method
 */
app.get('/api/foods/:code/retention-factor', async (c) => {
  const db = c.env.fctb_db;
  const food = await findFoodByCodeOrId(db, c.req.param('code'));
  if (!food) {
    return c.json({ error: { message: 'Food not found', status: 404 } }, 404);
  }

  const cookingMethodParam = c.req.query('cooking_method');
  if (!cookingMethodParam) {
    return c.json(
      { error: { message: 'Query parameter "cooking_method" is required', status: 400 } },
      400
    );
  }

  const { cookingMethod, retentionFactor } = await getRetentionFactorForFood(
    db,
    food,
    cookingMethodParam
  );

  return c.json({
    data: {
      food_code: food.code,
      is_cooked: food.is_cooked === 1,
      cooking_method: cookingMethod,
      retention_factor: retentionFactor,
    },
  });
});

/**
 * GET /api/foods/:code/nutrition - Calculate nutrition for a food item
 */
app.get('/api/foods/:code/nutrition', async (c) => {
  const db = c.env.fctb_db;
  const food = await findFoodByCodeOrId(db, c.req.param('code'));
  if (!food) {
    return c.json({ error: { message: 'Food not found', status: 404 } }, 404);
  }

  const gramsParam = c.req.query('grams');
  const grams = gramsParam !== undefined ? Number(gramsParam) : 100;
  if (!Number.isFinite(grams) || grams <= 0) {
    return c.json(
      { error: { message: '"grams" must be a positive number', status: 400 } },
      400
    );
  }

  const cookingMethod = c.req.query('cooking_method');
  const result = await computeFoodNutrition(db, food, grams, cookingMethod);

  return c.json({ data: result });
});

/**
 * GET /api/categories - List all categories with food counts
 */
app.get('/api/categories', async (c) => {
  const db = c.env.fctb_db;
  const rows = await db
    .prepare(
      `SELECT c.*, COUNT(f.id) AS food_count
       FROM categories c
       LEFT JOIN foods f ON f.category_id = c.id
       GROUP BY c.id
       ORDER BY c.id ASC`
    )
    .all();

  return c.json({
    data: rows.results,
    meta: { count: rows.results.length },
  });
});

/**
 * GET /api/categories/:idOrCode - Get category details and its foods
 */
app.get('/api/categories/:idOrCode', async (c) => {
  const db = c.env.fctb_db;
  const param = c.req.param('idOrCode').trim();
  const { limit, offset } = parsePagination(c.req.query('limit'), c.req.query('offset'));

  const category = /^\d+$/.test(param)
    ? await db
        .prepare('SELECT * FROM categories WHERE id = ? OR code = ? LIMIT 1')
        .bind(Number(param), param.padStart(2, '0'))
        .first<Category>()
    : await db
        .prepare('SELECT * FROM categories WHERE code = ? LIMIT 1')
        .bind(param)
        .first<Category>();

  if (!category) {
    return c.json({ error: { message: 'Category not found', status: 404 } }, 404);
  }

  const [countRow, foods] = await Promise.all([
    db
      .prepare('SELECT COUNT(*) AS total FROM foods WHERE category_id = ?')
      .bind(category.id)
      .first<{ total: number }>(),
    db
      .prepare('SELECT * FROM foods WHERE category_id = ? ORDER BY id ASC LIMIT ? OFFSET ?')
      .bind(category.id, limit, offset)
      .all<Food>(),
  ]);

  return c.json({
    data: {
      category,
      foods: foods.results,
    },
    meta: {
      total: countRow?.total ?? 0,
      limit,
      offset,
      count: foods.results.length,
    },
  });
});

/**
 * GET /api/cooking-methods - List all cooking methods
 */
app.get('/api/cooking-methods', async (c) => {
  const db = c.env.fctb_db;
  const rows = await db
    .prepare('SELECT * FROM cooking_methods ORDER BY id ASC')
    .all<CookingMethod>();

  return c.json({
    data: rows.results,
    meta: { count: rows.results.length },
  });
});

/**
 * GET /api/retention-factors - List all retention factor rules
 */
app.get('/api/retention-factors', async (c) => {
  const db = c.env.fctb_db;
  const rows = await db
    .prepare('SELECT * FROM retention_factors ORDER BY id ASC')
    .all<RetentionFactor>();

  return c.json({
    data: rows.results,
    meta: { count: rows.results.length },
  });
});

/**
 * GET /api/retention-factors/lookup - Lookup retention factor by food_code and cooking_method
 */
app.get('/api/retention-factors/lookup', async (c) => {
  const db = c.env.fctb_db;
  const foodCode = c.req.query('food_code')?.trim();
  const cookingMethodParam = c.req.query('cooking_method')?.trim();

  if (!foodCode || !cookingMethodParam) {
    return c.json(
      {
        error: {
          message: 'Query parameters "food_code" and "cooking_method" are required',
          status: 400,
        },
      },
      400
    );
  }

  const food = await findFoodByCodeOrId(db, foodCode);
  if (!food) {
    return c.json({ error: { message: 'Food not found', status: 404 } }, 404);
  }

  const { cookingMethod, retentionFactor } = await getRetentionFactorForFood(
    db,
    food,
    cookingMethodParam
  );

  return c.json({
    data: {
      food_code: food.code,
      is_cooked: food.is_cooked === 1,
      cooking_method: cookingMethod,
      retention_factor: retentionFactor,
    },
  });
});

/**
 * GET /api/calculate - Calculate nutrition via query params
 */
app.get('/api/calculate', async (c) => {
  const db = c.env.fctb_db;
  const foodCode = c.req.query('food_code')?.trim() || c.req.query('code')?.trim();
  if (!foodCode) {
    return c.json(
      { error: { message: 'Query parameter "food_code" (or "code") is required', status: 400 } },
      400
    );
  }

  const gramsParam = c.req.query('grams');
  const grams = gramsParam !== undefined ? Number(gramsParam) : 100;
  if (!Number.isFinite(grams) || grams <= 0) {
    return c.json(
      { error: { message: '"grams" must be a positive number', status: 400 } },
      400
    );
  }

  const food = await findFoodByCodeOrId(db, foodCode);
  if (!food) {
    return c.json({ error: { message: 'Food not found', status: 404 } }, 404);
  }

  const cookingMethod = c.req.query('cooking_method');
  const result = await computeFoodNutrition(db, food, grams, cookingMethod);

  return c.json({ data: result });
});

/**
 * POST /api/calculate - Calculate nutrition for a single food item
 */
app.post('/api/calculate', async (c) => {
  const body = await c.req.json<{
    food_code?: string;
    code?: string;
    grams?: number;
    cooking_method?: string | number;
  }>().catch(() => null);

  if (!body) {
    return c.json({ error: { message: 'Invalid JSON request body', status: 400 } }, 400);
  }

  const foodCode = (body.food_code ?? body.code)?.trim();
  if (!foodCode) {
    return c.json({ error: { message: '"food_code" is required', status: 400 } }, 400);
  }

  const grams = body.grams ?? 100;
  if (typeof grams !== 'number' || !Number.isFinite(grams) || grams <= 0) {
    return c.json({ error: { message: '"grams" must be a positive number', status: 400 } }, 400);
  }

  const food = await findFoodByCodeOrId(c.env.fctb_db, foodCode);
  if (!food) {
    return c.json({ error: { message: 'Food not found', status: 404 } }, 404);
  }

  const result = await computeFoodNutrition(c.env.fctb_db, food, grams, body.cooking_method);
  return c.json({ data: result });
});

/**
 * POST /api/calculate/meal - Calculate combined nutrition for multiple food items
 */
app.post('/api/calculate/meal', async (c) => {
  const body = await c.req.json<{
    items?: Array<{
      food_code?: string;
      code?: string;
      grams?: number;
      cooking_method?: string | number;
    }>;
  }>().catch(() => null);

  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return c.json(
      { error: { message: '"items" must be a non-empty array', status: 400 } },
      400
    );
  }

  if (body.items.length > 50) {
    return c.json(
      { error: { message: 'Maximum 50 items allowed per meal calculation', status: 400 } },
      400
    );
  }

  const db = c.env.fctb_db;
  const computedItems = [];
  let totalGrams = 0;

  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    const foodCode = (item.food_code ?? item.code)?.trim();
    if (!foodCode) {
      return c.json(
        { error: { message: `Item at index ${i} is missing "food_code"`, status: 400 } },
        400
      );
    }

    const grams = item.grams ?? 100;
    if (typeof grams !== 'number' || !Number.isFinite(grams) || grams <= 0) {
      return c.json(
        { error: { message: `Item "${foodCode}" has invalid "grams"`, status: 400 } },
        400
      );
    }

    const food = await findFoodByCodeOrId(db, foodCode);
    if (!food) {
      return c.json(
        { error: { message: `Food "${foodCode}" not found`, status: 404 } },
        404
      );
    }

    const computed = await computeFoodNutrition(db, food, grams, item.cooking_method);
    computedItems.push(computed);
    totalGrams += grams;
  }

  const totals = sumNutrients(computedItems.map((i) => i.nutrients));

  return c.json({
    data: {
      item_count: computedItems.length,
      total_grams: Math.round(totalGrams * 10000) / 10000,
      totals,
      items: computedItems,
    },
  });
});

app.notFound((c) => {
  return c.json(
    {
      error: {
        message: `Route not found: ${c.req.method} ${c.req.path}`,
        status: 404,
      },
    },
    404
  );
});

app.onError((err, c) => {
  console.error('Unhandled API error:', err);
  return c.json(
    {
      error: {
        message: err.message || 'Internal Server Error',
        status: 500,
      },
    },
    500
  );
});

export default app;
