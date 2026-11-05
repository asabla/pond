-- Example: a small web shop. Its customer ids are the people of examples/social, so a
-- table copied from one context into the other can be joined with the other's data.
CREATE CATALOG IF NOT EXISTS shop;
CREATE SCHEMA IF NOT EXISTS shop.sales;

CREATE TABLE shop.sales.products AS
SELECT * FROM (VALUES
  (1, 'Rain jacket', 'Clothing', 129.0), (2, 'Wool socks', 'Clothing', 19.0),
  (3, 'Trail shoes', 'Footwear', 149.0), (4, 'Thermos', 'Gear', 35.0),
  (5, 'Head torch', 'Gear', 42.0), (6, 'Map case', 'Gear', 24.0),
  (7, 'Fleece', 'Clothing', 89.0), (8, 'Gaiters', 'Footwear', 39.0)
) AS p(product_id, name, category, price);

-- 1,200 orders over 2026 from 300 customers, deterministic so every run looks the same.
CREATE TABLE shop.sales.orders AS
SELECT
  i AS order_id,
  (i * 7) % 300 AS customer_id,
  1 + (i * 5) % 8 AS product_id,
  1 + (i % 3) AS quantity,
  DATE '2026-01-01' + INTERVAL ((i * 11) % 300) DAY AS ordered_at
FROM range(1, 1201) t(i);
