import {
  type Category,
  type CategoryRfMap,
  type CookingMethod,
  type Food,
  type FoodNutrients,
  NUTRIENT_RF_MAP,
  type RetentionFactor,
} from './types';

export interface ComputedNutrition {
  food: Food;
  grams: number;
  cooking_method: CookingMethod | null;
  retention_factor: RetentionFactor | 1;
  nutrients: FoodNutrients;
}

/**
 * Finds a food by its FCTB code (e.g. "01_0001") or numeric id.
 */
export async function findFoodByCodeOrId(
  db: D1Database,
  codeOrId: string
): Promise<Food | null> {
  const trimmed = codeOrId.trim();
  const isNumericId = /^\d+$/.test(trimmed);

  const query = isNumericId
    ? 'SELECT * FROM foods WHERE id = ? OR code = ? LIMIT 1'
    : 'SELECT * FROM foods WHERE code = ? LIMIT 1';

  const stmt = isNumericId
    ? db.prepare(query).bind(Number(trimmed), trimmed)
    : db.prepare(query).bind(trimmed);

  return (await stmt.first<Food>()) ?? null;
}

/**
 * Resolves a cooking method by numeric id, string code, English name, or Bangla name.
 */
export async function resolveCookingMethod(
  db: D1Database,
  input: string | number
): Promise<CookingMethod | null> {
  if (typeof input === 'number' || /^\d+$/.test(String(input).trim())) {
    const id = Number(input);
    return (
      (await db
        .prepare('SELECT * FROM cooking_methods WHERE id = ? LIMIT 1')
        .bind(id)
        .first<CookingMethod>()) ?? null
    );
  }

  const trimmed = String(input).trim();
  if (!trimmed) return null;

  return (
    (await db
      .prepare(
        `SELECT * FROM cooking_methods
         WHERE code = ? OR LOWER(name_en) = LOWER(?) OR name_bn = ?
         LIMIT 1`
      )
      .bind(trimmed, trimmed, trimmed)
      .first<CookingMethod>()) ?? null
  );
}

/**
 * Looks up the nutrient retention factor for a food item and cooking method.
 * Returns 1 if the food is already cooked (is_cooked === 1) or no mapping exists.
 */
export async function getRetentionFactorForFood(
  db: D1Database,
  food: Food,
  cookingMethodInput?: string | number | null
): Promise<{ cookingMethod: CookingMethod | null; retentionFactor: RetentionFactor | 1 }> {
  if (cookingMethodInput === undefined || cookingMethodInput === null || cookingMethodInput === '') {
    return { cookingMethod: null, retentionFactor: 1 };
  }

  const cookingMethod = await resolveCookingMethod(db, cookingMethodInput);
  if (!cookingMethod || food.is_cooked === 1) {
    return { cookingMethod, retentionFactor: 1 };
  }

  const category = await db
    .prepare('SELECT * FROM categories WHERE id = ? LIMIT 1')
    .bind(food.category_id)
    .first<Category>();

  if (!category) {
    return { cookingMethod, retentionFactor: 1 };
  }

  const mapping = await db
    .prepare(
      'SELECT * FROM category_rf_map WHERE category_code = ? AND cooking_method_id = ? LIMIT 1'
    )
    .bind(category.code, cookingMethod.id)
    .first<CategoryRfMap>();

  if (!mapping) {
    return { cookingMethod, retentionFactor: 1 };
  }

  const rf = await db
    .prepare('SELECT * FROM retention_factors WHERE id = ? LIMIT 1')
    .bind(mapping.rf_id)
    .first<RetentionFactor>();

  return { cookingMethod, retentionFactor: rf ?? 1 };
}

function roundNutrient(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Calculates nutrient values for a given food, weight in grams, and optional cooking method.
 */
export async function computeFoodNutrition(
  db: D1Database,
  food: Food,
  grams: number,
  cookingMethodInput?: string | number | null
): Promise<ComputedNutrition> {
  const { cookingMethod, retentionFactor } = await getRetentionFactorForFood(
    db,
    food,
    cookingMethodInput
  );

  const weightFactor = grams / 100;
  const nutrients = {} as FoodNutrients;

  for (const key of Object.keys(NUTRIENT_RF_MAP) as Array<keyof FoodNutrients>) {
    const baseValue = food[key];
    if (baseValue === null) {
      nutrients[key] = null;
      continue;
    }

    const rfKey = NUTRIENT_RF_MAP[key];
    const rfMultiplier =
      retentionFactor !== 1 && rfKey !== null
        ? (retentionFactor[rfKey] as number)
        : 1;

    nutrients[key] = roundNutrient(baseValue * weightFactor * rfMultiplier);
  }

  return {
    food,
    grams,
    cooking_method: cookingMethod,
    retention_factor: retentionFactor,
    nutrients,
  };
}

/**
 * Sums multiple FoodNutrients objects into a single total object.
 */
export function sumNutrients(items: FoodNutrients[]): FoodNutrients {
  const totals = {} as FoodNutrients;
  for (const key of Object.keys(NUTRIENT_RF_MAP) as Array<keyof FoodNutrients>) {
    let hasValue = false;
    let sum = 0;
    for (const item of items) {
      const val = item[key];
      if (val !== null) {
        hasValue = true;
        sum += val;
      }
    }
    totals[key] = hasValue ? roundNutrient(sum) : null;
  }
  return totals;
}
