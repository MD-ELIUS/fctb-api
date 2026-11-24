export interface Env {
  fctb_db: D1Database;
}

export interface FoodNutrients {
  enerc_kcal: number | null;
  enerc_kj: number | null;
  water_g: number | null;
  prot_g: number | null;
  fatce_g: number | null;
  choavldf_g: number | null;
  fibtg_g: number | null;
  ash_g: number | null;
  ca_mg: number | null;
  fe_mg: number | null;
  mg_mg: number | null;
  p_mg: number | null;
  k_mg: number | null;
  na_mg: number | null;
  zn_mg: number | null;
  cu_mg: number | null;
  vita_rae_mcg: number | null;
  retol_mcg: number | null;
  cartbeq_mcg: number | null;
  carta_mcg: number | null;
  cartb_mcg: number | null;
  crypx_mcg: number | null;
  vitd_mcg: number | null;
  vite_mg: number | null;
  thia_mg: number | null;
  ribf_mg: number | null;
  niaeq_mg: number | null;
  nia_mg: number | null;
  niatrp_mg: number | null;
  vitb6a_mg: number | null;
  fol_mcg: number | null;
  ascl_mg: number | null;
}

export interface Food extends FoodNutrients {
  id: number;
  category_id: number;
  code: string;
  foodname_en: string;
  foodname_bn: string | null;
  foodname_bangla: string | null;
  scientific_name: string | null;
  source_biblio_id: string | null;
  edible: number | null;
  bracketed_cols: string | null;
  is_cooked: number;
}

export interface Category {
  id: number;
  code: string;
  name: string;
  name_bn: string | null;
}

export interface CookingMethod {
  id: number;
  code: string;
  name_en: string;
  name_bn: string;
}

export interface RetentionFactor {
  id: number;
  code: string;
  rule_key: string;
  label_en: string;
  vita_rae: number;
  vitd: number;
  vite: number;
  thia: number;
  ribf: number;
  niaeq: number;
  vitb6a: number;
  fol: number;
  ascl: number;
  ca: number;
  fe: number;
  mg: number;
  p: number;
  k: number;
  na: number;
  zn: number;
  cu: number;
}

export interface CategoryRfMap {
  category_code: string;
  cooking_method_id: number;
  rf_id: number;
}

export const NUTRIENT_RF_MAP: Record<keyof FoodNutrients, keyof RetentionFactor | null> = {
  enerc_kcal: null,
  enerc_kj: null,
  water_g: null,
  prot_g: null,
  fatce_g: null,
  choavldf_g: null,
  fibtg_g: null,
  ash_g: null,
  ca_mg: 'ca',
  fe_mg: 'fe',
  mg_mg: 'mg',
  p_mg: 'p',
  k_mg: 'k',
  na_mg: 'na',
  zn_mg: 'zn',
  cu_mg: 'cu',
  vita_rae_mcg: 'vita_rae',
  retol_mcg: 'vita_rae',
  cartbeq_mcg: 'vita_rae',
  carta_mcg: 'vita_rae',
  cartb_mcg: 'vita_rae',
  crypx_mcg: 'vita_rae',
  vitd_mcg: 'vitd',
  vite_mg: 'vite',
  thia_mg: 'thia',
  ribf_mg: 'ribf',
  niaeq_mg: 'niaeq',
  nia_mg: 'niaeq',
  niatrp_mg: 'niaeq',
  vitb6a_mg: 'vitb6a',
  fol_mcg: 'fol',
  ascl_mg: 'ascl',
};
