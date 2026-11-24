# fctb-api

REST API for the **Food Composition Table for Bangladesh (FCTB)**, built with **Hono** on **Cloudflare Workers** and **Cloudflare D1** with edge caching.

**Live Base URL:** https://fctb-api.elius.workers.dev

## Features

- **381 Bangladeshi foods** across **15 categories**, **6 cooking methods**, and **19 nutrient retention factor rules**
- **Bilingual search** across English, transliterated Bangla, Bangla script, scientific names, and FCTB codes
- **Nutrition calculation** scaled by weight (`grams`) with automatic cooking retention factor adjustments for raw foods
- **Meal calculation** for combining multiple food items into total nutrient intake
- **Edge caching** on `GET` endpoints (`Cache-Control: public, max-age=86400, s-maxage=86400` + Cloudflare Cache API)
- **CORS enabled** for direct use from web and mobile apps

## API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | API overview & endpoint directory |
| `GET` | `/api/health` | D1 database health check & row counts (uncached) |
| `GET` | `/api/stats` | Dataset summary & per-category food counts |
| `GET` | `/api/foods?q=rice&category=01&is_cooked=0&limit=50&offset=0` | Search & filter foods (`max limit = 500`) |
| `GET` | `/api/foods/:code` | Get food by FCTB code (e.g. `01_0001`) or numeric ID |
| `GET` | `/api/foods/:code/nutrition?grams=150&cooking_method=Boiled` | Calculate scaled nutrition for a food |
| `GET` | `/api/foods/:code/retention-factor?cooking_method=Boiled` | Look up retention factor for a food & cooking method |
| `GET` | `/api/categories` | List all 15 categories with food counts |
| `GET` | `/api/categories/:idOrCode?limit=50&offset=0` | Get category details & paginated foods |
| `GET` | `/api/cooking-methods` | List all 6 cooking methods |
| `GET` | `/api/retention-factors` | List all 19 nutrient retention factor rules |
| `GET` | `/api/retention-factors/lookup?food_code=01_0001&cooking_method=Boiled` | Look up retention factor by `food_code` & `cooking_method` |
| `GET` | `/api/calculate?food_code=01_0001&grams=150&cooking_method=Boiled` | Calculate nutrition via query params |
| `POST` | `/api/calculate` | Calculate nutrition via JSON body |
| `POST` | `/api/calculate/meal` | Calculate combined nutrition for multiple items |

## Examples

### Search foods (English or Bangla)
```bash
curl "https://fctb-api.elius.workers.dev/api/foods?q=rice"
curl "https://fctb-api.elius.workers.dev/api/foods?limit=500"
```

### Calculate single food nutrition
```bash
curl -X POST "https://fctb-api.elius.workers.dev/api/calculate" \
  -H "Content-Type: application/json" \
  -d '{"food_code":"01_0001","grams":150,"cooking_method":"Boiled"}'
```

### Calculate meal nutrition
```bash
curl -X POST "https://fctb-api.elius.workers.dev/api/calculate/meal" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      { "food_code": "01_0001", "grams": 100, "cooking_method": "Boiled" },
      { "food_code": "01_0002", "grams": 150 }
    ]
  }'
```

## Local Development & Deployment

```bash
# Install dependencies
npm install

# Seed local D1 database
npx wrangler d1 execute fctb-db --local --file=./seed.sql

# Run locally
npm run dev

# Seed remote D1 database
npx wrangler d1 execute fctb-db --remote --file=./seed.sql

# Generate Cloudflare Worker types & deploy
npm run cf-typegen
npm run deploy
```

## Related Package

- **[fctb-bd](https://github.com/MD-ELIUS/fctb-bd)** — Zero-dependency npm/JSR package with offline JSON, CSV, and SQLite dataset.

## Attribution

Data sourced from the **Food Composition Table for Bangladesh (FCTB)**, published by the **Institute of Nutrition and Food Science (INFS), University of Dhaka**, in collaboration with **FAO/INFOODS**.

## License

MIT
